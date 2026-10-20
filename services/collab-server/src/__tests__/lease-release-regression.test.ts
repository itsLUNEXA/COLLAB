import { describe, it, expect } from 'vitest';
import { PostgresSyncRepository, DatabaseClient } from '../storage/postgres-sync-repository.js';
import { LeaseStatus } from '@collab/protocol';
import { DbEditingLease } from '@collab/db';

describe('Phase 3: Lease Release Regression & Correctness Suite', () => {
  class MockLeaseDatabase implements DatabaseClient {
    public leases: Map<string, DbEditingLease> = new Map();

    async query<T = unknown>(text: string, params: unknown[] = []): Promise<{ rows: T[]; rowCount?: number | null }> {
      // 1. claimLease INSERT
      if (text.includes('INSERT INTO editing_leases')) {
        const id = `lease-${this.leases.size + 1}`;
        const lease: DbEditingLease = {
          id,
          project_id: params[0] as string,
          device_id: params[1] as string,
          user_id: params[2] as string,
          relative_path: params[3] as string,
          lease_status: params[4] as LeaseStatus,
          handling_policy: params[5] as 'ISOLATE_TO_SHADOW' | 'AUTO_MERGE_IF_CLEAN' | 'PROMPT_USER',
          reason: params[6] as string | null,
          acquired_at: params[7] as string,
          expires_at: params[8] as string,
          created_at: new Date().toISOString(),
        };
        this.leases.set(id, lease);
        return { rows: [lease as unknown as T], rowCount: 1 };
      }

      // 2. releaseLease UPDATE ... RETURNING id
      if (text.includes('UPDATE editing_leases SET lease_status = \'EXPIRED\'')) {
        const leaseId = params[0] as string;
        const lease = this.leases.get(leaseId);

        if (!lease) {
          // Nonexistent lease
          return { rows: [], rowCount: 0 };
        }

        // Must be currently ACTIVE
        if (lease.lease_status !== LeaseStatus.ACTIVE) {
          return { rows: [], rowCount: 0 };
        }

        // Check optional device_id condition if present in query
        if (text.includes('device_id = $')) {
          const deviceIdIndex = text.includes('project_id = $') && params.length === 3 ? 1 : 1;
          const expectedDeviceId = params[deviceIdIndex] as string;
          if (lease.device_id !== expectedDeviceId) {
            return { rows: [], rowCount: 0 };
          }
        }

        // Check optional project_id condition if present in query
        if (text.includes('project_id = $')) {
          const projectIdIndex = params.length - 1;
          const expectedProjectId = params[projectIdIndex] as string;
          if (lease.project_id !== expectedProjectId) {
            return { rows: [], rowCount: 0 };
          }
        }

        // Update status and return matching id
        lease.lease_status = LeaseStatus.EXPIRED;
        return { rows: [{ id: lease.id } as unknown as T], rowCount: 1 };
      }

      return { rows: [], rowCount: 0 };
    }
  }

  const projectId = '11111111-1111-4111-8111-111111111111';
  const otherProjectId = '22222222-2222-4222-8222-222222222222';
  const deviceA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const deviceB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const userId = '00000000-0000-4000-8000-000000000002';

  it('Regression Case 1: Releasing an existing active lease successfully returns true', async () => {
    const db = new MockLeaseDatabase();
    const repo = new PostgresSyncRepository(db);

    const lease = await repo.claimLease({
      project_id: projectId,
      device_id: deviceA,
      user_id: userId,
      relative_path: 'src/auth.ts',
      lease_status: LeaseStatus.ACTIVE,
      handling_policy: 'ISOLATE_TO_SHADOW',
      reason: 'Editing auth',
      acquired_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60000).toISOString(),
    });

    const released = await repo.releaseLease(lease.id);
    expect(released).toBe(true);

    // Verify lease is now EXPIRED in the database
    expect(db.leases.get(lease.id)?.lease_status).toBe(LeaseStatus.EXPIRED);
  });

  it('Regression Case 2: Releasing a nonexistent lease returns false', async () => {
    const db = new MockLeaseDatabase();
    const repo = new PostgresSyncRepository(db);

    const released = await repo.releaseLease('nonexistent-lease-id');
    expect(released).toBe(false);
  });

  it('Regression Case 3: Attempting to release another device\'s lease returns false', async () => {
    const db = new MockLeaseDatabase();
    const repo = new PostgresSyncRepository(db);

    const lease = await repo.claimLease({
      project_id: projectId,
      device_id: deviceA,
      user_id: userId,
      relative_path: 'src/index.ts',
      lease_status: LeaseStatus.ACTIVE,
      handling_policy: 'ISOLATE_TO_SHADOW',
      reason: 'Editing index',
      acquired_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60000).toISOString(),
    });

    // Device B attempts to release Device A's lease
    const released = await repo.releaseLease(lease.id, deviceB);
    expect(released).toBe(false);

    // Device A's lease remains ACTIVE
    expect(db.leases.get(lease.id)?.lease_status).toBe(LeaseStatus.ACTIVE);

    // Device A releases its own lease -> succeeds
    const ownerReleased = await repo.releaseLease(lease.id, deviceA);
    expect(ownerReleased).toBe(true);
    expect(db.leases.get(lease.id)?.lease_status).toBe(LeaseStatus.EXPIRED);
  });

  it('Regression Case 4: Attempting to release a lease belonging to another project returns false', async () => {
    const db = new MockLeaseDatabase();
    const repo = new PostgresSyncRepository(db);

    const lease = await repo.claimLease({
      project_id: projectId,
      device_id: deviceA,
      user_id: userId,
      relative_path: 'src/config.ts',
      lease_status: LeaseStatus.ACTIVE,
      handling_policy: 'ISOLATE_TO_SHADOW',
      reason: 'Editing config',
      acquired_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60000).toISOString(),
    });

    // Scoped to otherProjectId
    const released = await repo.releaseLease(lease.id, deviceA, otherProjectId);
    expect(released).toBe(false);
    expect(db.leases.get(lease.id)?.lease_status).toBe(LeaseStatus.ACTIVE);

    // Scoped to correct projectId
    const correctRelease = await repo.releaseLease(lease.id, deviceA, projectId);
    expect(correctRelease).toBe(true);
    expect(db.leases.get(lease.id)?.lease_status).toBe(LeaseStatus.EXPIRED);
  });

  it('Regression Case 5: Ensuring the return value accurately reflects whether a row was changed (idempotency)', async () => {
    const db = new MockLeaseDatabase();
    const repo = new PostgresSyncRepository(db);

    const lease = await repo.claimLease({
      project_id: projectId,
      device_id: deviceA,
      user_id: userId,
      relative_path: 'src/utils.ts',
      lease_status: LeaseStatus.ACTIVE,
      handling_policy: 'ISOLATE_TO_SHADOW',
      reason: 'Editing utils',
      acquired_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60000).toISOString(),
    });

    // First release succeeds
    const firstRelease = await repo.releaseLease(lease.id);
    expect(firstRelease).toBe(true);

    // Second release on the same lease returns false because lease is no longer ACTIVE
    const secondRelease = await repo.releaseLease(lease.id);
    expect(secondRelease).toBe(false);
  });

  it('Regression Case 5B: Validates rowCount vs rows behavior (real pg driver returns empty rows without RETURNING)', async () => {
    // Simulated driver that provides only rowCount: 1 without rows
    const rowCountOnlyDb: DatabaseClient = {
      async query<T = unknown>(_text: string, _params: unknown[] = []): Promise<{ rows: T[]; rowCount?: number | null }> {
        return { rows: [], rowCount: 1 };
      },
    };
    const repo = new PostgresSyncRepository(rowCountOnlyDb);
    const result = await repo.releaseLease('any-lease-id');
    expect(result).toBe(true);

    // Simulated driver that returns rowCount: 0
    const zeroRowCountDb: DatabaseClient = {
      async query<T = unknown>(_text: string, _params: unknown[] = []): Promise<{ rows: T[]; rowCount?: number | null }> {
        return { rows: [], rowCount: 0 };
      },
    };
    const repo2 = new PostgresSyncRepository(zeroRowCountDb);
    const result2 = await repo2.releaseLease('any-lease-id');
    expect(result2).toBe(false);
  });
});
