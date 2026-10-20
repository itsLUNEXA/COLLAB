import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../../../../services/collab-server/src/app';
import { MemorySyncRepository } from '../../../../services/collab-server/src/storage/memory-sync-repository';
import { createSessionToken } from '../../../../services/collab-server/src/auth/token';
import { DashboardApiClient } from '../api/client';
import { ConflictStatus, CheckpointKind, CheckpointStatus, SyncOpType } from '@collab/protocol';

describe('Phase 6.1: Dashboard Integration Verification', () => {
  let app: FastifyInstance;
  let repository: MemorySyncRepository;
  let serverAddress: string;
  let validToken: string;
  let client: DashboardApiClient;

  const jwtSecret = 'test-secret-key-that-is-at-least-32-chars-long';
  const projectId = '11111111-1111-4111-8111-111111111111';
  const deviceId = 'dev-device-001';
  const userId = 'dev-user-001';

  beforeAll(async () => {
    repository = new MemorySyncRepository();

    // 1. Seed Project for Screen 1
    repository.seedProject({
      id: projectId,
      team_id: 'team-hackathon-alpha',
      name: 'Collaborative AI Platform',
      github_repo_owner: 'antigravity-org',
      github_repo_name: 'collab-repo',
      github_installation_id: 123456,
      default_branch: 'main',
      wip_branch: 'collab/wip',
      integrated_branch: 'collab/integrated',
      current_seq_num: 42,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    // 2. Seed Events for Screen 3
    await repository.saveSyncEvent({
      project_id: projectId,
      device_id: deviceId,
      seq_num: 42,
      client_op_id: 'op-alpha-001',
      relative_path: 'src/index.ts',
      op_type: SyncOpType.FILE_UPDATE,
      base_hash: 'hash-base-000',
      target_hash: 'hash-target-999',
      file_size_bytes: 512,
      is_binary: false,
      content_blob: 'console.log("hello collab");',
      blob_storage_url: null,
      created_at: new Date().toISOString(),
    });

    // 3. Seed Conflict for Screen 4
    await repository.createConflict({
      project_id: projectId,
      relative_path: 'packages/core/src/state.ts',
      server_seq: 40,
      device_a_id: deviceId,
      device_b_id: 'dev-device-002',
      base_hash: 'hash-base-abc',
      remote_hash: 'hash-remote-xyz',
      conflict_status: ConflictStatus.DETECTED,
      resolution_payload: null,
      resolved_at: null,
    });

    // 4. Seed Contracts & Dependencies for Screen 5
    await repository.saveContract({
      id: 'contract-auth-v1',
      project_id: projectId,
      contract_type: 'OPENAPI_3_1',
      identifier: 'auth-service-spec',
      owner_module: 'auth-service',
      current_version: 2,
      status: 'ACTIVE',
      current_schema_hash: 'sha256-schema-spec-hash-1234',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    await repository.saveModuleDependency({
      project_id: projectId,
      consumer_module: 'gateway-client',
      contract_id: 'contract-auth-v1',
      last_verified_version: 1, // Consumer verified v1, but current is v2 -> STALE
      is_stale: true,
      stale_reason: 'Breaking contract bump from v1 to v2',
      updated_at: new Date().toISOString(),
    });

    // 5. Seed Tasks & Module Intents for Screen 6
    await repository.saveTask({
      id: 'task-001',
      project_id: projectId,
      title: 'Complete Phase 6 Dashboard Integration',
      description: 'End-to-end verification against running backend',
      assigned_to_user_id: userId,
      target_module: 'apps/dashboard',
      status: 'IN_PROGRESS',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    await repository.claimModuleIntent({
      id: 'intent-001',
      project_id: projectId,
      device_id: deviceId,
      user_id: userId,
      module_name: 'apps/dashboard',
      intent_description: 'Building collaborative web dashboard screens',
      acquired_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 1800 * 1000).toISOString(),
    });

    // 6. Seed Checkpoint for Screen 7
    await repository.saveCheckpoint({
      id: 'cp-001',
      project_id: projectId,
      kind: CheckpointKind.VERIFIED_INTEGRATION,
      status: CheckpointStatus.PASSED,
      sync_sequence_num: 42,
      tree_sha256: 'sha256-checkpoint-tree-hash-abcdef',
      file_count: 15,
      manifest: [{ relative_path: 'src/index.ts', content_hash: 'hash-target-999', size_bytes: 512 }],
      validation_report: {
        passed: true,
        issues: [],
        typecheck_passed: true,
        contracts_conformance_passed: true,
        has_unresolved_conflicts: false,
      },
      github_target_branch: 'collab/integrated',
      github_commit_sha: 'commit-sha-verified-001',
      commit_message: 'Verified integration release checkpoint',
      created_at: new Date().toISOString(),
      published_at: new Date().toISOString(),
    });

    // Build and start the Fastify server on an ephemeral port
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
    });

    serverAddress = await app.listen({ port: 0, host: '127.0.0.1' });
    validToken = createSessionToken({ user_id: userId, device_id: deviceId, project_id: projectId }, jwtSecret);
    client = new DashboardApiClient(serverAddress, () => validToken);
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  // --- Verification of All 8 Screens ---

  it('Screen 1: Projects & Team - returns real project metadata and branch routing', async () => {
    const res = await client.getProject(projectId);
    expect(res.project).toBeDefined();
    expect(res.project.id).toBe(projectId);
    expect(res.project.name).toBe('Collaborative AI Platform');
    expect(res.project.default_branch).toBe('main');
    expect(res.project.wip_branch).toBe('collab/wip');
    expect(res.project.integrated_branch).toBe('collab/integrated');
    expect(res.project.current_seq_num).toBe(42);
  });

  it('Screen 2: Connected Devices - returns live peer sessions and sync sequence', async () => {
    const res = await client.getDevices(projectId);
    expect(res.project_id).toBe(projectId);
    expect(res.current_seq_num).toBe(42);
    expect(Array.isArray(res.devices)).toBe(true);
    expect(res.connected_count).toBe(0); // No WS connection active yet
  });

  it('Screen 3: File Changes - returns real persisted file synchronization events', async () => {
    const res = await client.getEvents(projectId, 0, 10);
    expect(res.project_id).toBe(projectId);
    expect(res.events.length).toBeGreaterThanOrEqual(1);
    const ev = res.events[0];
    expect(ev.seq_num).toBe(42);
    expect(ev.relative_path).toBe('src/index.ts');
    expect(ev.op_type).toBe('FILE_UPDATE');
    expect(ev.target_hash).toBe('hash-target-999');
  });

  it('Screen 4: Conflicts & Merge - displays active conflicts and resolves via POST', async () => {
    const listRes = await client.getConflicts(projectId);
    expect(listRes.conflicts.length).toBe(1);
    const conflict = listRes.conflicts[0];
    expect(conflict.relative_path).toBe('packages/core/src/state.ts');
    expect(conflict.conflict_status).toBe('DETECTED');

    // Resolve the conflict
    const resolveRes = await client.resolveConflict(
      projectId,
      conflict.id,
      ConflictStatus.RESOLVED_ACCEPT_REMOTE,
      'resolved file content'
    );
    expect(resolveRes.success).toBe(true);
    expect(resolveRes.conflict.conflict_status).toBe(ConflictStatus.RESOLVED_ACCEPT_REMOTE);
  });

  it('Screen 5: Contracts & Stale Warnings - returns contracts and detects stale consumer dependencies', async () => {
    const res = await client.getContracts(projectId);
    expect(res.contracts.length).toBe(1);
    const contract = res.contracts[0];
    expect(contract.identifier).toBe('auth-service-spec');
    expect(contract.current_version).toBe(2);
    expect(contract.consumers.length).toBe(1);
    expect(contract.consumers[0].consumer_module).toBe('gateway-client');
    expect(contract.consumers[0].is_stale).toBe(true);
    expect(contract.consumers[0].stale_reason).toContain('Breaking contract bump');
  });

  it('Screen 6: Tasks & Module Ownership - returns task backlog and active intent leases', async () => {
    const res = await client.getTasks(projectId);
    expect(res.tasks.length).toBe(1);
    expect(res.tasks[0].title).toBe('Complete Phase 6 Dashboard Integration');
    expect(res.tasks[0].status).toBe('IN_PROGRESS');

    expect(res.intents.length).toBe(1);
    expect(res.intents[0].module_name).toBe('apps/dashboard');
    expect(res.intents[0].device_id).toBe(deviceId);
  });

  it('Screen 7: GitHub Checkpoints - returns checkpoints with validation reports', async () => {
    const res = await client.getCheckpoints(projectId);
    expect(res.checkpoints.length).toBe(1);
    const cp = res.checkpoints[0];
    expect(cp.kind).toBe('VERIFIED_INTEGRATION');
    expect(cp.status).toBe('PASSED');
    expect(cp.tree_sha256).toBe('sha256-checkpoint-tree-hash-abcdef');
    expect(cp.validation_report?.typecheck_passed).toBe(true);
    expect(cp.validation_report?.contracts_conformance_passed).toBe(true);
  });

  it('Screen 8: Diagnostics & Health - returns pre-flight verification and system metrics', async () => {
    const diag = await client.getDiagnostics(projectId);
    expect(diag.project_id).toBe(projectId);
    expect(diag.current_seq_num).toBeGreaterThanOrEqual(42);
    expect(diag.storage_type).toBe('MemorySyncRepository');
    expect(diag.verification).toBeDefined();
    expect(typeof diag.verification.ready_to_publish).toBe('boolean');
  });

  // --- Authorization & Access Restrictions ---

  it('Enforces Authorization: rejects requests missing Bearer token with 401', async () => {
    const unauthenticatedClient = new DashboardApiClient(serverAddress, () => '');
    await expect(unauthenticatedClient.getProject(projectId)).rejects.toMatchObject({
      statusCode: 401,
      message: expect.stringContaining('Authorization'),
    });
  });

  it('Enforces Authorization: rejects requests with invalid or tampered token with 401', async () => {
    const invalidTokenClient = new DashboardApiClient(serverAddress, () => 'invalid.jwt.token');
    await expect(invalidTokenClient.getProject(projectId)).rejects.toMatchObject({
      statusCode: 401,
      message: expect.stringContaining('Invalid'),
    });
  });

  it('Regression: seamlessly recovers from invalid session token by re-authenticating against /api/v1/auth/token', async () => {
    // Simulate initial state where client holds an invalid session token
    let currentToken = 'stale-or-invalid-browser-token';
    const recoveringClient = new DashboardApiClient(
      serverAddress,
      () => currentToken,
      async () => {
        // Authenticate via /api/v1/auth/token using device credentials
        const authRes = await fetch(`${serverAddress}/api/v1/auth/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId, deviceId, projectId }),
        });
        const data = await authRes.json();
        currentToken = data.token;
        return data.token;
      }
    );

    // Initial call encounters 401, triggers refresh, and succeeds
    const projectRes = await recoveringClient.getProject(projectId);
    expect(projectRes.project.id).toBe(projectId);
    expect(projectRes.project.name).toBe('Collaborative AI Platform');

    // Subsequent call uses the refreshed token directly
    const activityRes = await recoveringClient.getEvents(projectId, 0, 10);
    expect(activityRes.events.length).toBeGreaterThan(0);
    expect(activityRes.events[0].relative_path).toBe('src/index.ts');
  });

  it('Enforces Project Isolation: returns 404 when querying an unregistered project ID', async () => {
    const unknownProjectId = '99999999-9999-4999-8999-999999999999';
    const unknownProjectClient = new DashboardApiClient(
      serverAddress,
      () => createSessionToken({ user_id: userId, device_id: deviceId, project_id: unknownProjectId }, jwtSecret)
    );
    await expect(unknownProjectClient.getProject(unknownProjectId)).rejects.toMatchObject({
      statusCode: 404,
      message: 'Project not found',
    });
  });

  it('Enforces Project Isolation: returns 403 when accessing another project with a cross-project token', async () => {
    const anotherProjectId = '99999999-9999-4999-8999-999999999999';
    await expect(client.getProject(anotherProjectId)).rejects.toMatchObject({
      statusCode: 403,
      message: expect.stringContaining('Forbidden'),
    });
  });
});
