import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MemorySyncRepository } from '../storage/memory-sync-repository.js';
import { ConnectionManager } from '../ws/connection-manager.js';
import { buildApp } from '../app.js';
import { createSessionToken } from '../auth/token.js';
import type { FastifyInstance } from 'fastify';

describe('Project Onboarding & Two-Person Collaboration Flow', () => {
  let app: FastifyInstance;
  let repository: MemorySyncRepository;
  let connectionManager: ConnectionManager;
  let ownerToken: string;

  const OWNER_USER_ID = '00000000-0000-4000-8000-000000000002';
  const OWNER_DEVICE_ID = '123e4567-e89b-12d3-a456-426614174000';
  const DEFAULT_PROJECT_ID = '11111111-1111-4111-8111-111111111111';
  const JWT_SECRET = 'test-jwt-secret-with-minimum-32-characters-required';

  beforeAll(async () => {
    repository = new MemorySyncRepository();
    connectionManager = new ConnectionManager();

    app = await buildApp({
      repository,
      connectionManager,
      config: {
        JWT_SECRET,
        PORT: 4001,
        HOST: '127.0.0.1',
        NODE_ENV: 'test',
        MAX_PAYLOAD_BYTES: 5 * 1024 * 1024,
        RATE_LIMIT_MAX: 1000,
      },
    });

    repository.seedProject({
      id: DEFAULT_PROJECT_ID,
      team_id: '00000000-0000-4000-8000-000000000001',
      name: 'Baseline Collaborative Project',
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

    await repository.addTeamMember({
      teamId: '00000000-0000-4000-8000-000000000001',
      userId: OWNER_USER_ID,
      name: 'Primary Developer',
      email: 'dev@antigravity.local',
      role: 'OWNER',
    });

    ownerToken = createSessionToken(
      {
        user_id: OWNER_USER_ID,
        device_id: OWNER_DEVICE_ID,
        project_id: DEFAULT_PROJECT_ID,
        role: 'OWNER',
      },
      JWT_SECRET
    );
  });

  afterAll(async () => {
    await app.close();
  });

  it('Step 1: Lists existing baseline projects', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/projects',
      headers: { authorization: `Bearer ${ownerToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.projects).toBeDefined();
    expect(body.projects.length).toBeGreaterThanOrEqual(1);
    expect(body.projects[0].id).toBe(DEFAULT_PROJECT_ID);
  });

  it('Step 2: Creates a new project with GitHub repo details', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: {
        name: 'Dual Collaboration Project',
        githubRepoOwner: 'itsLUNEXA',
        githubRepoName: 'COLLAB',
        defaultBranch: 'main',
      },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.payload);
    expect(body.project).toBeDefined();
    expect(body.project.name).toBe('Dual Collaboration Project');
    expect(body.project.github_repo_owner).toBe('itsLUNEXA');
    expect(body.project.default_branch).toBe('main');
  });

  it('Step 3: Adds collaborator (Shivam) and verifies online status is FALSE before connection', async () => {
    // 3a: Create project
    const projRes = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: {
        name: 'Shivam Collab App',
        githubRepoOwner: 'org',
        githubRepoName: 'repo',
        defaultBranch: 'main',
      },
    });
    const newProjectId = JSON.parse(projRes.payload).project.id;

    // Issue token scoped to new project
    const scopedOwnerToken = createSessionToken(
      {
        user_id: OWNER_USER_ID,
        device_id: OWNER_DEVICE_ID,
        project_id: newProjectId,
        role: 'OWNER',
      },
      JWT_SECRET
    );

    // 3b: Add Shivam
    const addRes = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${newProjectId}/members`,
      headers: { authorization: `Bearer ${scopedOwnerToken}` },
      payload: {
        name: 'Shivam',
        email: 'shivam@example.com',
        role: 'MEMBER',
      },
    });
    expect(addRes.statusCode).toBe(201);
    const shivam = JSON.parse(addRes.payload).member;
    expect(shivam.name).toBe('Shivam');
    expect(shivam.user_id).toBeDefined();

    // 3c: Verify members list and confirm is_online is false (no fake online status)
    const listRes = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${newProjectId}/members`,
      headers: { authorization: `Bearer ${scopedOwnerToken}` },
    });
    expect(listRes.statusCode).toBe(200);
    const members = JSON.parse(listRes.payload).members;
    expect(members.length).toBe(2);

    const shivamRecord = members.find((m: { email: string }) => m.email === 'shivam@example.com');
    expect(shivamRecord).toBeDefined();
    expect(shivamRecord.is_online).toBe(false);
  });

  it('Step 4: Provisions distinct devices for both developers and verifies authentication', async () => {
    const projRes = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { name: 'Device Test Project' },
    });
    const projectId = JSON.parse(projRes.payload).project.id;
    const projectToken = createSessionToken(
      { user_id: OWNER_USER_ID, device_id: OWNER_DEVICE_ID, project_id: projectId, role: 'OWNER' },
      JWT_SECRET
    );

    // Provision Device 1 (Owner's laptop)
    const dev1Res = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/devices`,
      headers: { authorization: `Bearer ${projectToken}` },
      payload: {
        deviceName: 'User Windows Laptop',
        workspacePath: 'E:\\projects\\dual-app',
      },
    });
    expect(dev1Res.statusCode).toBe(201);
    const dev1Data = JSON.parse(dev1Res.payload);
    expect(dev1Data.device.id).toBeDefined();
    expect(dev1Data.deviceSecret).toBeDefined();

    // Provision Device 2 (Shivam's laptop)
    const shivamUserId = 'shivam-user-uuid-1234';
    const dev2Res = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/devices`,
      headers: { authorization: `Bearer ${projectToken}` },
      payload: {
        userId: shivamUserId,
        deviceName: "Shivam's ThinkPad",
        workspacePath: 'D:\\work\\dual-app',
      },
    });
    expect(dev2Res.statusCode).toBe(201);
    const dev2Data = JSON.parse(dev2Res.payload);
    expect(dev2Data.device.id).toBeDefined();
    expect(dev2Data.deviceSecret).toBeDefined();

    // Verify Device 2 (Shivam) can authenticate independently with its secret
    const shivamAuthRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/token',
      payload: {
        deviceId: dev2Data.device.id,
        deviceSecret: dev2Data.deviceSecret,
        projectId,
      },
    });
    expect(shivamAuthRes.statusCode).toBe(200);
    const shivamAuth = JSON.parse(shivamAuthRes.payload);
    expect(shivamAuth.token).toBeDefined();
    expect(shivamAuth.user_id).toBe(shivamUserId);
    expect(shivamAuth.device_id).toBe(dev2Data.device.id);

    // Verify cross-project isolation: Shivam's token cannot access default project
    const forbiddenRes = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${DEFAULT_PROJECT_ID}`,
      headers: { authorization: `Bearer ${shivamAuth.token}` },
    });
    expect(forbiddenRes.statusCode).toBe(403);
  });

  it('Step 5: Rejects unauthenticated project creation with 401', async () => {
    // 5a: Missing authorization header
    const noAuthRes = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      payload: { name: 'Unauthorized Project' },
    });
    expect(noAuthRes.statusCode).toBe(401);

    // 5b: Invalid bearer token
    const invalidAuthRes = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: { authorization: 'Bearer invalid.poisoned.token' },
      payload: { name: 'Unauthorized Project' },
    });
    expect(invalidAuthRes.statusCode).toBe(401);
  });

  it('Step 6: Initializes creator as OWNER and permits immediate device registration without 403', async () => {
    // 6a: Authenticated project creation
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: {
        name: 'Auto-Owner Provisioned Project',
      },
    });

    expect(createRes.statusCode).toBe(201);
    const createData = JSON.parse(createRes.payload);
    expect(createData.project).toBeDefined();
    expect(createData.token).toBeDefined();
    expect(createData.owner).toBeDefined();
    expect(createData.owner.role).toBe('OWNER');

    const createdProjId = createData.project.id;

    // 6b: Verify creator is listed as OWNER in project members
    const membersRes = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${createdProjId}/members`,
      headers: { authorization: `Bearer ${createData.token}` },
    });
    expect(membersRes.statusCode).toBe(200);
    const membersList = JSON.parse(membersRes.payload).members;
    const ownerMember = membersList.find((m: { user_id: string }) => m.user_id === OWNER_USER_ID);
    expect(ownerMember).toBeDefined();
    expect(ownerMember.role).toBe('OWNER');

    // 6c: Verify immediate device registration using the newly returned token succeeds
    const devRegWithNewTokenRes = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${createdProjId}/devices`,
      headers: { authorization: `Bearer ${createData.token}` },
      payload: {
        deviceName: 'Primary Workstation',
        workspacePath: 'E:\\work\\my-new-app',
      },
    });
    expect(devRegWithNewTokenRes.statusCode).toBe(201);

    // 6d: Verify old token scoped to DEFAULT_PROJECT_ID cannot be used on createdProjId (Safeguard 5)
    const devRegWithOldTokenRes = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${createdProjId}/devices`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: {
        deviceName: 'Secondary Laptop',
        workspacePath: 'E:\\work\\laptop-2',
      },
    });
    expect(devRegWithOldTokenRes.statusCode).toBe(403);
  });

  it('Step 7: Rejects unauthorized access to an existing project', async () => {
    // Foreign user token not belonging to project
    const foreignToken = createSessionToken(
      {
        user_id: '99999999-9999-4999-8999-999999999999',
        device_id: '88888888-8888-4888-8888-888888888888',
        project_id: '77777777-7777-4777-8777-777777777777',
        role: 'developer',
      },
      JWT_SECRET
    );

    const unauthorizedRes = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${DEFAULT_PROJECT_ID}`,
      headers: { authorization: `Bearer ${foreignToken}` },
    });
    expect(unauthorizedRes.statusCode).toBe(403);
    const errBody = JSON.parse(unauthorizedRes.payload);
    expect(errBody.error).toBe('Forbidden: session token is not authorized for this project');
  });
});
