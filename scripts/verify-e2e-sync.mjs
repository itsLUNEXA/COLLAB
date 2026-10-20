/**
 * @file verify-e2e-sync.mjs
 * Comprehensive end-to-end live verification of Step 1 + Step 2:
 * Tests live startup, bidirectional synchronization, file operations,
 * binary integrity, deletions, reconnects, echo suppression,
 * exclusions, traversal rejection, conflict safety, and device isolation.
 */

import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { WebSocket } from 'ws';

import { EchoFilter } from '../apps/companion/dist/fs/echo-filter.js';
import { FileApplier } from '../apps/companion/dist/fs/applier.js';
import { ConflictCoordinator } from '../apps/companion/dist/conflict/coordinator.js';
import { LocalOutbox } from '../apps/companion/dist/storage/outbox.js';
import { SyncClient } from '../apps/companion/dist/sync/client.js';
import { WorkspaceWatcher } from '../apps/companion/dist/fs/watcher.js';

const SERVER_HTTP = 'http://127.0.0.1:4000';
const SERVER_WS = 'ws://127.0.0.1:4000/ws';

const BASE_TEST_DIR = 'E:\\collab-temp-sync-test';
const WORKSPACE_A = path.join(BASE_TEST_DIR, 'workspace-A');
const WORKSPACE_B = path.join(BASE_TEST_DIR, 'workspace-B');

// Helper for polling file assertions
async function waitForCondition(checkFn, timeoutMs = 4000, intervalMs = 50) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await checkFn();
      if (res) return res;
    } catch {}
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

async function run() {
  console.log('================================================================');
  console.log('   COLLAB - LIVE BIDIRECTIONAL SYNC E2E VERIFICATION SUITE');
  console.log('================================================================');
  console.log('Server HTTP:', SERVER_HTTP);
  console.log('Server WS:  ', SERVER_WS);
  console.log('Workspace A:', WORKSPACE_A);
  console.log('Workspace B:', WORKSPACE_B);
  console.log('----------------------------------------------------------------\n');

  // Step 1: Health check on live server
  const healthRes = await fetch(`${SERVER_HTTP}/health`);
  if (!healthRes.ok) {
    throw new Error(`Server health check failed with status ${healthRes.status}`);
  }
  const healthData = await healthRes.json();
  console.log('✓ Phase 2 Health Check OK:', healthData);

  // Clean setup directories
  await fs.rm(BASE_TEST_DIR, { recursive: true, force: true });
  await fs.mkdir(WORKSPACE_A, { recursive: true });
  await fs.mkdir(WORKSPACE_B, { recursive: true });

  // Get master dev token to provision project & devices
  const authRes = await fetch(`${SERVER_HTTP}/api/v1/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      deviceId: '123e4567-e89b-12d3-a456-426614174000',
      deviceSecret: '0000000000000000000000000000000000000000000000000000000000000000',
    }),
  });
  if (!authRes.ok) throw new Error(`Master token generation failed: ${authRes.status}`);
  const { token: masterToken } = await authRes.json();

  // Step 2: Create a fresh isolated project for this test run
  const projRes = await fetch(`${SERVER_HTTP}/api/v1/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${masterToken}` },
    body: JSON.stringify({
      name: `Live E2E Test Project ${Date.now()}`,
      githubRepoOwner: 'itsLUNEXA',
      githubRepoName: 'COLLAB',
      defaultBranch: 'main',
    }),
  });
  const projData = await projRes.json();
  const projectId = projData.project.id;
  console.log('✓ Project Created:', projectId, `(${projData.project.name})`);

  // Obtain token scoped to the newly created project
  const pTokenRes = await fetch(`${SERVER_HTTP}/api/v1/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      deviceId: '123e4567-e89b-12d3-a456-426614174000',
      deviceSecret: '0000000000000000000000000000000000000000000000000000000000000000',
      projectId,
    }),
  });
  const { token: projectToken } = await pTokenRes.json();

  // Step 3: Provision Device A (Laptop 1 - User)
  const devARes = await fetch(`${SERVER_HTTP}/api/v1/projects/${projectId}/devices`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${projectToken}` },
    body: JSON.stringify({
      deviceName: 'Laptop 1 (User)',
      workspacePath: WORKSPACE_A,
    }),
  });
  const devAData = await devARes.json();
  const deviceAId = devAData.device.id;
  const deviceASecret = devAData.deviceSecret;
  console.log('✓ Device A Provisioned:', deviceAId);

  // Step 4: Provision Device B (Laptop 2 - Shivam)
  const devBRes = await fetch(`${SERVER_HTTP}/api/v1/projects/${projectId}/devices`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${projectToken}` },
    body: JSON.stringify({
      deviceName: 'Laptop 2 (Shivam)',
      workspacePath: WORKSPACE_B,
    }),
  });
  const devBData = await devBRes.json();
  const deviceBId = devBData.device.id;
  const deviceBSecret = devBData.deviceSecret;
  console.log('✓ Device B Provisioned:', deviceBId);

  // Step 5: Issue device-scoped JWT tokens using their actual device secrets
  const tokenARes = await fetch(`${SERVER_HTTP}/api/v1/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId: deviceAId, deviceSecret: deviceASecret, projectId }),
  });
  const { token: tokenA } = await tokenARes.json();

  const tokenBRes = await fetch(`${SERVER_HTTP}/api/v1/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId: deviceBId, deviceSecret: deviceBSecret, projectId }),
  });
  const { token: tokenB } = await tokenBRes.json();
  console.log('✓ Device Tokens Generated for both machines');

  // Step 6: Setup Companion Agents on both workspaces
  const configA = {
    workspacePath: WORKSPACE_A,
    serverUrl: SERVER_WS,
    token: tokenA,
    projectId,
    deviceId: deviceAId,
    userId: devAData.device.user_id,
    debounceMs: 40,
    dataDirName: '.collab',
  };

  const configB = {
    workspacePath: WORKSPACE_B,
    serverUrl: SERVER_WS,
    token: tokenB,
    projectId,
    deviceId: deviceBId,
    userId: devBData.device.user_id,
    debounceMs: 40,
    dataDirName: '.collab',
  };

  const echoFilterA = new EchoFilter(5000);
  const echoFilterB = new EchoFilter(5000);

  const coordinatorA = new ConflictCoordinator(WORKSPACE_A, echoFilterA);
  const coordinatorB = new ConflictCoordinator(WORKSPACE_B, echoFilterB);

  const applierA = new FileApplier(WORKSPACE_A, echoFilterA, coordinatorA);
  const applierB = new FileApplier(WORKSPACE_B, echoFilterB, coordinatorB);

  const outboxA = new LocalOutbox(path.join(WORKSPACE_A, '.collab'));
  const outboxB = new LocalOutbox(path.join(WORKSPACE_B, '.collab'));
  await outboxA.init();
  await outboxB.init();

  const watcherA = new WorkspaceWatcher(WORKSPACE_A, echoFilterA, 40);
  const watcherB = new WorkspaceWatcher(WORKSPACE_B, echoFilterB, 40);

  applierA.onRemoteFileApplied = (p, h) => watcherA.registerKnownHash(p, h);
  applierB.onRemoteFileApplied = (p, h) => watcherB.registerKnownHash(p, h);

  const clientA = new SyncClient(configA, outboxA, applierA);
  const clientB = new SyncClient(configB, outboxB, applierB);

  await clientA.connect();
  await clientB.connect();

  let bWatcherEventsCount = 0;
  await watcherA.start(async (payload) => {
    await clientA.sendLocalChange(payload);
  });
  await watcherB.start(async (payload) => {
    bWatcherEventsCount++;
    await clientB.sendLocalChange(payload);
  });

  console.log('✓ Both Companion Agents Connected via WebSocket to Port 4000\n');

  // --------------------------------------------------------------------------
  // TEST 1: A -> B Create (source code file)
  // --------------------------------------------------------------------------
  console.log('--- TEST 1: A -> B File Create ---');
  const codeA = 'export const add = (a: number, b: number): number => a + b;\n';
  const file1 = 'src/math.ts';
  await fs.mkdir(path.dirname(path.join(WORKSPACE_A, file1)), { recursive: true });
  await fs.writeFile(path.join(WORKSPACE_A, file1), codeA, 'utf-8');

  const arrived1 = await waitForCondition(async () => {
    const content = await fs.readFile(path.join(WORKSPACE_B, file1), 'utf-8');
    return content === codeA;
  });
  if (!arrived1) throw new Error('Test 1 Failed: B did not receive exact content for math.ts');
  console.log('✓ Test 1 Passed: B received exact file contents byte-for-byte on disk');

  // --------------------------------------------------------------------------
  // TEST 2: A -> B Update (modify file)
  // --------------------------------------------------------------------------
  console.log('--- TEST 2: A -> B File Update ---');
  const codeAUpdated = codeA + 'export const multiply = (a: number, b: number): number => a * b;\n';
  await fs.writeFile(path.join(WORKSPACE_A, file1), codeAUpdated, 'utf-8');

  const arrived2 = await waitForCondition(async () => {
    const content = await fs.readFile(path.join(WORKSPACE_B, file1), 'utf-8');
    return content === codeAUpdated;
  });
  if (!arrived2) throw new Error('Test 2 Failed: B did not receive updated content for math.ts');
  console.log('✓ Test 2 Passed: B updated cleanly to matching version');

  // --------------------------------------------------------------------------
  // TEST 3: B -> A Create & Update (Reverse Direction)
  // --------------------------------------------------------------------------
  console.log('--- TEST 3: B -> A File Create & Update (Reverse Direction) ---');
  const codeB = 'export const format = (val: string): string => val.trim();\n';
  const file2 = 'src/utils.ts';
  await fs.mkdir(path.dirname(path.join(WORKSPACE_B, file2)), { recursive: true });
  await fs.writeFile(path.join(WORKSPACE_B, file2), codeB, 'utf-8');

  const arrived3a = await waitForCondition(async () => {
    const content = await fs.readFile(path.join(WORKSPACE_A, file2), 'utf-8');
    return content === codeB;
  });
  if (!arrived3a) throw new Error('Test 3a Failed: A did not receive utils.ts created by B');

  const codeBUpdated = codeB + 'export const uppercase = (val: string): string => val.toUpperCase();\n';
  await fs.writeFile(path.join(WORKSPACE_B, file2), codeBUpdated, 'utf-8');

  const arrived3b = await waitForCondition(async () => {
    const content = await fs.readFile(path.join(WORKSPACE_A, file2), 'utf-8');
    return content === codeBUpdated;
  });
  if (!arrived3b) throw new Error('Test 3b Failed: A did not receive updated utils.ts from B');
  console.log('✓ Test 3 Passed: B -> A file creation and modification verified on disk');

  // --------------------------------------------------------------------------
  // TEST 4: Nested Directories Auto-Creation
  // --------------------------------------------------------------------------
  console.log('--- TEST 4: Nested Directories ---');
  const nestedFile = 'deeply/nested/directory/structure/service.ts';
  const nestedCode = 'export class DeepService { public ping() { return "pong"; } }\n';
  await fs.mkdir(path.dirname(path.join(WORKSPACE_A, nestedFile)), { recursive: true });
  await fs.writeFile(path.join(WORKSPACE_A, nestedFile), nestedCode, 'utf-8');

  const arrived4 = await waitForCondition(async () => {
    const content = await fs.readFile(path.join(WORKSPACE_B, nestedFile), 'utf-8');
    return content === nestedCode;
  });
  if (!arrived4) throw new Error('Test 4 Failed: Nested directory structure was not recreated on B');
  console.log('✓ Test 4 Passed: Parent folders and file recreated on recipient workspace');

  // --------------------------------------------------------------------------
  // TEST 5: Binary File Transfer & Byte-for-Byte Hash Integrity
  // --------------------------------------------------------------------------
  console.log('--- TEST 5: Binary File Integrity ---');
  const binaryFile = 'assets/binary-sample.bin';
  // Create 512-byte buffer with all bytes from 0 to 255 repeated
  const binaryData = Buffer.alloc(512);
  for (let i = 0; i < 512; i++) binaryData[i] = i % 256;
  const binarySha256 = crypto.createHash('sha256').update(binaryData).digest('hex');

  await fs.mkdir(path.dirname(path.join(WORKSPACE_A, binaryFile)), { recursive: true });
  await fs.writeFile(path.join(WORKSPACE_A, binaryFile), binaryData);

  const arrived5 = await waitForCondition(async () => {
    const readBuffer = await fs.readFile(path.join(WORKSPACE_B, binaryFile));
    const receivedSha256 = crypto.createHash('sha256').update(readBuffer).digest('hex');
    return receivedSha256 === binarySha256 && Buffer.compare(binaryData, readBuffer) === 0;
  });
  if (!arrived5) throw new Error('Test 5 Failed: Binary data hash mismatch on recipient');
  console.log('✓ Test 5 Passed: Binary file transferred without corruption (SHA-256 match)');

  // --------------------------------------------------------------------------
  // TEST 6: File Deletion Propagation
  // --------------------------------------------------------------------------
  console.log('--- TEST 6: File Deletion Propagation ---');
  const delFile = 'src/temporary.ts';
  await fs.writeFile(path.join(WORKSPACE_A, delFile), 'export const temp = 123;\n', 'utf-8');
  await waitForCondition(async () => fsSync.existsSync(path.join(WORKSPACE_B, delFile)));

  await fs.unlink(path.join(WORKSPACE_A, delFile));
  const arrived6 = await waitForCondition(async () => !fsSync.existsSync(path.join(WORKSPACE_B, delFile)));
  if (!arrived6) throw new Error('Test 6 Failed: File deletion was not propagated to B');
  console.log('✓ Test 6 Passed: File deletion propagated and unlinked from recipient disk');

  // --------------------------------------------------------------------------
  // TEST 7: Disconnect, Offline Edit, Reconnect & Catch-Up
  // --------------------------------------------------------------------------
  console.log('--- TEST 7: Disconnect & Catch-Up Outbox Recovery ---');
  clientB.disconnect();
  console.log('  -> Disconnected Client B');

  const offlineFile = 'src/offline-message.ts';
  const offlineCode = 'export const OFFLINE_SYNC_TIMESTAMP = Date.now();\n';
  await fs.writeFile(path.join(WORKSPACE_A, offlineFile), offlineCode, 'utf-8');

  // Wait 300ms for A to transmit and server to sequence
  await new Promise((r) => setTimeout(r, 300));

  console.log('  -> Reconnecting Client B...');
  await clientB.connect();

  const arrived7 = await waitForCondition(async () => {
    const content = await fs.readFile(path.join(WORKSPACE_B, offlineFile), 'utf-8');
    return content === offlineCode;
  });
  if (!arrived7) throw new Error('Test 7 Failed: B did not catch up missed events after reconnection');
  console.log('✓ Test 7 Passed: Missed events reconciled and applied on reconnect');

  // --------------------------------------------------------------------------
  // TEST 8: Echo Suppression Filter
  // --------------------------------------------------------------------------
  console.log('--- TEST 8: Echo Suppression ---');
  const prevEvents = bWatcherEventsCount;
  // Write a new file on A
  const echoTestFile = 'src/echo-check.ts';
  await fs.writeFile(path.join(WORKSPACE_A, echoTestFile), 'export const echo = "none";\n', 'utf-8');
  await waitForCondition(async () => fsSync.existsSync(path.join(WORKSPACE_B, echoTestFile)));
  // Wait 300ms to verify B does not fire local change for this remote write
  await new Promise((r) => setTimeout(r, 300));
  const newEvents = bWatcherEventsCount - prevEvents;
  if (newEvents > 0) throw new Error(`Test 8 Failed: Echo filter allowed remote write to trigger local broadcast (${newEvents} events)`);
  console.log('✓ Test 8 Passed: Echo suppression filter prevented bounce-back loop');

  // --------------------------------------------------------------------------
  // TEST 9: Sensitive Files Exclusion (.env, .git, node_modules)
  // --------------------------------------------------------------------------
  console.log('--- TEST 9: Sensitive File Exclusions ---');
  await fs.writeFile(path.join(WORKSPACE_A, '.env'), 'SUPER_SECRET_TOKEN=xyz123\n', 'utf-8');
  await fs.mkdir(path.join(WORKSPACE_A, '.git'), { recursive: true });
  await fs.writeFile(path.join(WORKSPACE_A, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n', 'utf-8');
  await fs.mkdir(path.join(WORKSPACE_A, 'node_modules', 'foo'), { recursive: true });
  await fs.writeFile(path.join(WORKSPACE_A, 'node_modules', 'foo', 'index.js'), 'module.exports = {};\n', 'utf-8');

  await new Promise((r) => setTimeout(r, 400));
  const envExists = fsSync.existsSync(path.join(WORKSPACE_B, '.env'));
  const gitExists = fsSync.existsSync(path.join(WORKSPACE_B, '.git', 'config'));
  const nodeModulesExists = fsSync.existsSync(path.join(WORKSPACE_B, 'node_modules', 'foo', 'index.js'));

  if (envExists || gitExists || nodeModulesExists) {
    throw new Error('Test 9 Failed: Sensitive files were leaked across workspaces!');
  }
  console.log('✓ Test 9 Passed: .env, .git, node_modules strictly excluded from synchronization');

  // --------------------------------------------------------------------------
  // TEST 10: Path Traversal Rejection
  // --------------------------------------------------------------------------
  console.log('--- TEST 10: Path Traversal Security ---');
  let rejectedInbound = false;
  try {
    const maliciousPayload = {
      op_type: 'FILE_CREATE',
      relative_path: '../../outside.txt',
      base_hash: null,
      target_hash: crypto.createHash('sha256').update('pwned').digest('hex'),
      encoding: 'utf-8',
      content: 'pwned',
      file_size_bytes: 5,
      is_binary: false,
    };
    const res = await applierB.applyRemoteOperation(maliciousPayload, 999);
    if (!res.success) rejectedInbound = true;
  } catch (err) {
    rejectedInbound = true;
  }
  if (!rejectedInbound) throw new Error('Test 10 Failed: Path traversal was not rejected!');
  console.log('✓ Test 10 Passed: Directory traversal (../../) safely rejected and blocked');

  // --------------------------------------------------------------------------
  // TEST 11: Concurrent Editing Conflict Safety
  // --------------------------------------------------------------------------
  console.log('--- TEST 11: Concurrent Divergence & Conflict Safety ---');
  const conflictFile = 'src/conflict-target.ts';
  const commonBase = 'export const CONFIG_PARAM = "initial_v1";\n';
  await fs.writeFile(path.join(WORKSPACE_A, conflictFile), commonBase, 'utf-8');
  await waitForCondition(async () => fsSync.existsSync(path.join(WORKSPACE_B, conflictFile)));

  // Both edit simultaneously with incompatible edits
  const editA = 'export const CONFIG_PARAM = "edit_from_laptop_A";\n';
  const editB = 'export const CONFIG_PARAM = "edit_from_laptop_B";\n';
  await fs.writeFile(path.join(WORKSPACE_A, conflictFile), editA, 'utf-8');
  await fs.writeFile(path.join(WORKSPACE_B, conflictFile), editB, 'utf-8');

  // Wait for sync exchange and conflict detection
  const conflictDetected = await waitForCondition(async () => {
    try {
      const srcFilesB = await fs.readdir(path.join(WORKSPACE_B, 'src'));
      const srcFilesA = await fs.readdir(path.join(WORKSPACE_A, 'src'));
      const shadowB = srcFilesB.find((f) => f.includes('conflict-target.ts.conflict.remote'));
      const shadowA = srcFilesA.find((f) => f.includes('conflict-target.ts.conflict.remote'));
      return Boolean(shadowB || shadowA);
    } catch {
      return false;
    }
  }, 5000);

  if (!conflictDetected) {
    throw new Error('Test 11 Failed: Conflict shadow file was not produced within 5000ms!');
  }

  // Verify neither edit was destroyed:
  const diskA = await fs.readFile(path.join(WORKSPACE_A, conflictFile), 'utf-8');
  const diskB = await fs.readFile(path.join(WORKSPACE_B, conflictFile), 'utf-8');
  if (diskA !== editA) throw new Error('Test 11 Failed: Local edit on A was overwritten!');
  if (diskB !== editB) throw new Error('Test 11 Failed: Local edit on B was overwritten!');

  console.log('✓ Test 11 Passed: Both versions preserved untouched; collision isolated to shadow file');

  // --------------------------------------------------------------------------
  // TEST 12: Project and Device Isolation
  // --------------------------------------------------------------------------
  console.log('--- TEST 12: Cross-Project / Unauthorized Device Isolation ---');
  // Attempt unauthorized access using token from another project
  const otherProjectRes = await fetch(`${SERVER_HTTP}/api/v1/projects/11111111-1111-4111-8111-111111111111`, {
    headers: { Authorization: `Bearer ${tokenA}` },
  });
  if (otherProjectRes.status !== 403) {
    throw new Error(`Test 12 Failed: Expected 403 Forbidden for cross-project request, got ${otherProjectRes.status}`);
  }
  console.log('✓ Test 12 Passed: Cross-project access rejected with HTTP 403 Forbidden');

  // Cleanup
  await watcherA.stop();
  await watcherB.stop();
  clientA.disconnect();
  clientB.disconnect();
  await fs.rm(BASE_TEST_DIR, { recursive: true, force: true });

  console.log('\n================================================================');
  console.log('   ALL 12 E2E VERIFICATION TESTS PASSED SUCCESSFULLY!          ');
  console.log('================================================================');
}

run().catch((err) => {
  console.error('\n❌ E2E VERIFICATION FAILED:', err);
  process.exit(1);
});
