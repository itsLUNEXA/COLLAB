import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../../../../services/collab-server/src/app.js';
import { MemorySyncRepository } from '../../../../services/collab-server/src/storage/memory-sync-repository.js';
import { createSessionToken } from '../../../../services/collab-server/src/auth/token.js';
import { EchoFilter } from '../fs/echo-filter.js';
import { FileApplier } from '../fs/applier.js';
import { ConflictCoordinator } from '../conflict/coordinator.js';
import { LocalOutbox } from '../storage/outbox.js';
import { SyncClient } from '../sync/client.js';
import { WorkspaceWatcher } from '../fs/watcher.js';
import { CompanionConfig } from '../config.js';

describe('Bidirectional Saved-File Synchronization & Conflict Safety E2E', () => {
  let app: FastifyInstance;
  let serverPort: number;
  let serverRepo: MemorySyncRepository;

  let workspaceA: string; // Laptop 1 (User)
  let workspaceB: string; // Laptop 2 (Shivam)

  const jwtSecret = 'e2e-bidirectional-sync-secret-minimum-32-chars';
  const projectId = '77777777-7777-4777-8777-777777777777';
  const deviceAId = '11111111-aaaa-4aaa-8aaa-111111111111';
  const deviceBId = '22222222-bbbb-4bbb-8bbb-222222222222';
  const userAId = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
  const userBId = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

  let configA: CompanionConfig;
  let configB: CompanionConfig;

  let echoFilterA: EchoFilter;
  let echoFilterB: EchoFilter;

  let coordinatorA: ConflictCoordinator;
  let coordinatorB: ConflictCoordinator;

  let applierA: FileApplier;
  let applierB: FileApplier;

  let outboxA: LocalOutbox;
  let outboxB: LocalOutbox;

  let clientA: SyncClient;
  let clientB: SyncClient;

  let watcherA: WorkspaceWatcher;
  let watcherB: WorkspaceWatcher;

  beforeAll(async () => {
    // 1. Setup in-memory server
    serverRepo = new MemorySyncRepository();
    serverRepo.seedProject({
      id: projectId,
      team_id: 'team-dual-collab',
      name: 'Dual Laptop Collaboration Project',
      github_repo_owner: 'itsLUNEXA',
      github_repo_name: 'COLLAB',
      github_installation_id: null,
      default_branch: 'main',
      wip_branch: 'collab/wip',
      integrated_branch: 'collab/integrated',
      current_seq_num: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    app = buildApp({
      config: {
        PORT: 0,
        HOST: '127.0.0.1',
        NODE_ENV: 'test',
        MAX_PAYLOAD_BYTES: 5 * 1024 * 1024,
        RATE_LIMIT_MAX: 10000,
        JWT_SECRET: jwtSecret,
      },
      repository: serverRepo,
    });

    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    serverPort = typeof addr === 'object' && addr ? addr.port : 4000;

    // 2. Setup separate physical workspace folders for User (A) and Shivam (B)
    workspaceA = await fs.mkdtemp(path.join(os.tmpdir(), 'collab-dual-wsA-'));
    workspaceB = await fs.mkdtemp(path.join(os.tmpdir(), 'collab-dual-wsB-'));

    const tokenA = createSessionToken({ user_id: userAId, device_id: deviceAId, project_id: projectId }, jwtSecret);
    const tokenB = createSessionToken({ user_id: userBId, device_id: deviceBId, project_id: projectId }, jwtSecret);

    const serverUrl = `ws://127.0.0.1:${serverPort}/ws`;

    configA = {
      workspacePath: workspaceA,
      serverUrl,
      token: tokenA,
      projectId,
      deviceId: deviceAId,
      userId: userAId,
      debounceMs: 40,
      dataDirName: '.collab',
    };

    configB = {
      workspacePath: workspaceB,
      serverUrl,
      token: tokenB,
      projectId,
      deviceId: deviceBId,
      userId: userBId,
      debounceMs: 40,
      dataDirName: '.collab',
    };

    echoFilterA = new EchoFilter(5000);
    echoFilterB = new EchoFilter(5000);

    coordinatorA = new ConflictCoordinator(workspaceA, echoFilterA);
    coordinatorB = new ConflictCoordinator(workspaceB, echoFilterB);

    applierA = new FileApplier(workspaceA, echoFilterA, coordinatorA);
    applierB = new FileApplier(workspaceB, echoFilterB, coordinatorB);

    outboxA = new LocalOutbox(path.join(workspaceA, '.collab'));
    outboxB = new LocalOutbox(path.join(workspaceB, '.collab'));
    await outboxA.init();
    await outboxB.init();

    clientA = new SyncClient(configA, outboxA, applierA);
    clientB = new SyncClient(configB, outboxB, applierB);

    watcherA = new WorkspaceWatcher(workspaceA, echoFilterA, 40);
    watcherB = new WorkspaceWatcher(workspaceB, echoFilterB, 40);

    applierA.onRemoteFileApplied = (p, h) => watcherA.registerKnownHash(p, h);
    applierB.onRemoteFileApplied = (p, h) => watcherB.registerKnownHash(p, h);

    // Connect both clients
    await clientA.connect();
    await clientB.connect();

    // Start watchers piping directly to clients
    await watcherA.start(async (payload) => {
      await clientA.sendLocalChange(payload);
    });

    await watcherB.start(async (payload) => {
      await clientB.sendLocalChange(payload);
    });
  });

  afterAll(async () => {
    await watcherA.stop();
    await watcherB.stop();
    clientA.disconnect();
    clientB.disconnect();
    await app.close();
    await fs.rm(workspaceA, { recursive: true, force: true });
    await fs.rm(workspaceB, { recursive: true, force: true });
  });

  it('Test 1: Bidirectional Direction 1 (User Laptop A -> Shivam Laptop B) File Creation', async () => {
    const relativePath = 'src/components/Header.tsx';
    const content = 'export const Header = () => <header>COLLAB App</header>;';

    // User saves file on Laptop A
    const fullPathA = path.join(workspaceA, relativePath);
    await fs.mkdir(path.dirname(fullPathA), { recursive: true });
    await fs.writeFile(fullPathA, content, 'utf-8');

    // Verify it automatically arrives on Shivam's Laptop B without git pull
    const fullPathB = path.join(workspaceB, relativePath);
    let arrived = false;
    for (let i = 0; i < 30; i++) {
      try {
        const contentB = await fs.readFile(fullPathB, 'utf-8');
        if (contentB === content) {
          arrived = true;
          break;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }

    expect(arrived).toBe(true);
  });

  it('Test 2: Bidirectional Direction 2 (Shivam Laptop B -> User Laptop A) File Modification', async () => {
    const relativePath = 'src/components/Header.tsx';
    const updatedContent = 'export const Header = () => <header>COLLAB App (Updated by Shivam)</header>;';

    // Shivam edits and saves the file on Laptop B
    const fullPathB = path.join(workspaceB, relativePath);
    await fs.writeFile(fullPathB, updatedContent, 'utf-8');

    // Verify the change arrives on User's Laptop A
    const fullPathA = path.join(workspaceA, relativePath);
    let updatedOnA = false;
    for (let i = 0; i < 30; i++) {
      try {
        const contentA = await fs.readFile(fullPathA, 'utf-8');
        if (contentA === updatedContent) {
          updatedOnA = true;
          break;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }

    expect(updatedOnA).toBe(true);
  });

  it('Test 3: File Deletion propagates from Laptop A to Laptop B', async () => {
    const relativePath = 'src/temp-scratch.ts';
    const fullPathA = path.join(workspaceA, relativePath);
    const fullPathB = path.join(workspaceB, relativePath);

    // Create file first
    await fs.writeFile(fullPathA, 'console.log("temp");', 'utf-8');
    // Wait for it to arrive on B
    for (let i = 0; i < 30; i++) {
      try {
        await fs.access(fullPathB);
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }

    // Now delete on A
    await fs.unlink(fullPathA);

    // Verify file is deleted on B
    let deletedOnB = false;
    for (let i = 0; i < 30; i++) {
      try {
        await fs.access(fullPathB);
        await new Promise((r) => setTimeout(r, 100));
      } catch {
        deletedOnB = true;
        break;
      }
    }

    expect(deletedOnB).toBe(true);
  });

  it('Test 4: Sensitive files (.env, .git, node_modules) are strictly excluded and never synced', async () => {
    // Attempt to write .env on Laptop A
    const envPathA = path.join(workspaceA, '.env');
    await fs.writeFile(envPathA, 'SUPABASE_KEY=super-secret-key-1234', 'utf-8');

    // Attempt to write .git/config on Laptop A
    const gitConfigA = path.join(workspaceA, '.git', 'config');
    await fs.mkdir(path.dirname(gitConfigA), { recursive: true });
    await fs.writeFile(gitConfigA, '[core] repositoryformatversion = 0', 'utf-8');

    // Wait 400ms
    await new Promise((r) => setTimeout(r, 400));

    // Verify neither exists on Laptop B
    const envPathB = path.join(workspaceB, '.env');
    const gitConfigB = path.join(workspaceB, '.git', 'config');

    let envExistsOnB = true;
    try {
      await fs.access(envPathB);
    } catch {
      envExistsOnB = false;
    }

    let gitExistsOnB = true;
    try {
      await fs.access(gitConfigB);
    } catch {
      gitExistsOnB = false;
    }

    expect(envExistsOnB).toBe(false);
    expect(gitExistsOnB).toBe(false);
  });

  it('Test 5: Concurrent divergence preserves local file and isolates collision without data loss', async () => {
    const conflictFile = 'src/constants.ts';
    const initialContent = 'export const API_VERSION = "v1";\n';

    // Setup initial common file
    const pathA = path.join(workspaceA, conflictFile);
    const pathB = path.join(workspaceB, conflictFile);
    await fs.mkdir(path.dirname(pathA), { recursive: true });
    await fs.mkdir(path.dirname(pathB), { recursive: true });

    await fs.writeFile(pathA, initialContent, 'utf-8');

    // Wait for it to arrive on B
    for (let i = 0; i < 30; i++) {
      try {
        const c = await fs.readFile(pathB, 'utf-8');
        if (c === initialContent) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }

    // Now both edit the same file concurrently with conflicting changes:
    const changeA = 'export const API_VERSION = "v1-alpha-user";\n';
    const changeB = 'export const API_VERSION = "v1-beta-shivam";\n';

    // User A writes changeA
    await fs.writeFile(pathA, changeA, 'utf-8');
    // Shivam B writes changeB locally
    await fs.writeFile(pathB, changeB, 'utf-8');

    // Wait for events to exchange
    await new Promise((r) => setTimeout(r, 600));

    // Verify that neither developer had their work silently overwritten:
    const currentA = await fs.readFile(pathA, 'utf-8');
    const currentB = await fs.readFile(pathB, 'utf-8');

    expect(currentA).toBe(changeA);
    expect(currentB).toBe(changeB);

    // Verify that the remote collision was preserved in a shadow conflict file
    const entriesB = await fs.readdir(path.join(workspaceB, 'src'));
    const conflictShadow = entriesB.find((e) => e.includes('constants.ts.conflict.remote'));
    expect(conflictShadow).toBeDefined();

    const shadowContent = await fs.readFile(path.join(workspaceB, 'src', conflictShadow!), 'utf-8');
    expect(shadowContent).toBe(changeA);
  });
});
