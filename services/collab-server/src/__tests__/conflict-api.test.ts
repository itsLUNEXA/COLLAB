import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { MemorySyncRepository } from '../storage/memory-sync-repository.js';
import { createSessionToken } from '../auth/token.js';
import { ConflictStatus } from '@collab/protocol';

describe('Conflict REST API & Server-Side Resolution (Phase 4 Task 9)', () => {
  let app: FastifyInstance;
  let repository: MemorySyncRepository;

  const jwtSecret = 'test-secret-key-that-is-at-least-32-chars-long';
  const projectId = '33333333-3333-4333-8333-333333333333';
  const deviceAId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const userAId = '11111111-1111-4111-8111-111111111111';

  let token: string;

  beforeAll(async () => {
    repository = new MemorySyncRepository();
    repository.seedProject({
      id: projectId,
      team_id: 'team-1',
      name: 'Hackathon App',
      github_repo_owner: 'org',
      github_repo_name: 'hackathon-app',
      github_installation_id: null,
      default_branch: 'main',
      wip_branch: 'collab/wip',
      integrated_branch: 'collab/integrated',
      current_seq_num: 10,
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
      repository,
    });

    await app.ready();
    token = createSessionToken({ user_id: userAId, device_id: deviceAId, project_id: projectId }, jwtSecret);
  });

  afterAll(async () => {
    await app.close();
  });

  it('Task 9: Lists active conflicts via GET /api/v1/projects/:projectId/conflicts', async () => {
    // Seed an active conflict
    const conflict = await repository.createConflict({
      project_id: projectId,
      relative_path: 'backend/src/routes.ts',
      server_seq: 10,
      device_a_id: deviceAId,
      device_b_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      base_hash: '1'.repeat(64),
      remote_hash: '2'.repeat(64),
      conflict_status: ConflictStatus.DETECTED,
      resolution_payload: null,
      resolved_at: null,
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${projectId}/conflicts`,
      headers: {
        authorization: `Bearer ${token}`,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.count).toBe(1);
    expect(body.conflicts[0].id).toBe(conflict.id);
    expect(body.conflicts[0].relative_path).toBe('backend/src/routes.ts');
  });

  it('Tasks 5, 6, 7: Resolves conflict via POST /api/v1/projects/:projectId/conflicts/:conflictId/resolve', async () => {
    const conflicts = await repository.listActiveConflicts(projectId);
    const targetConflict = conflicts[0];

    const resolvedContent = 'export function getRoutes() { return ["/auth", "/users", "/billing"]; }';

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/conflicts/${targetConflict.id}/resolve`,
      headers: {
        authorization: `Bearer ${token}`,
      },
      payload: {
        resolution: ConflictStatus.RESOLVED_MERGED,
        resolvedContent,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.success).toBe(true);
    expect(body.conflict.conflict_status).toBe(ConflictStatus.RESOLVED_MERGED);
    expect(body.assigned_seq).toBe(11); // Incremented sequence from 10 to 11

    // Verify sync_event was persisted
    const event = await repository.getEventsRange(projectId, 10, 1);
    expect(event).toHaveLength(1);
    expect(event[0].seq_num).toBe(11);
    expect(event[0].content_blob).toBe(resolvedContent);

    // Verify active conflicts list is now empty
    const active = await repository.listActiveConflicts(projectId);
    expect(active).toHaveLength(0);
  });
});
