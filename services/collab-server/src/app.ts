/**
 * @file app.ts
 * Fastify server application factory.
 * Registers REST routes, authenticated WebSocket gateway, and structured logging.
 */

import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import { ServerConfig } from './config.js';
import { ISyncRepository } from './storage/sync-repository.interface.js';
import { ConnectionManager } from './ws/connection-manager.js';
import { WebSocketHandler } from './ws/ws-handler.js';
import * as crypto from 'node:crypto';
import { verifySessionToken, createSessionToken, hashDeviceSecret } from './auth/token.js';
import {
  CollabError,
  ConflictStatus,
  CheckpointKind,
  CheckpointStatus,
  ProtocolVersion,
  MessageType,
  SyncOpType,
  normalizeRelativePath,
} from '@collab/protocol';
import { IGitHubClient } from './github/github-client.interface.js';
import { MockGitHubClient } from './github/mock-github-client.js';
import { CheckpointService } from './checkpoints/service.js';
import { SharedContextEngine } from './context/context-engine.js';
import { McpServer, JsonRpcRequest } from './mcp/mcp-server.js';

export interface AppDependencies {
  config: ServerConfig;
  repository: ISyncRepository;
  connectionManager?: ConnectionManager;
  githubClient?: IGitHubClient;
}

export function buildApp(deps: AppDependencies): FastifyInstance {
  const { config, repository } = deps;
  const connectionManager = deps.connectionManager ?? new ConnectionManager();
  const githubClient = deps.githubClient ?? new MockGitHubClient();
  const wsHandler = new WebSocketHandler(repository, connectionManager, config);
  const checkpointService = new CheckpointService(repository, githubClient);
  const contextEngine = new SharedContextEngine(repository);
  const mcpServer = new McpServer(contextEngine, async (projId) => {
    const proj = await repository.getProject(projId);
    return !!proj;
  });

  // Task 11: Structured logging that excludes source contents and secrets
  const app = Fastify({
    logger: {
      level: config.NODE_ENV === 'test' ? 'error' : 'info',
      serializers: {
        req(req) {
          return {
            method: req.method,
            url: req.url,
            hostname: req.hostname,
            remoteAddress: req.ip,
          };
        },
      },
    },
  });

  // Plugins
  app.register(cors, { origin: true });
  app.register(rateLimit, {
    max: config.RATE_LIMIT_MAX,
    timeWindow: '1 minute',
  });
  app.register(websocket);

  // Health endpoint
  app.get('/health', async () => {
    return {
      status: 'ok',
      service: 'collab-server',
      version: '0.1.0',
      timestamp: new Date().toISOString(),
    };
  });

  async function authenticateProjectRequest(
    request: { headers: { authorization?: string }; params?: { projectId?: string } },
    reply: { status: (code: number) => { send: (body: unknown) => unknown } }
  ): Promise<{ user_id: string; device_id: string; project_id?: string; role?: string } | null> {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      reply.status(401).send({ error: 'Missing or invalid Authorization header' });
      return null;
    }
    let tokenPayload;
    try {
      tokenPayload = verifySessionToken(authHeader.substring(7), config.JWT_SECRET);
    } catch {
      reply.status(401).send({ error: 'Invalid session token' });
      return null;
    }

    const targetProjectId = request.params?.projectId;
    if (targetProjectId && tokenPayload.project_id && tokenPayload.project_id !== targetProjectId) {
      if (tokenPayload.role !== 'admin') {
        reply.status(403).send({ error: 'Forbidden: session token is not authorized for this project' });
        return null;
      }
    }

    return tokenPayload;
  }

  // Session Token Issuance (for Companion CLI and Dashboard)
  app.post<{
    Body: {
      userId?: string;
      deviceId?: string;
      projectId?: string;
      role?: string;
      deviceSecret?: string;
    };
  }>('/api/v1/auth/token', async (request, reply) => {
    const body = request.body || {};

    let isAuthenticated = false;
    let resolvedUserId = body.userId;

    // Method 1: Legit device credential verification (Safeguard 5)
    if (body.deviceId && body.deviceSecret) {
      try {
        const device = await repository.getDevice(body.deviceId);
        if (device && device.device_token_hash === hashDeviceSecret(body.deviceSecret) && !device.is_revoked) {
          isAuthenticated = true;
          resolvedUserId = device.user_id;
        }
      } catch {
        // Device lookup failed safely
      }
    }

    // Method 2: Existing authenticated Bearer session (admin or project member)
    const authHeader = request.headers.authorization;
    let callerTokenPayload: { role?: string; project_id?: string } | null = null;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      try {
        callerTokenPayload = verifySessionToken(authHeader.substring(7), config.JWT_SECRET);
        if (callerTokenPayload.role === 'admin' || !body.projectId || callerTokenPayload.project_id === body.projectId) {
          isAuthenticated = true;
        }
      } catch {
        // invalid bearer header
      }
    }

    // In production, require either valid device credentials or valid session token
    if (config.NODE_ENV === 'production' && !isAuthenticated) {
      return reply.status(401).send({
        error: 'Valid device credentials (deviceId + deviceSecret) or authorized session token required in production',
      });
    }

    // Role elevation guard: callers cannot self-assign 'admin' unless already authorized as admin
    let role = 'developer';
    if (body.role && body.role !== 'developer') {
      if (callerTokenPayload && callerTokenPayload.role === 'admin') {
        role = body.role;
      }
    }

    const defaultUserId = '00000000-0000-4000-8000-000000000002';
    const defaultDeviceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const defaultProjectId = '11111111-1111-4111-8111-111111111111';

    const userId = resolvedUserId || defaultUserId;
    const deviceId = body.deviceId || defaultDeviceId;
    const projectId = body.projectId || defaultProjectId;

    const token = createSessionToken(
      {
        user_id: userId,
        device_id: deviceId,
        project_id: projectId,
        role,
      },
      config.JWT_SECRET,
      86400 * 7 // 7 days
    );

    return {
      token,
      expires_in: 86400 * 7,
      user_id: userId,
      device_id: deviceId,
      project_id: projectId,
      role,
    };
  });

  // List all projects
  app.get('/api/v1/projects', async (request, reply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.status(401).send({ error: 'Missing or invalid Authorization header' });
    }
    try {
      verifySessionToken(authHeader.substring(7), config.JWT_SECRET);
    } catch {
      return reply.status(401).send({ error: 'Invalid session token' });
    }

    const projects = await repository.listProjects();
    return { projects };
  });

  // Create a new project
  app.post<{
    Body: {
      name: string;
      githubRepoOwner?: string;
      githubRepoName?: string;
      defaultBranch?: string;
      teamId?: string;
    };
  }>('/api/v1/projects', async (request, reply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.status(401).send({ error: 'Missing or invalid Authorization header' });
    }
    let tokenPayload;
    try {
      tokenPayload = verifySessionToken(authHeader.substring(7), config.JWT_SECRET);
    } catch {
      return reply.status(401).send({ error: 'Invalid session token' });
    }

    const { name, githubRepoOwner, githubRepoName, defaultBranch, teamId } = request.body || {};
    if (!name || name.trim().length === 0) {
      return reply.status(400).send({ error: 'Project name is required' });
    }

    const defaultTeamId = '00000000-0000-4000-8000-000000000001';
    const effectiveTeamId = teamId || defaultTeamId;

    const project = await repository.createProject({
      team_id: effectiveTeamId,
      name: name.trim(),
      github_repo_owner: githubRepoOwner?.trim() || null,
      github_repo_name: githubRepoName?.trim() || null,
      default_branch: defaultBranch?.trim() || 'main',
      wip_branch: 'collab/wip',
      integrated_branch: 'collab/integrated',
    });

    // Ensure the authenticated creator is registered as OWNER in team members
    const creatorUserId = tokenPayload.user_id;
    let ownerMember;
    if (creatorUserId) {
      const existingMembers = await repository.listProjectMembers(project.id);
      ownerMember = existingMembers.find((m) => m.user_id === creatorUserId);
      if (!ownerMember) {
        ownerMember = await repository.addTeamMember({
          teamId: effectiveTeamId,
          userId: creatorUserId,
          name: 'Project Owner',
          email: `${creatorUserId}@collab.local`,
          role: 'OWNER',
        });
      }
    }

    // Generate session token scoped to the new project for the owner
    const newProjectToken = createSessionToken(
      {
        user_id: creatorUserId,
        device_id: tokenPayload.device_id,
        project_id: project.id,
        role: 'OWNER',
      },
      config.JWT_SECRET,
      86400 * 7
    );

    return reply.status(201).send({
      project,
      token: newProjectToken,
      owner: ownerMember,
    });
  });

  // Phase 6 Screen 1: Project Details & Team
  app.get<{
    Params: { projectId: string };
  }>('/api/v1/projects/:projectId', async (request, reply) => {
    const auth = await authenticateProjectRequest(request, reply);
    if (!auth) return;

    const project = await repository.getProject(request.params.projectId);
    if (!project) {
      return reply.status(404).send({ error: 'Project not found' });
    }
    return { project };
  });

  // List project team members with live WebSocket presence
  app.get<{
    Params: { projectId: string };
  }>('/api/v1/projects/:projectId/members', async (request, reply) => {
    const auth = await authenticateProjectRequest(request, reply);
    if (!auth) return;

    const members = await repository.listProjectMembers(request.params.projectId);
    const sessions = connectionManager.getConnectedSessions(request.params.projectId);
    const onlineUserIds = new Set(sessions.map((s) => s.userId));

    return {
      project_id: request.params.projectId,
      members: members.map((m) => ({
        ...m,
        is_online: onlineUserIds.has(m.user_id),
      })),
    };
  });

  // Invite/add a collaborator to the project
  app.post<{
    Params: { projectId: string };
    Body: { name: string; email: string; role?: 'OWNER' | 'ADMIN' | 'MEMBER' };
  }>('/api/v1/projects/:projectId/members', async (request, reply) => {
    const auth = await authenticateProjectRequest(request, reply);
    if (!auth) return;

    const project = await repository.getProject(request.params.projectId);
    if (!project) {
      return reply.status(404).send({ error: 'Project not found' });
    }

    const { name, email, role } = request.body || {};
    if (!name || !email) {
      return reply.status(400).send({ error: 'Name and email are required' });
    }

    const member = await repository.addTeamMember({
      teamId: project.team_id,
      name: name.trim(),
      email: email.trim(),
      role: role || 'MEMBER',
    });

    return reply.status(201).send({ member });
  });

  // Provision and register a device under the project
  app.post<{
    Params: { projectId: string };
    Body: { userId: string; deviceName: string; osInfo?: string; workspacePath?: string };
  }>('/api/v1/projects/:projectId/devices', async (request, reply) => {
    const auth = await authenticateProjectRequest(request, reply);
    if (!auth) return;

    const { userId, deviceName, osInfo, workspacePath } = request.body || {};
    const effectiveUserId = userId || auth.user_id;
    if (!effectiveUserId || !deviceName) {
      return reply.status(400).send({ error: 'userId and deviceName are required' });
    }

    const deviceSecret = crypto.randomBytes(16).toString('hex');
    const deviceTokenHash = hashDeviceSecret(deviceSecret);

    const device = await repository.registerDevice({
      user_id: effectiveUserId,
      device_name: deviceName.trim(),
      os_info: osInfo || null,
      device_token_hash: deviceTokenHash,
    });

    if (workspacePath) {
      const pathHash = crypto.createHash('sha256').update(workspacePath.trim()).digest('hex');
      await repository.registerWorkspace({
        project_id: request.params.projectId,
        device_id: device.id,
        local_path_hash: pathHash,
      });
    }

    return reply.status(201).send({
      device: {
        id: device.id,
        device_name: device.device_name,
        user_id: device.user_id,
      },
      deviceSecret,
    });
  });

  // Phase 6 Screen 2: Connected Devices & Live Status
  app.get<{
    Params: { projectId: string };
  }>('/api/v1/projects/:projectId/devices', async (request, reply) => {
    const auth = await authenticateProjectRequest(request, reply);
    if (!auth) return;

    const sessions = connectionManager.getConnectedSessions(request.params.projectId);
    const currentSeq = await repository.getCurrentSequenceNum(request.params.projectId);

    return {
      project_id: request.params.projectId,
      current_seq_num: currentSeq,
      connected_count: sessions.length,
      devices: sessions.map((s) => ({
        device_id: s.deviceId,
        user_id: s.userId,
        connected_at: s.connectedAt.toISOString(),
        last_heartbeat: s.lastHeartbeat.toISOString(),
        is_online: true,
      })),
    };
  });

  // Phase 6 Screen 5: Contracts & Stale Warnings
  app.get<{
    Params: { projectId: string };
  }>('/api/v1/projects/:projectId/contracts', async (request, reply) => {
    const auth = await authenticateProjectRequest(request, reply);
    if (!auth) return;

    const [contracts, dependencies] = await Promise.all([
      repository.listContracts(request.params.projectId),
      repository.getModuleDependencies(request.params.projectId),
    ]);

    return {
      project_id: request.params.projectId,
      contracts: contracts.map((c) => ({
        ...c,
        consumers: dependencies.filter((d) => d.contract_id === c.id),
      })),
    };
  });

  // Phase 6 Screen 6: Tasks & Module Ownership
  app.get<{
    Params: { projectId: string };
  }>('/api/v1/projects/:projectId/tasks', async (request, reply) => {
    const auth = await authenticateProjectRequest(request, reply);
    if (!auth) return;

    const [tasks, intents] = await Promise.all([
      repository.listTasks(request.params.projectId),
      repository.listModuleIntents(request.params.projectId),
    ]);

    return {
      project_id: request.params.projectId,
      tasks,
      intents,
    };
  });

  // Phase 6 Screen 8: System Diagnostics & Integration Health
  app.get<{
    Params: { projectId: string };
  }>('/api/v1/projects/:projectId/diagnostics', async (request, reply) => {
    const auth = await authenticateProjectRequest(request, reply);
    if (!auth) return;

    const verification = await contextEngine.verifyIntegrationStatus(request.params.projectId);
    const currentSeq = await repository.getCurrentSequenceNum(request.params.projectId);
    const peerCount = connectionManager.getProjectPeerCount(request.params.projectId);

    return {
      project_id: request.params.projectId,
      current_seq_num: currentSeq,
      connected_peers: peerCount,
      verification,
      server_time: new Date().toISOString(),
      storage_type: repository.constructor.name,
    };
  });

  // Task 9: REST catch-up endpoint for missed events
  app.get<{
    Params: { projectId: string };
    Querystring: { from_seq?: string; limit?: string };
  }>('/api/v1/projects/:projectId/events', async (request, reply) => {
    const auth = await authenticateProjectRequest(request, reply);
    if (!auth) return;

    const projectId = request.params.projectId;
    const fromSeq = parseInt(request.query.from_seq ?? '0', 10);
    const limit = Math.min(parseInt(request.query.limit ?? '100', 10), 500);

    const events = await repository.getEventsRange(projectId, fromSeq, limit);
    return {
      project_id: projectId,
      from_seq: fromSeq,
      count: events.length,
      events: events.map((e) => ({
        seq_num: e.seq_num,
        client_op_id: e.client_op_id,
        device_id: e.device_id,
        relative_path: e.relative_path,
        op_type: e.op_type,
        base_hash: e.base_hash,
        target_hash: e.target_hash,
        is_binary: e.is_binary,
        created_at: e.created_at,
      })),
    };
  });

  // Phase 4 Task 9: Conflict API for Dashboard & Companions
  app.get<{
    Params: { projectId: string };
  }>('/api/v1/projects/:projectId/conflicts', async (request, reply) => {
    const auth = await authenticateProjectRequest(request, reply);
    if (!auth) return;

    const conflicts = await repository.listActiveConflicts(request.params.projectId);
    return {
      project_id: request.params.projectId,
      count: conflicts.length,
      conflicts,
    };
  });

  app.post<{
    Params: { projectId: string };
    Body: {
      relativePath: string;
      baseHash?: string | null;
      remoteHash: string;
      remoteDeviceId?: string;
    };
  }>('/api/v1/projects/:projectId/conflicts', async (request, reply) => {
    const auth = await authenticateProjectRequest(request, reply);
    if (!auth) return;

    const { relativePath, baseHash, remoteHash, remoteDeviceId } = request.body || {};
    if (!relativePath || !remoteHash) {
      return reply.status(400).send({ error: 'relativePath and remoteHash are required' });
    }

    const normalizedPath = normalizeRelativePath(relativePath);
    const conflict = await repository.createConflict({
      project_id: request.params.projectId,
      relative_path: normalizedPath,
      server_seq: await repository.getCurrentSequenceNum(request.params.projectId),
      device_a_id: auth.device_id,
      device_b_id: remoteDeviceId || auth.device_id,
      base_hash: baseHash || null,
      remote_hash: remoteHash,
      conflict_status: ConflictStatus.DETECTED,
      resolution_payload: null,
      resolved_at: null,
    });

    return reply.status(201).send({ conflict });
  });

  app.post<{
    Params: { projectId: string; conflictId: string };
    Body: { resolution: ConflictStatus; resolvedContent?: string };
  }>('/api/v1/projects/:projectId/conflicts/:conflictId/resolve', async (request, reply) => {
    const tokenPayload = await authenticateProjectRequest(request, reply);
    if (!tokenPayload) return;

    const { projectId, conflictId } = request.params;
    const { resolution, resolvedContent } = request.body;

    const conflict = await repository.getConflict(conflictId);
    if (!conflict || conflict.project_id !== projectId) {
      return reply.status(404).send({ error: 'Conflict record not found' });
    }

    const resolvedConflict = await repository.resolveConflict(conflictId, resolution, {
      resolved_by_device: tokenPayload.device_id,
      timestamp: new Date().toISOString(),
    });

    let assignedSeq: number | undefined;

    // Phase 4 Task 6: Broadcast resolved content safely to all peers
    if (resolvedContent !== undefined && (resolution === ConflictStatus.RESOLVED_ACCEPT_REMOTE || resolution === ConflictStatus.RESOLVED_MERGED)) {
      const nextSeq = await repository.getNextSequenceNum(projectId);
      assignedSeq = nextSeq;

      const targetHash = crypto.createHash('sha256').update(resolvedContent).digest('hex');
      const clientOpId = crypto.randomUUID();

      await repository.saveSyncEvent({
        project_id: projectId,
        device_id: tokenPayload.device_id,
        seq_num: nextSeq,
        client_op_id: clientOpId,
        relative_path: conflict.relative_path,
        op_type: SyncOpType.FILE_UPDATE,
        base_hash: conflict.base_hash,
        target_hash: targetHash,
        file_size_bytes: Buffer.byteLength(resolvedContent),
        is_binary: false,
        content_blob: resolvedContent,
        blob_storage_url: null,
        created_at: new Date().toISOString(),
      });

      connectionManager.broadcastToProject(
        projectId,
        {
          protocol_version: ProtocolVersion,
          project_id: projectId,
          device_id: tokenPayload.device_id,
          message_type: MessageType.SERVER_BROADCAST,
          client_op_id: clientOpId,
          sequence_num: nextSeq,
          timestamp_utc: new Date().toISOString(),
          payload: {
            op_type: SyncOpType.FILE_UPDATE,
            relative_path: conflict.relative_path,
            base_hash: conflict.base_hash,
            target_hash: targetHash,
            encoding: 'utf-8',
            content: resolvedContent,
            file_size_bytes: Buffer.byteLength(resolvedContent),
            is_binary: false,
          },
        },
        tokenPayload.device_id // exclude resolver to avoid echo loop (Task 7)
      );
    }

    return {
      success: true,
      conflict: resolvedConflict,
      assigned_seq: assignedSeq,
    };
  });

  // --- Phase 5A: GitHub Checkpointing REST API ---

  // 1. Create WIP Checkpoint (Safeguard 2)
  app.post<{
    Params: { projectId: string };
    Body: {
      files: Array<{ relative_path: string; content: string }>;
      label?: string;
      commitMessage?: string;
      publishImmediately?: boolean;
    };
  }>('/api/v1/projects/:projectId/checkpoints/wip', async (request, reply) => {
    const tokenPayload = await authenticateProjectRequest(request, reply);
    if (!tokenPayload) return;

    const result = await checkpointService.createWipCheckpoint({
      projectId: request.params.projectId,
      userId: tokenPayload.user_id,
      files: request.body.files || [],
      label: request.body.label,
      commitMessage: request.body.commitMessage,
      publishImmediately: request.body.publishImmediately,
    });

    return { success: true, ...result };
  });

  // 2. Create Verified Integration Checkpoint (Safeguard 3)
  app.post<{
    Params: { projectId: string };
    Body: {
      files: Array<{ relative_path: string; content: string }>;
      commitMessage?: string;
      publishImmediately?: boolean;
    };
  }>('/api/v1/projects/:projectId/checkpoints/integration', async (request, reply) => {
    const tokenPayload = await authenticateProjectRequest(request, reply);
    if (!tokenPayload) return;

    const result = await checkpointService.createIntegrationCheckpoint({
      projectId: request.params.projectId,
      userId: tokenPayload.user_id,
      files: request.body.files || [],
      commitMessage: request.body.commitMessage,
      publishImmediately: request.body.publishImmediately,
    });

    return {
      success: result.checkpoint.status === CheckpointStatus.PASSED,
      ...result,
    };
  });

  // 3. List Checkpoints for project
  app.get<{
    Params: { projectId: string };
    Querystring: { kind?: CheckpointKind };
  }>('/api/v1/projects/:projectId/checkpoints', async (request, reply) => {
    const auth = await authenticateProjectRequest(request, reply);
    if (!auth) return;

    const checkpoints = await repository.listCheckpoints(
      request.params.projectId,
      request.query.kind
    );
    return {
      project_id: request.params.projectId,
      count: checkpoints.length,
      checkpoints,
    };
  });

  // 4. Get specific checkpoint
  app.get<{
    Params: { projectId: string; checkpointId: string };
  }>('/api/v1/projects/:projectId/checkpoints/:checkpointId', async (request, reply) => {
    const auth = await authenticateProjectRequest(request, reply);
    if (!auth) return;

    const checkpoint = await repository.getCheckpoint(request.params.checkpointId);
    if (!checkpoint || checkpoint.project_id !== request.params.projectId) {
      return reply.status(404).send({ error: 'Checkpoint not found' });
    }
    return { checkpoint };
  });

  // 5. Publish checkpoint to GitHub
  app.post<{
    Params: { projectId: string; checkpointId: string };
    Body: {
      files: Array<{ relative_path: string; content: string }>;
      expectedBaseSha?: string;
    };
  }>('/api/v1/projects/:projectId/checkpoints/:checkpointId/publish', async (request, reply) => {
    const auth = await authenticateProjectRequest(request, reply);
    if (!auth) return;

    const fileMap = new Map((request.body.files || []).map((f) => [f.relative_path, f.content]));
    const publishResult = await checkpointService.publishCheckpoint(
      request.params.checkpointId,
      fileMap,
      request.body.expectedBaseSha
    );

    return publishResult;
  });

  // 6. List Publishing Audit Records
  app.get<{
    Params: { projectId: string; checkpointId: string };
  }>('/api/v1/projects/:projectId/checkpoints/:checkpointId/audit', async (request, reply) => {
    const auth = await authenticateProjectRequest(request, reply);
    if (!auth) return;

    const auditRecords = await repository.listPublishingAuditRecords(
      request.params.projectId,
      request.params.checkpointId
    );
    return {
      project_id: request.params.projectId,
      checkpoint_id: request.params.checkpointId,
      audit_records: auditRecords,
      records: auditRecords,
    };
  });

  // --- Phase 5B: Antigravity MCP Endpoints ---

  // 1. JSON-RPC 2.0 Direct MCP Transport
  app.post<{
    Body: JsonRpcRequest;
  }>('/api/v1/mcp', async (request, reply) => {
    const response = await mcpServer.handleMessage(request.body);
    if (!response) {
      return reply.status(204).send();
    }
    return response;
  });

  // 2. REST Bridge for MCP Tools
  app.post<{
    Params: { projectId: string; toolName: string };
    Body: Record<string, unknown>;
  }>('/api/v1/projects/:projectId/mcp/tools/:toolName', async (request, reply) => {
    const auth = await authenticateProjectRequest(request, reply);
    if (!auth) return;

    try {
      const result = await mcpServer.executeTool(request.params.toolName, {
        ...request.body,
        project_id: request.params.projectId,
      });
      return { success: true, tool: request.params.toolName, result };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(400).send({ success: false, error: message });
    }
  });

  // Task 2 & 3: Authenticated WebSocket Gateway
  app.register(async function (fastify) {
    fastify.get('/ws', { websocket: true }, (socket, req) => {
      const url = new URL(req.url, `http://${req.hostname}`);
      const token = url.searchParams.get('token');

      if (!token) {
        socket.close(1008, 'Token query parameter missing');
        return;
      }

      let tokenPayload;
      try {
        tokenPayload = verifySessionToken(token, config.JWT_SECRET);
      } catch (err) {
        const message = err instanceof CollabError ? err.message : 'Authentication failed';
        socket.close(1008, message);
        return;
      }

      const { user_id, device_id, project_id } = tokenPayload;
      if (!project_id) {
        socket.close(1008, 'Token is not scoped to a project');
        return;
      }

      // Register connection
      connectionManager.register(socket, device_id, user_id, project_id);

      socket.on('message', async (data: string | Buffer) => {
        await wsHandler.handleMessage(socket, data);
      });

      socket.on('close', () => {
        connectionManager.unregister(socket);
      });

      socket.on('error', () => {
        connectionManager.unregister(socket);
      });
    });
  });

  return app;
}
