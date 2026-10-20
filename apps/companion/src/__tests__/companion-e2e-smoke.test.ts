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
import { LocalOutbox } from '../storage/outbox.js';
import { SyncClient } from '../sync/client.js';
import { WorkspaceWatcher } from '../fs/watcher.js';
import { CompanionConfig } from '../config.js';
import { IncomingChangeHandlingPolicy } from '@collab/protocol';

describe('Phase 3 — End-to-End Integration Smoke Test', () => {
  let app: FastifyInstance;
  let serverPort: number;
  let serverRepo: MemorySyncRepository;

  let workspaceA: string;
  let workspaceB: string;

  const jwtSecret = 'e2e-smoke-test-secret-minimum-32-chars-long';
  const projectId = '33333333-3333-4333-8333-333333333333';
  const deviceAId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const deviceBId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const userAId = '11111111-1111-4111-8111-111111111111';
  const userBId = '22222222-2222-4222-8222-222222222222';

  let configA: CompanionConfig;
  let configB: CompanionConfig;

  let echoFilterA: EchoFilter;
  let echoFilterB: EchoFilter;

  let applierA: FileApplier;
  let applierB: FileApplier;

  let outboxA: LocalOutbox;
  let outboxB: LocalOutbox;

  let clientA: SyncClient;
  let clientB: SyncClient;

  let watcherA: WorkspaceWatcher;
  let watcherB: WorkspaceWatcher;

  beforeAll(async () => {
    // 1. Setup Server
    serverRepo = new MemorySyncRepository();
    serverRepo.seedProject({
      id: projectId,
      team_id: 'team-hackathon',
      name: 'Hackathon Shared Project',
      github_repo_owner: 'org',
      github_repo_name: 'hackathon-app',
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
        MAX_PAYLOAD_BYTES: 1024 * 1024,
        RATE_LIMIT_MAX: 10000,
        JWT_SECRET: jwtSecret,
      },
      repository: serverRepo,
    });

    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    serverPort = typeof addr === 'object' && addr ? addr.port : 4000;

    // 2. Setup separate physical workspace folders
    workspaceA = await fs.mkdtemp(path.join(os.tmpdir(), 'collab-smoke-wsA-'));
    workspaceB = await fs.mkdtemp(path.join(os.tmpdir(), 'collab-smoke-wsB-'));

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
      debounceMs: 50,
      dataDirName: '.collab',
    };

    configB = {
      workspacePath: workspaceB,
      serverUrl,
      token: tokenB,
      projectId,
      deviceId: deviceBId,
      userId: userBId,
      debounceMs: 50,
      dataDirName: '.collab',
    };

    echoFilterA = new EchoFilter(5000);
    echoFilterB = new EchoFilter(5000);

    applierA = new FileApplier(workspaceA, echoFilterA);
    applierB = new FileApplier(workspaceB, echoFilterB);

    outboxA = new LocalOutbox(path.join(workspaceA, '.collab'));
    outboxB = new LocalOutbox(path.join(workspaceB, '.collab'));
    await outboxA.init();
    await outboxB.init();

    clientA = new SyncClient(configA, outboxA, applierA);
    clientB = new SyncClient(configB, outboxB, applierB);

    watcherA = new WorkspaceWatcher(workspaceA, echoFilterA, 50);
    watcherB = new WorkspaceWatcher(workspaceB, echoFilterB, 50);
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

  it('Step 1: Connects both companion clients over WebSocket', async () => {
    await clientA.connect();
    await clientB.connect();

    expect(clientA.getIsConnected()).toBe(true);
    expect(clientB.getIsConnected()).toBe(true);
  });

  it('Steps 2, 3, 4: Watcher detects saved file on Machine A, transmits, and Machine B applies it', async () => {
    // Start watcher on Machine A with callback directly piped to clientA
    await watcherA.start(async (payload) => {
      await clientA.sendLocalChange(payload);
    });

    // Start watcher on Machine B as well
    let machineBWatcherFired = false;
    await watcherB.start(() => {
      machineBWatcherFired = true;
    });

    // Machine A saves backend/src/routes.ts
    const testContent = 'export function getRoutes() { return ["/auth", "/users"]; }';
    const filePathA = path.join(workspaceA, 'backend/src/routes.ts');
    await fs.mkdir(path.dirname(filePathA), { recursive: true });
    await fs.writeFile(filePathA, testContent, 'utf-8');

    // Wait for debounce + network broadcast + atomic write on B
    const expectedPathB = path.join(workspaceB, 'backend/src/routes.ts');

    let written = false;
    for (let i = 0; i < 30; i++) {
      try {
        const contentB = await fs.readFile(expectedPathB, 'utf-8');
        if (contentB === testContent) {
          written = true;
          break;
        }
      } catch {
        // Retry
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    expect(written).toBe(true);
    expect(machineBWatcherFired).toBe(false);
  });

  it('Step 5: Disconnect and reconnect client; verifies missed events catch-up', async () => {
    // Disconnect Client B
    clientB.disconnect();
    expect(clientB.getIsConnected()).toBe(false);

    // While B is offline, Machine A creates a new file: shared/config.ts
    const configContent = 'export const APP_NAME = "Hackathon App";';
    const filePathA = path.join(workspaceA, 'shared/config.ts');
    await fs.mkdir(path.dirname(filePathA), { recursive: true });
    await fs.writeFile(filePathA, configContent, 'utf-8');

    // Wait for A to transmit and server to persist
    await new Promise((r) => setTimeout(r, 200));

    // Client B reconnects
    await clientB.connect();
    expect(clientB.getIsConnected()).toBe(true);

    // Verify Client B received the missed file via catch-up
    const expectedPathB = path.join(workspaceB, 'shared/config.ts');
    let caughtUp = false;
    for (let i = 0; i < 30; i++) {
      try {
        const contentB = await fs.readFile(expectedPathB, 'utf-8');
        if (contentB === configContent) {
          caughtUp = true;
          break;
        }
      } catch {
        // Retry
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    expect(caughtUp).toBe(true);
  });

  it('Step 6: Active-file protection preserves local work (Safeguard 1)', async () => {
    const protectedFile = 'backend/src/routes.ts';
    const localDirtyWork = 'export function getRoutes() { return ["MY_LOCAL_UNSAVED_DRAFT"]; }';

    // 1. Machine B writes its own local draft and protects the file with an active lease
    const pathB = path.join(workspaceB, protectedFile);
    await fs.mkdir(path.dirname(pathB), { recursive: true });
    await fs.writeFile(pathB, localDirtyWork, 'utf-8');
    applierB.protectFile(protectedFile, IncomingChangeHandlingPolicy.ISOLATE_TO_SHADOW);

    // 2. Machine A modifies backend/src/routes.ts
    const remoteChange = 'export function getRoutes() { return ["OVERWRITING_REMOTE_ROUTE"]; }';
    const pathA = path.join(workspaceA, protectedFile);
    await fs.mkdir(path.dirname(pathA), { recursive: true });
    await fs.writeFile(pathA, remoteChange, 'utf-8');

    // 3. Wait for change to arrive at Machine B
    await new Promise((r) => setTimeout(r, 400));

    // 4. Verify local work on Machine B was NOT overwritten!
    const activeContentB = await fs.readFile(pathB, 'utf-8');
    expect(activeContentB).toBe(localDirtyWork);

    // 5. Verify incoming remote change was safely isolated to shadow file
    const entries = await fs.readdir(path.join(workspaceB, 'backend/src'));
    const shadowFile = entries.find((e) => e.startsWith('routes.ts.collab-remote-'));
    expect(shadowFile).toBeDefined();

    const shadowContent = await fs.readFile(path.join(workspaceB, 'backend/src', shadowFile!), 'utf-8');
    expect(shadowContent).toBe(remoteChange);
  });
});
