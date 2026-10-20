import { describe, it, expect } from 'vitest';
import {
  SnapshotIdentitySchema,
  WIPCheckpointSchema,
  IntegrationCheckpointSchema,
  CheckpointKind,
  CheckpointStatus,
} from '../index.js';

describe('checkpoints.ts - Checkpoint & Snapshot Identity Validation', () => {
  const validProjectId = '22222222-2222-4222-8222-222222222222';
  const validDeviceId = '11111111-1111-4111-8111-111111111111';
  const validUserId = '44444444-4444-4444-8444-444444444444';
  const validCheckpointId = '55555555-5555-4555-8555-555555555555';
  const validTreeHash = 'c'.repeat(64);
  const validFileHash = 'd'.repeat(64);

  const validSnapshot = {
    tree_sha256: validTreeHash,
    file_count: 2,
    manifest: [
      { relative_path: 'backend/api.ts', content_hash: validFileHash, size_bytes: 512 },
      { relative_path: 'frontend/App.tsx', content_hash: validFileHash, size_bytes: 1024 },
    ],
  };

  it('should validate an immutable SnapshotIdentity (Safeguard 3)', () => {
    const parsed = SnapshotIdentitySchema.safeParse(validSnapshot);
    expect(parsed.success).toBe(true);
  });

  it('should validate a WIP Checkpoint (Safeguard 2)', () => {
    const rawWip = {
      id: validCheckpointId,
      project_id: validProjectId,
      kind: CheckpointKind.WIP_SNAPSHOT,
      sync_sequence_num: 45,
      snapshot: validSnapshot,
      created_by_device_id: validDeviceId,
      label: 'Local milestone before lunch',
      created_at_utc: new Date().toISOString(),
    };

    const parsed = WIPCheckpointSchema.safeParse(rawWip);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.kind).toBe(CheckpointKind.WIP_SNAPSHOT);
  });

  it('should validate a Verified Integration Checkpoint with validation report', () => {
    const rawIntegration = {
      id: validCheckpointId,
      project_id: validProjectId,
      kind: CheckpointKind.VERIFIED_INTEGRATION,
      status: CheckpointStatus.PASSED,
      sync_sequence_num: 50,
      snapshot: validSnapshot,
      validation_report: {
        snapshot_tree_sha256: validTreeHash,
        started_at_utc: new Date().toISOString(),
        completed_at_utc: new Date().toISOString(),
        passed: true,
        issues: [],
        typecheck_passed: true,
        contracts_conformance_passed: true,
        has_unresolved_conflicts: false,
      },
      github_target_branch: 'collab/integrated',
      github_commit_sha: 'e'.repeat(40), // 40-char git commit SHA
      commit_message: 'feat: integrated auth backend and frontend adapter',
      created_by_user_id: validUserId,
      created_at_utc: new Date().toISOString(),
      published_at_utc: new Date().toISOString(),
    };

    const parsed = IntegrationCheckpointSchema.safeParse(rawIntegration);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.status).toBe(CheckpointStatus.PASSED);
    expect(parsed.data?.github_commit_sha).toHaveLength(40);
  });

  it('computeSnapshotIdentity produces deterministic tree_sha256 regardless of input order', async () => {
    const { computeSnapshotIdentity } = await import('../index.js');
    const snap1 = computeSnapshotIdentity([
      { relative_path: 'b.ts', content: 'console.log("b");' },
      { relative_path: 'a.ts', content: 'console.log("a");' },
    ]);

    const snap2 = computeSnapshotIdentity([
      { relative_path: 'a.ts', content: 'console.log("a");' },
      { relative_path: 'b.ts', content: 'console.log("b");' },
    ]);

    expect(snap1.tree_sha256).toBe(snap2.tree_sha256);
    expect(snap1.file_count).toBe(2);
    expect(snap1.manifest[0].relative_path).toBe('a.ts');
    expect(snap1.manifest[1].relative_path).toBe('b.ts');
  });
});

