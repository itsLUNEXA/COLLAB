import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { PostgresSyncRepository } from '../storage/postgres-sync-repository.js';
import { SyncOpType, ConflictStatus, ContractType, ContractStatus } from '@collab/protocol';

function loadEnvDatabaseUrl(): string | undefined {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const envPath = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return undefined;
  const content = fs.readFileSync(envPath, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('DATABASE_URL=')) {
      let val = trimmed.slice('DATABASE_URL='.length).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      return val;
    }
  }
  return undefined;
}

const databaseUrl = loadEnvDatabaseUrl();
const describeCondition = databaseUrl ? describe : describe.skip;

describeCondition('Phase 7: Real PostgreSQL / Supabase Persistence Verification', () => {
  let client: pg.Client;
  const testProjectId = '77777777-7777-4777-8777-777777777777';
  const testTeamId = '00000000-0000-4000-8000-000000000001';
  const testDeviceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const testUserId = '00000000-0000-4000-8000-000000000002';

  beforeAll(async () => {
    if (!databaseUrl) return;

    const isLocalhost = databaseUrl.includes('localhost') || databaseUrl.includes('127.0.0.1');
    const ssl = isLocalhost ? false : { rejectUnauthorized: false };

    client = new pg.Client({
      connectionString: databaseUrl,
      ssl,
    });
    await client.connect();

    // Ensure team, user, and device exist for foreign key integrity
    await client.query(`
      INSERT INTO teams (id, name) VALUES ($1, 'Phase 7 Verification Team')
      ON CONFLICT (id) DO NOTHING;
    `, [testTeamId]);

    await client.query(`
      INSERT INTO users (id, email, name) VALUES ($1, 'phase7@collab.test', 'Phase 7 Verifier')
      ON CONFLICT (id) DO NOTHING;
    `, [testUserId]);

    await client.query(`
      INSERT INTO devices (id, user_id, device_name, device_token_hash)
      VALUES ($1, $2, 'Verifier Device 1', 'sha256-dummy-hash')
      ON CONFLICT (id) DO NOTHING;
    `, [testDeviceId, testUserId]);

    // Clean up test project if leftovers exist
    await client.query(`DELETE FROM projects WHERE id = $1`, [testProjectId]);

    // Seed test project
    await client.query(`
      INSERT INTO projects (
        id, team_id, name, default_branch, wip_branch, integrated_branch, current_seq_num
      ) VALUES ($1, $2, 'Phase 7 Verification Project', 'main', 'collab/wip', 'collab/integrated', 0);
    `, [testProjectId, testTeamId]);
  });

  afterAll(async () => {
    if (client) {
      try {
        await client.query(`DELETE FROM projects WHERE id = $1`, [testProjectId]);
      } catch {
        // Ignore cleanup error
      }
      await client.end();
    }
  });

  it('Verifies event persistence across simulated server restarts', async () => {
    // Server Instance 1
    const repo1 = new PostgresSyncRepository(client);

    const seq1 = await repo1.getNextSequenceNum(testProjectId);
    expect(seq1).toBe(1);

    await repo1.saveSyncEvent({
      project_id: testProjectId,
      device_id: testDeviceId,
      seq_num: seq1,
      client_op_id: '11111111-0000-0000-0000-000000000001',
      relative_path: 'src/main.ts',
      op_type: SyncOpType.FILE_CREATE,
      base_hash: null,
      target_hash: 'sha256-hash-target-v1',
      file_size_bytes: 120,
      is_binary: false,
      content_blob: 'export const app = 1;',
      blob_storage_url: null,
      created_at: new Date().toISOString(),
    });

    // Simulated Server Restart: Repo 1 instance discarded, Repo 2 instance instantiated
    const repo2 = new PostgresSyncRepository(client);

    const currentSeq = await repo2.getCurrentSequenceNum(testProjectId);
    expect(currentSeq).toBe(1);

    const seq2 = await repo2.getNextSequenceNum(testProjectId);
    expect(seq2).toBe(2);

    await repo2.saveSyncEvent({
      project_id: testProjectId,
      device_id: testDeviceId,
      seq_num: seq2,
      client_op_id: '11111111-0000-0000-0000-000000000002',
      relative_path: 'src/main.ts',
      op_type: SyncOpType.FILE_UPDATE,
      base_hash: 'sha256-hash-target-v1',
      target_hash: 'sha256-hash-target-v2',
      file_size_bytes: 150,
      is_binary: false,
      content_blob: 'export const app = 2;',
      blob_storage_url: null,
      created_at: new Date().toISOString(),
    });

    const events = await repo2.getEventsRange(testProjectId, 0, 10);
    expect(events).toHaveLength(2);
    expect(events[0].seq_num).toBe(1);
    expect(events[1].seq_num).toBe(2);
    expect(events[1].target_hash).toBe('sha256-hash-target-v2');
  });

  it('Verifies conflict creation and resolution persistence across server restart', async () => {
    const repo1 = new PostgresSyncRepository(client);

    const conflict = await repo1.createConflict({
      project_id: testProjectId,
      relative_path: 'src/config.ts',
      server_seq: 1,
      device_a_id: testDeviceId,
      device_b_id: testDeviceId,
      base_hash: 'hash-base',
      remote_hash: 'hash-remote',
      conflict_status: ConflictStatus.DETECTED,
      resolution_payload: null,
      resolved_at: null,
    });

    expect(conflict.id).toBeDefined();

    // Restart: query with repo2
    const repo2 = new PostgresSyncRepository(client);
    const activeConflicts = await repo2.listActiveConflicts(testProjectId);
    expect(activeConflicts.some((c) => c.id === conflict.id)).toBe(true);

    // Resolve conflict
    const resolved = await repo2.resolveConflict(
      conflict.id,
      ConflictStatus.RESOLVED_ACCEPT_REMOTE,
      { resolvedBy: 'verifier' }
    );
    expect(resolved?.conflict_status).toBe(ConflictStatus.RESOLVED_ACCEPT_REMOTE);

    // Verify resolved conflict is no longer in active conflicts list
    const activeAfterResolve = await repo2.listActiveConflicts(testProjectId);
    expect(activeAfterResolve.some((c) => c.id === conflict.id)).toBe(false);
  });

  it('Verifies contracts and stale consumer dependency marking persistence', async () => {
    const repo1 = new PostgresSyncRepository(client);

    const contractId = '33333333-3333-4333-8333-333333333333';
    await repo1.saveContract({
      id: contractId,
      project_id: testProjectId,
      contract_type: ContractType.OPENAPI_ENDPOINT,
      identifier: 'GET /api/v1/users',
      owner_module: 'user-service',
      current_version: 1,
      status: ContractStatus.ACTIVE,
      current_schema_hash: 'hash-v1',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    await repo1.saveModuleDependency({
      id: '44444444-4444-4444-8444-444444444444',
      project_id: testProjectId,
      consumer_module: 'frontend-profile',
      contract_id: contractId,
      last_verified_version: 1,
      is_stale: false,
      stale_reason: null,
      updated_at: new Date().toISOString(),
    });

    // Mark stale across server boundary
    const repo2 = new PostgresSyncRepository(client);
    const updatedCount = await repo2.markConsumersStale(
      testProjectId,
      contractId,
      'Contract schema changed to v2'
    );
    expect(updatedCount).toBeGreaterThanOrEqual(1);

    const deps = await repo2.getModuleDependencies(testProjectId, contractId);
    expect(deps[0].is_stale).toBe(true);
    expect(deps[0].stale_reason).toBe('Contract schema changed to v2');
  });

  it('Verifies tasks and project decisions persistence', async () => {
    const repo1 = new PostgresSyncRepository(client);

    const taskId = '55555555-5555-4555-8555-555555555555';
    await repo1.saveTask({
      id: taskId,
      project_id: testProjectId,
      title: 'Phase 7 Verification Task',
      description: 'Persistent Supabase storage test',
      assigned_to_user_id: testUserId,
      target_module: 'services/collab-server',
      status: 'IN_PROGRESS',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const decisionId = '66666666-6666-4666-8666-666666666666';
    await repo1.saveProjectDecision({
      id: decisionId,
      project_id: testProjectId,
      title: 'Adopt Supabase PostgreSQL',
      rationale: 'Managed cloud database with zero local memory footprint',
      tags: ['infrastructure', 'postgres', 'phase7'],
      decided_by_user_id: testUserId,
      created_at: new Date().toISOString(),
    });

    // Restart: check from repo2
    const repo2 = new PostgresSyncRepository(client);
    const tasks = await repo2.listTasks(testProjectId);
    expect(tasks.some((t) => t.id === taskId)).toBe(true);

    const decisions = await repo2.listProjectDecisions(testProjectId);
    expect(decisions.some((d) => d.id === decisionId)).toBe(true);
  });
});
