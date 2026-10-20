/**
 * @file checkpoint-publishing.test.ts
 * Targeted test suite for Phase 5A: GitHub Checkpointing & Serialized Publishing.
 * Covers WIP vs Verified branches, validation gates, fast-forward protection,
 * serialization, retry policies, audit records, and work preservation.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { MemorySyncRepository } from '../storage/memory-sync-repository.js';
import { MockGitHubClient } from '../github/mock-github-client.js';
import { createSessionToken } from '../auth/token.js';
import {
  CheckpointKind,
  CheckpointStatus,
  ConflictStatus,
  ErrorCode,
} from '@collab/protocol';

describe('Phase 5A: GitHub Checkpointing & Safe Publishing', () => {
  let app: FastifyInstance;
  let repository: MemorySyncRepository;
  let githubClient: MockGitHubClient;

  const jwtSecret = 'test-secret-key-that-is-at-least-32-chars-long';
  const projectId = '77777777-7777-4777-8777-777777777777';
  const deviceId = '88888888-8888-4888-8888-888888888888';
  const userId = '99999999-9999-4999-8999-999999999999';

  const repoOwner = 'collab-ai';
  const repoName = 'hackathon-workspace';
  const wipBranch = 'collab/wip';
  const integratedBranch = 'collab/integrated';

  let token: string;

  beforeAll(async () => {
    repository = new MemorySyncRepository();
    githubClient = new MockGitHubClient();

    repository.seedProject({
      id: projectId,
      team_id: 'team-hackathon',
      name: 'Hackathon Project',
      github_repo_owner: repoOwner,
      github_repo_name: repoName,
      github_installation_id: 123456,
      default_branch: 'main',
      wip_branch: wipBranch,
      integrated_branch: integratedBranch,
      current_seq_num: 42,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    // Seed existing base commit on integrated branch
    githubClient.seedBranch(repoOwner, repoName, integratedBranch, '1111111111111111111111111111111111111111');

    app = buildApp({
      config: {
        PORT: 0,
        HOST: '127.0.0.1',
        NODE_ENV: 'test',
        MAX_PAYLOAD_BYTES: 1024 * 1024,
        RATE_LIMIT_MAX: 10000,
        JWT_SECRET: jwtSecret,
      },
      repository,
      githubClient,
    });

    await app.ready();
    token = createSessionToken({ user_id: userId, device_id: deviceId, project_id: projectId }, jwtSecret);
  });

  afterAll(async () => {
    await app.close();
  });

  it('Requirements 3 & 4: Creates a WIP checkpoint without committing every file save (Safeguard 2)', async () => {
    const files = [
      { relative_path: 'backend/src/server.ts', content: 'console.log("WIP server");' },
      { relative_path: 'frontend/src/App.tsx', content: 'export default function App() { return <div>WIP</div>; }' },
    ];

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/checkpoints/wip`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        files,
        label: 'Milestone before lunch',
        publishImmediately: true,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.success).toBe(true);
    expect(body.checkpoint.kind).toBe(CheckpointKind.WIP_SNAPSHOT);
    expect(body.checkpoint.status).toBe(CheckpointStatus.PASSED);
    expect(body.checkpoint.github_target_branch).toBe(wipBranch);
    expect(body.snapshot.tree_sha256).toBeDefined();
    expect(body.snapshot.file_count).toBe(2);

    // Verified published to WIP branch on GitHub simulator
    expect(body.publishResult.success).toBe(true);
    expect(body.publishResult.targetBranch).toBe(wipBranch);
    expect(body.publishResult.commitSha).toHaveLength(40);
  });

  it('Requirements 6 & 8: Validation gate rejects integration checkpoint if active conflicts exist, preserving work', async () => {
    // 1. Seed an active conflict in the repository
    const conflict = await repository.createConflict({
      project_id: projectId,
      relative_path: 'backend/src/routes.ts',
      server_seq: 43,
      device_a_id: deviceId,
      device_b_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      base_hash: 'b'.repeat(64),
      remote_hash: 'r'.repeat(64),
      conflict_status: ConflictStatus.DETECTED,
      resolution_payload: null,
      resolved_at: null,
    });

    const files = [
      { relative_path: 'backend/src/routes.ts', content: 'export const routes = ["/api"];' },
    ];

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/checkpoints/integration`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        files,
        commitMessage: 'feat: add routes',
        publishImmediately: true,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    // Validation failed
    expect(body.success).toBe(false);
    expect(body.checkpoint.status).toBe(CheckpointStatus.FAILED);
    expect(body.checkpoint.validation_report.passed).toBe(false);
    expect(body.checkpoint.validation_report.has_unresolved_conflicts).toBe(true);
    expect(body.checkpoint.validation_report.issues[0].check_type).toBe('CONFLICT_CHECK');

    // Requirement 8: Work is preserved in repository, checkpoint is persisted with FAILED status
    const persisted = await repository.getCheckpoint(body.checkpoint.id);
    expect(persisted).toBeDefined();
    expect(persisted!.status).toBe(CheckpointStatus.FAILED);

    // Requirement 7: Was NOT published to integrated branch
    expect(body.publishResult).toBeUndefined();

    // Clean up conflict for subsequent tests
    await repository.resolveConflict(conflict.id, ConflictStatus.RESOLVED_MERGED, {});
  });

  it('Requirements 6 & 7: Passes validation and publishes only the exact verified snapshot to integrated branch', async () => {
    const files = [
      { relative_path: 'backend/src/api.ts', content: 'export function getStatus() { return "OK"; }' },
      { relative_path: 'contracts/openapi.yaml', content: 'openapi: 3.1.0\ninfo:\n  title: App\n  version: 1.0.0\npaths: {}' },
    ];

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/checkpoints/integration`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        files,
        commitMessage: 'feat: verified core status endpoint and openapi contract',
        publishImmediately: true,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.success).toBe(true);
    expect(body.checkpoint.status).toBe(CheckpointStatus.PASSED);
    expect(body.checkpoint.validation_report.passed).toBe(true);
    expect(body.checkpoint.validation_report.contracts_conformance_passed).toBe(true);

    // Published to integrated branch
    expect(body.publishResult.success).toBe(true);
    expect(body.publishResult.targetBranch).toBe(integratedBranch);
    expect(body.publishResult.commitSha).toHaveLength(40);

    // Verify commit in MockGitHubClient has previous remote sha as parent
    const commit = githubClient.getCommit(body.publishResult.commitSha);
    expect(commit).toBeDefined();
    expect(commit!.parents).toContain('1111111111111111111111111111111111111111');
    expect(githubClient.wasForcePushAttempted).toBe(false); // Requirement 10: Never force-push
  });

  it('Requirements 5 & 10: Rejects publishing if remote branch has diverged (Fast-Forward Protection)', async () => {
    // Current remote SHA on integrated branch is the commit created in previous test
    const remoteRef = await githubClient.getRef(repoOwner, repoName, integratedBranch);
    const currentRemoteSha = remoteRef!.sha;

    // Simulate another teammate advancing the branch on GitHub directly
    const teammateCommit = await githubClient.createCommit(
      repoOwner,
      repoName,
      'teammate external direct commit',
      'tree-999',
      [currentRemoteSha]
    );
    await githubClient.updateRef(repoOwner, repoName, integratedBranch, teammateCommit.sha, false);

    // Now try to publish a checkpoint providing the stale expectedBaseSha
    const files = [{ relative_path: 'backend/src/api.ts', content: 'export function getStatus() { return "OK v2"; }' }];
    const checkpointRes = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/checkpoints/integration`,
      headers: { authorization: `Bearer ${token}` },
      payload: { files, commitMessage: 'feat: v2 update' },
    });
    const checkpointBody = JSON.parse(checkpointRes.payload);

    // Publish with stale expected base sha
    const publishRes = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/checkpoints/${checkpointBody.checkpoint.id}/publish`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        files,
        expectedBaseSha: currentRemoteSha, // Outdated! Remote has moved to teammateCommit.sha
      },
    });

    const publishBody = JSON.parse(publishRes.payload);
    expect(publishBody.success).toBe(false);
    expect(publishBody.errorCode).toBe(ErrorCode.BRANCH_DIVERGENCE);
    expect(publishBody.error).toContain('Remote branch has diverged');

    // Requirement 9: Audit record captures failure
    const auditRes = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${projectId}/checkpoints/${checkpointBody.checkpoint.id}/audit`,
      headers: { authorization: `Bearer ${token}` },
    });
    const auditBody = JSON.parse(auditRes.payload);
    expect(auditBody.audit_records.length).toBeGreaterThan(0);
    expect(auditBody.audit_records[0].status).toBe('FAILED');
    expect(auditBody.audit_records[0].error_message).toContain('diverged');
  });

  it('Requirement 9: Retries on transient network failures and records retry audit logs', async () => {
    // Configure mock client to throw 1 transient network timeout
    githubClient.networkFailureCount = 1;

    const files = [{ relative_path: 'backend/src/retry-test.ts', content: 'console.log("retry test");' }];
    const checkpointRes = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/checkpoints/wip`,
      headers: { authorization: `Bearer ${token}` },
      payload: { files, label: 'Retry test milestone' },
    });
    const checkpointBody = JSON.parse(checkpointRes.payload);

    // Publish: should fail once with ETIMEDOUT, then retry and succeed
    const publishRes = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/checkpoints/${checkpointBody.checkpoint.id}/publish`,
      headers: { authorization: `Bearer ${token}` },
      payload: { files },
    });

    const publishBody = JSON.parse(publishRes.payload);
    expect(publishBody.success).toBe(true);
    expect(publishBody.commitSha).toHaveLength(40);

    // Audit logs verify RETRYING then SUCCESS
    const auditRes = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${projectId}/checkpoints/${checkpointBody.checkpoint.id}/audit`,
      headers: { authorization: `Bearer ${token}` },
    });
    const auditBody = JSON.parse(auditRes.payload);
    expect(auditBody.audit_records).toHaveLength(2);
    expect(auditBody.audit_records[0].status).toBe('RETRYING');
    expect(auditBody.audit_records[0].attempt).toBe(1);
    expect(auditBody.audit_records[1].status).toBe('SUCCESS');
    expect(auditBody.audit_records[1].attempt).toBe(2);
  });

  it('Requirement 5: Serializes publishing operations to prevent concurrent update races', async () => {
    // Create two separate WIP checkpoints
    const cp1Res = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/checkpoints/wip`,
      headers: { authorization: `Bearer ${token}` },
      payload: { files: [{ relative_path: 'app/task1.ts', content: 'console.log("task 1");' }] },
    });
    const cp1 = JSON.parse(cp1Res.payload).checkpoint;

    const cp2Res = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/checkpoints/wip`,
      headers: { authorization: `Bearer ${token}` },
      payload: { files: [{ relative_path: 'app/task2.ts', content: 'console.log("task 2");' }] },
    });
    const cp2 = JSON.parse(cp2Res.payload).checkpoint;

    // Dispatch both publishing requests concurrently
    const [res1, res2] = await Promise.all([
      app.inject({
        method: 'POST',
        url: `/api/v1/projects/${projectId}/checkpoints/${cp1.id}/publish`,
        headers: { authorization: `Bearer ${token}` },
        payload: { files: [{ relative_path: 'app/task1.ts', content: 'console.log("task 1");' }] },
      }),
      app.inject({
        method: 'POST',
        url: `/api/v1/projects/${projectId}/checkpoints/${cp2.id}/publish`,
        headers: { authorization: `Bearer ${token}` },
        payload: { files: [{ relative_path: 'app/task2.ts', content: 'console.log("task 2");' }] },
      }),
    ]);

    const body1 = JSON.parse(res1.payload);
    const body2 = JSON.parse(res2.payload);

    expect(body1.success).toBe(true);
    expect(body2.success).toBe(true);
    // Both commits are created cleanly and serialized
    expect(body1.commitSha).toBeDefined();
    expect(body2.commitSha).toBeDefined();
    expect(body1.commitSha).not.toBe(body2.commitSha);

    // Second commit lists first commit as parent (serialized fast-forward)
    const commit2 = githubClient.getCommit(body2.commitSha);
    expect(commit2?.parents).toContain(body1.commitSha);
  });
});

