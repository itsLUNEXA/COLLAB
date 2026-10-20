import { describe, it, expect } from 'vitest';
import { PostgresSyncRepository, DatabaseClient } from '../storage/postgres-sync-repository.js';
import { DbSyncEvent, DbPublishingAuditRecord, DbModuleIntent } from '@collab/db';
import { SyncOpType } from '@collab/protocol';

describe('PostgreSQL Persistence Verification & Restart Simulation', () => {
  // In-memory simulation of a persistent PostgreSQL database engine
  class SimulatedPostgresEngine implements DatabaseClient {
    public tables = {
      projects: new Map<string, { id: string; current_seq_num: number }>(),
      sync_events: [] as DbSyncEvent[],
      publishing_audit_records: [] as DbPublishingAuditRecord[],
      module_intents: new Map<string, DbModuleIntent>(),
    };

    public simulateError: Error | null = null;

    async query<T = unknown>(text: string, params: unknown[] = []): Promise<{ rows: T[]; rowCount?: number | null }> {
      if (this.simulateError) {
        throw this.simulateError;
      }

      // 1. UPDATE projects SET current_seq_num = current_seq_num + 1
      if (text.includes('UPDATE projects SET current_seq_num')) {
        const projectId = params[0] as string;
        let proj = this.tables.projects.get(projectId);
        if (!proj) {
          proj = { id: projectId, current_seq_num: 0 };
          this.tables.projects.set(projectId, proj);
        }
        proj.current_seq_num += 1;
        return { rows: [{ current_seq_num: String(proj.current_seq_num) } as T], rowCount: 1 };
      }

      // 2. INSERT INTO sync_events
      if (text.includes('INSERT INTO sync_events')) {
        const saved: DbSyncEvent = {
          id: this.tables.sync_events.length + 1,
          project_id: params[0] as string,
          device_id: params[1] as string,
          seq_num: params[2] as number,
          client_op_id: params[3] as string,
          relative_path: params[4] as string,
          op_type: params[5] as SyncOpType,
          base_hash: params[6] as string | null,
          target_hash: params[7] as string,
          file_size_bytes: params[8] as number,
          is_binary: params[9] as boolean,
          content_blob: params[10] as string | null,
          blob_storage_url: params[11] as string | null,
          created_at: new Date().toISOString(),
        };
        this.tables.sync_events.push(saved);
        return { rows: [saved as T], rowCount: 1 };
      }

      // 3. SELECT * FROM sync_events
      if (text.includes('SELECT * FROM sync_events')) {
        const projectId = params[0] as string;
        const fromSeq = params[1] as number;
        const limit = params[2] as number;
        const results = this.tables.sync_events
          .filter((e) => e.project_id === projectId && e.seq_num > fromSeq)
          .slice(0, limit);
        return { rows: results as T[], rowCount: results.length };
      }

      // 4. SELECT current_seq_num FROM projects
      if (text.includes('SELECT current_seq_num FROM projects')) {
        const projectId = params[0] as string;
        const proj = this.tables.projects.get(projectId);
        return { rows: proj ? ([{ current_seq_num: String(proj.current_seq_num) }] as T[]) : [], rowCount: proj ? 1 : 0 };
      }

      // 5. INSERT INTO publishing_audit_records
      if (text.includes('INSERT INTO publishing_audit_records')) {
        const audit: DbPublishingAuditRecord = {
          id: `audit-${this.tables.publishing_audit_records.length + 1}`,
          project_id: params[0] as string,
          checkpoint_id: params[1] as string,
          target_branch: params[2] as string,
          base_sha: (params[3] as string) || null,
          commit_sha: (params[4] as string) || null,
          status: params[5] as 'SUCCESS' | 'FAILED' | 'RETRYING',
          attempt: params[6] as number,
          error_message: (params[7] as string) || null,
          created_at: new Date().toISOString(),
        };
        this.tables.publishing_audit_records.push(audit);
        return { rows: [audit as unknown as T], rowCount: 1 };
      }

      // 6. SELECT * FROM publishing_audit_records
      if (text.includes('SELECT * FROM publishing_audit_records')) {
        const projectId = params[0] as string;
        const checkpointId = params.length > 1 ? (params[1] as string) : undefined;
        const results = this.tables.publishing_audit_records.filter((r) => {
          if (r.project_id !== projectId) return false;
          if (checkpointId && r.checkpoint_id !== checkpointId) return false;
          return true;
        });
        return { rows: results as unknown as T[], rowCount: results.length };
      }

      // 7. INSERT INTO module_intents ... ON CONFLICT
      if (text.includes('INSERT INTO module_intents')) {
        const projectId = params[1] as string;
        const deviceId = params[2] as string;
        const moduleName = params[4] as string;
        const key = `${projectId}:${moduleName}:${deviceId}`;

        const intent: DbModuleIntent = {
          id: params[0] as string,
          project_id: projectId,
          device_id: deviceId,
          user_id: params[3] as string,
          module_name: moduleName,
          intent_description: params[5] as string,
          acquired_at: params[6] as string,
          expires_at: params[7] as string,
          created_at: new Date().toISOString(),
        };
        this.tables.module_intents.set(key, intent);
        return { rows: [intent as unknown as T], rowCount: 1 };
      }

      // 8. SELECT * FROM module_intents
      if (text.includes('SELECT * FROM module_intents')) {
        const projectId = params[0] as string;
        const now = new Date().toISOString();
        const results = Array.from(this.tables.module_intents.values()).filter(
          (i) => i.project_id === projectId && i.expires_at > now
        );
        return { rows: results as unknown as T[], rowCount: results.length };
      }

      return { rows: [], rowCount: 0 };
    }
  }

  it('Requirement 1 & 2: Verifies event sequence and catch-up persistence across repository/server restarts', async () => {
    const persistentDb = new SimulatedPostgresEngine();
    const projectId = '33333333-3333-4333-8333-333333333333';
    const deviceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

    // Server Instance 1 runs and saves event 1
    const repoInstance1 = new PostgresSyncRepository(persistentDb);
    const seq1 = await repoInstance1.getNextSequenceNum(projectId);
    expect(seq1).toBe(1);

    await repoInstance1.saveSyncEvent({
      project_id: projectId,
      device_id: deviceId,
      seq_num: seq1,
      client_op_id: 'op-1',
      relative_path: 'backend/src/auth.ts',
      op_type: SyncOpType.FILE_CREATE,
      base_hash: null,
      target_hash: 'hash-1'.padEnd(64, '0'),
      file_size_bytes: 100,
      is_binary: false,
      content_blob: 'content-1',
      blob_storage_url: null,
      created_at: new Date().toISOString(),
    });

    // --- SIMULATE SERVER RESTART ---
    // Server Instance 1 is destroyed.
    // Server Instance 2 boots up and initializes a brand new PostgresSyncRepository
    const repoInstance2 = new PostgresSyncRepository(persistentDb);

    // Verify current sequence persisted
    const currentSeqAfterRestart = await repoInstance2.getCurrentSequenceNum(projectId);
    expect(currentSeqAfterRestart).toBe(1);

    // Verify next sequence continues monotonically
    const seq2 = await repoInstance2.getNextSequenceNum(projectId);
    expect(seq2).toBe(2);

    await repoInstance2.saveSyncEvent({
      project_id: projectId,
      device_id: deviceId,
      seq_num: seq2,
      client_op_id: 'op-2',
      relative_path: 'frontend/src/Login.tsx',
      op_type: SyncOpType.FILE_CREATE,
      base_hash: null,
      target_hash: 'hash-2'.padEnd(64, '0'),
      file_size_bytes: 200,
      is_binary: false,
      content_blob: 'content-2',
      blob_storage_url: null,
      created_at: new Date().toISOString(),
    });

    // Requirement 4: Verify missed-event recovery across restart boundary
    const missedEvents = await repoInstance2.getEventsRange(projectId, 0, 10);
    expect(missedEvents).toHaveLength(2);
    expect(missedEvents[0].seq_num).toBe(1);
    expect(missedEvents[0].relative_path).toBe('backend/src/auth.ts');
    expect(missedEvents[1].seq_num).toBe(2);
    expect(missedEvents[1].relative_path).toBe('frontend/src/Login.tsx');
  });

  it('Phase 1 Requirement: Durable publishing audit records persist across server restarts and preserve attempts', async () => {
    const persistentDb = new SimulatedPostgresEngine();
    const projectId = '33333333-3333-4333-8333-333333333333';
    const checkpointId = 'checkpoint-1234';

    // Instance 1 records attempt 1 (failed) and attempt 2 (success)
    const repo1 = new PostgresSyncRepository(persistentDb);

    await repo1.savePublishingAuditRecord({
      project_id: projectId,
      checkpoint_id: checkpointId,
      target_branch: 'collab/wip',
      base_sha: 'base-sha-1',
      commit_sha: null,
      status: 'FAILED',
      attempt: 1,
      error_message: 'Transient connection timeout',
    });

    await repo1.savePublishingAuditRecord({
      project_id: projectId,
      checkpoint_id: checkpointId,
      target_branch: 'collab/wip',
      base_sha: 'base-sha-1',
      commit_sha: '713c41ae7d3f0f14f11dd9744446c3a21d60d0cb',
      status: 'SUCCESS',
      attempt: 2,
      error_message: null,
    });

    // --- SIMULATE SERVER RESTART ---
    const repo2 = new PostgresSyncRepository(persistentDb);

    // Retrieve audit records for checkpoint
    const records = await repo2.listPublishingAuditRecords(projectId, checkpointId);
    expect(records).toHaveLength(2);

    expect(records[0].attempt).toBe(1);
    expect(records[0].status).toBe('FAILED');
    expect(records[0].error_message).toBe('Transient connection timeout');

    expect(records[1].attempt).toBe(2);
    expect(records[1].status).toBe('SUCCESS');
    expect(records[1].commit_sha).toBe('713c41ae7d3f0f14f11dd9744446c3a21d60d0cb');

    // Verify error propagation when database query fails (no silent in-memory fallback)
    persistentDb.simulateError = new Error('Database connection failed');
    await expect(
      repo2.savePublishingAuditRecord({
        project_id: projectId,
        checkpoint_id: checkpointId,
        target_branch: 'collab/wip',
        base_sha: null,
        commit_sha: null,
        status: 'FAILED',
        attempt: 3,
        error_message: 'Some error',
      })
    ).rejects.toThrow('Database connection failed');
    persistentDb.simulateError = null;
  });

  it('Phase 2 Requirement: Durable module intents preserve multi-device claims, allow owner renewal, and filter expired', async () => {
    const persistentDb = new SimulatedPostgresEngine();
    const projectId = '33333333-3333-4333-8333-333333333333';
    const deviceA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const deviceB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const userA = '00000000-0000-4000-8000-000000000001';
    const userB = '00000000-0000-4000-8000-000000000002';

    const repo1 = new PostgresSyncRepository(persistentDb);

    // 1. Device A claims active intent for backend-auth
    const now = Date.now();
    await repo1.claimModuleIntent({
      id: 'intent-1',
      project_id: projectId,
      device_id: deviceA,
      user_id: userA,
      module_name: 'backend-auth',
      intent_description: 'Device A refactoring JWT auth',
      acquired_at: new Date(now).toISOString(),
      expires_at: new Date(now + 3600000).toISOString(), // 1 hour future
    });

    // 2. Device B ALSO claims intent for backend-auth (collaboration intent preservation)
    await repo1.claimModuleIntent({
      id: 'intent-2',
      project_id: projectId,
      device_id: deviceB,
      user_id: userB,
      module_name: 'backend-auth',
      intent_description: 'Device B adding OAuth provider',
      acquired_at: new Date(now).toISOString(),
      expires_at: new Date(now + 7200000).toISOString(), // 2 hours future
    });

    // 3. Claim already-expired intent for frontend-auth
    await repo1.claimModuleIntent({
      id: 'intent-3',
      project_id: projectId,
      device_id: deviceA,
      user_id: userA,
      module_name: 'frontend-auth',
      intent_description: 'Old session',
      acquired_at: new Date(now - 7200000).toISOString(),
      expires_at: new Date(now - 3600000).toISOString(), // 1 hour past
    });

    // --- SIMULATE SERVER RESTART ---
    const repo2 = new PostgresSyncRepository(persistentDb);

    // Verify BOTH active intents for backend-auth are preserved; expired frontend-auth is excluded
    const activeIntents = await repo2.listModuleIntents(projectId);
    expect(activeIntents).toHaveLength(2);

    const intentDevices = activeIntents.map((i) => i.device_id);
    expect(intentDevices).toContain(deviceA);
    expect(intentDevices).toContain(deviceB);

    // 4. Device A renews its own claim without overwriting Device B's claim
    await repo2.claimModuleIntent({
      id: 'intent-1-renewed',
      project_id: projectId,
      device_id: deviceA,
      user_id: userA,
      module_name: 'backend-auth',
      intent_description: 'Device A updated intent description',
      acquired_at: new Date(now + 1000).toISOString(),
      expires_at: new Date(now + 10000000).toISOString(),
    });

    const refreshedIntents = await repo2.listModuleIntents(projectId);
    expect(refreshedIntents).toHaveLength(2);

    const deviceAClaim = refreshedIntents.find((i) => i.device_id === deviceA);
    const deviceBClaim = refreshedIntents.find((i) => i.device_id === deviceB);

    expect(deviceAClaim?.intent_description).toBe('Device A updated intent description');
    expect(deviceBClaim?.intent_description).toBe('Device B adding OAuth provider');

    // 5. Verify database failure propagation without memory fallback
    persistentDb.simulateError = new Error('Postgres deadlock');
    await expect(
      repo2.claimModuleIntent({
        id: 'intent-4',
        project_id: projectId,
        device_id: deviceB,
        user_id: userA,
        module_name: 'backend-auth',
        intent_description: 'Fails',
        acquired_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 3600000).toISOString(),
      })
    ).rejects.toThrow('Postgres deadlock');
    persistentDb.simulateError = null;
  });
});
