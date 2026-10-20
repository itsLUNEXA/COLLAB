/**
 * @file mcp-context-engine.test.ts
 * Targeted test suite for Phase 5B: Shared AI Context & Antigravity MCP Integration.
 * Covers MCP initialization, dual-agent context retrieval, breaking contract diffing,
 * stale-consumer warnings, module ownership intents, and project authorization.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { MemorySyncRepository } from '../storage/memory-sync-repository.js';
import { SharedContextEngine } from '../context/context-engine.js';
import { McpServer } from '../mcp/mcp-server.js';
import { createSessionToken } from '../auth/token.js';
import { ContractType } from '@collab/protocol';

describe('Phase 5B: Shared AI Context & Antigravity MCP', () => {
  let app: FastifyInstance;
  let repository: MemorySyncRepository;
  let contextEngine: SharedContextEngine;
  let mcpServer: McpServer;

  const jwtSecret = 'test-secret-key-that-is-at-least-32-chars-long';
  const projectId = '55555555-5555-4555-8555-555555555555';

  const userMaheenId = '11111111-1111-4111-8111-111111111111';
  const deviceMaheenId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  const userShivamId = '22222222-2222-4222-8222-222222222222';
  const deviceShivamId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  let tokenMaheen: string;
  let tokenShivam: string;

  beforeAll(async () => {
    repository = new MemorySyncRepository();
    contextEngine = new SharedContextEngine(repository);

    repository.seedProject({
      id: projectId,
      team_id: 'team-hackathon',
      name: 'Collaborative AI IDE',
      github_repo_owner: 'org',
      github_repo_name: 'hackathon-app',
      github_installation_id: null,
      default_branch: 'main',
      wip_branch: 'collab/wip',
      integrated_branch: 'collab/integrated',
      current_seq_num: 50,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    mcpServer = new McpServer(contextEngine, async (projId) => {
      const p = await repository.getProject(projId);
      return !!p;
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

    tokenMaheen = createSessionToken({ user_id: userMaheenId, device_id: deviceMaheenId, project_id: projectId }, jwtSecret);
    tokenShivam = createSessionToken({ user_id: userShivamId, device_id: deviceShivamId, project_id: projectId }, jwtSecret);
  });

  afterAll(async () => {
    await app.close();
  });

  it('Requirement 1: Initializes MCP protocol and lists all 7 tools', async () => {
    const initRes = await mcpServer.handleMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {},
    });

    expect(initRes?.result).toBeDefined();
    const initData = initRes!.result as { protocolVersion: string; serverInfo: { name: string } };
    expect(initData.protocolVersion).toBe('2024-11-05');
    expect(initData.serverInfo.name).toBe('collab-mcp-context-engine');

    const toolsRes = await mcpServer.handleMessage({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    });

    const toolsData = toolsRes!.result as { tools: Array<{ name: string }> };
    expect(toolsData.tools).toHaveLength(7);
    const toolNames = toolsData.tools.map((t) => t.name);
    expect(toolNames).toContain('get_project_context');
    expect(toolNames).toContain('get_api_contract');
    expect(toolNames).toContain('publish_api_contract');
    expect(toolNames).toContain('get_recent_changes');
    expect(toolNames).toContain('record_project_decision');
    expect(toolNames).toContain('claim_module_intent');
    expect(toolNames).toContain('verify_integration_status');
  });

  it('Criteria 1: Two separate agent clients retrieve the same authoritative project context', async () => {
    // Agent A (Maheen) calls get_project_context
    const resA = await mcpServer.handleMessage({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'get_project_context',
        arguments: { project_id: projectId },
      },
    });

    // Agent B (Shivam) calls get_project_context
    const resB = await mcpServer.handleMessage({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'get_project_context',
        arguments: { project_id: projectId },
      },
    });

    expect(resA?.result).toBeDefined();
    expect(resB?.result).toBeDefined();

    const dataA = JSON.parse(((resA!.result as { content: Array<{ text: string }> }).content[0].text));
    const dataB = JSON.parse(((resB!.result as { content: Array<{ text: string }> }).content[0].text));

    expect(dataA.project.id).toBe(projectId);
    expect(dataB.project.id).toBe(projectId);
    expect(dataA.project.name).toBe('Collaborative AI IDE');
    expect(dataA.project.current_seq_num).toBe(50);
    expect(dataB.project.current_seq_num).toBe(50);
    expect(dataA.freshness).toEqual(dataB.freshness);
  });

  it('Criteria 3: Module intent declarations provide collision warnings when teammates overlap', async () => {
    // 1. Maheen's agent claims backend-auth
    const claimARes = await mcpServer.handleMessage({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: {
        name: 'claim_module_intent',
        arguments: {
          project_id: projectId,
          device_id: deviceMaheenId,
          user_id: userMaheenId,
          module_name: 'backend-auth',
          intent_description: 'Implementing OAuth callback handler',
        },
      },
    });

    const dataA = JSON.parse(((claimARes!.result as { content: Array<{ text: string }> }).content[0].text));
    expect(dataA.hasCollisionWarning).toBe(false);
    expect(dataA.intent.module_name).toBe('backend-auth');

    // 2. Shivam's agent attempts to claim the same module backend-auth -> collision warning!
    const claimBRes = await mcpServer.handleMessage({
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: {
        name: 'claim_module_intent',
        arguments: {
          project_id: projectId,
          device_id: deviceShivamId,
          user_id: userShivamId,
          module_name: 'backend-auth',
          intent_description: 'Modifying auth routes',
        },
      },
    });

    const dataB = JSON.parse(((claimBRes!.result as { content: Array<{ text: string }> }).content[0].text));
    expect(dataB.hasCollisionWarning).toBe(true);
    expect(dataB.collisionWarningMessage).toContain(deviceMaheenId);

    // 3. Shivam claims frontend-auth -> no collision
    const claimCRes = await mcpServer.handleMessage({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: {
        name: 'claim_module_intent',
        arguments: {
          project_id: projectId,
          device_id: deviceShivamId,
          user_id: userShivamId,
          module_name: 'frontend-auth',
          intent_description: 'Building login modal',
        },
      },
    });
    const dataC = JSON.parse(((claimCRes!.result as { content: Array<{ text: string }> }).content[0].text));
    expect(dataC.hasCollisionWarning).toBe(false);
  });

  it('Criteria 2 & Requirement 4: Contract updates produce new versions and flag stale consumers on breaking changes', async () => {
    const contractIdentifier = 'POST /api/v1/users';

    // 1. Publish Version 1 of Contract
    const v1Schema = {
      openapi: '3.1.0',
      paths: {
        '/api/v1/users': {
          post: {
            responses: {
              '200': {
                description: 'User profile',
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: {
                        id: { type: 'string' },
                        email: { type: 'string' },
                        username: { type: 'string' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };

    const pub1Res = await mcpServer.handleMessage({
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: {
        name: 'publish_api_contract',
        arguments: {
          project_id: projectId,
          device_id: deviceMaheenId,
          identifier: contractIdentifier,
          contract_type: ContractType.OPENAPI_ENDPOINT,
          owner_module: 'backend-users',
          schema_definition: v1Schema,
          supported_language_framework: 'OpenAPI 3.1.x',
        },
      },
    });

    const pub1Data = JSON.parse(((pub1Res!.result as { content: Array<{ text: string }> }).content[0].text));
    expect(pub1Data.version.version).toBe(1);

    // 2. Register dependent consumer module frontend-users
    await repository.saveModuleDependency({
      id: 'dep-1',
      project_id: projectId,
      consumer_module: 'frontend-users',
      contract_id: pub1Data.contract.id,
      last_verified_version: 1,
      is_stale: false,
      stale_reason: null,
      updated_at: new Date().toISOString(),
    });

    // 3. Publish Version 2 with breaking change (field 'username' removed from 200 response)
    const v2Schema = {
      openapi: '3.1.0',
      paths: {
        '/api/v1/users': {
          post: {
            responses: {
              '200': {
                description: 'User profile',
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: {
                        id: { type: 'string' },
                        email: { type: 'string' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };

    const pub2Res = await mcpServer.handleMessage({
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: {
        name: 'publish_api_contract',
        arguments: {
          project_id: projectId,
          device_id: deviceMaheenId,
          identifier: contractIdentifier,
          contract_type: ContractType.OPENAPI_ENDPOINT,
          owner_module: 'backend-users',
          schema_definition: v2Schema,
          supported_language_framework: 'OpenAPI 3.1.x',
        },
      },
    });

    const pub2Data = JSON.parse(((pub2Res!.result as { content: Array<{ text: string }> }).content[0].text));
    expect(pub2Data.version.version).toBe(2);
    expect(pub2Data.breakingChanges.length).toBeGreaterThan(0);
    expect(pub2Data.staleConsumersAffected).toBe(1);

    // 4. Verify get_api_contract reflects stale status for consumer
    const getRes = await mcpServer.handleMessage({
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: {
        name: 'get_api_contract',
        arguments: { project_id: projectId, identifier: contractIdentifier },
      },
    });

    const getData = JSON.parse(((getRes!.result as { content: Array<{ text: string }> }).content[0].text));
    expect(getData.contract.current_version).toBe(2);
    expect(getData.consumers[0].is_stale).toBe(true);
    expect(getData.consumers[0].stale_reason).toContain('Breaking change');

    // 5. Verify verify_integration_status flags integration blockage
    const verifyRes = await mcpServer.handleMessage({
      jsonrpc: '2.0',
      id: 11,
      method: 'tools/call',
      params: {
        name: 'verify_integration_status',
        arguments: { project_id: projectId },
      },
    });
    const verifyData = JSON.parse(((verifyRes!.result as { content: Array<{ text: string }> }).content[0].text));
    expect(verifyData.ready_to_publish).toBe(false);
    expect(verifyData.stale_consumers.length).toBe(1);
    expect(verifyData.blocking_reasons[0]).toContain('stale, unverified contracts');
  });

  it('Criteria 4: Rejects unauthorized access and non-existent projects', async () => {
    const invalidProjectId = '00000000-0000-4000-8000-000000000000';

    const res = await mcpServer.handleMessage({
      jsonrpc: '2.0',
      id: 12,
      method: 'tools/call',
      params: {
        name: 'get_project_context',
        arguments: { project_id: invalidProjectId },
      },
    });

    expect(res?.error).toBeDefined();
    expect(res!.error!.message).toContain('Unauthorized');
  });

  it('Requirement 8: Existing checkpoint and Fastify REST routes operate concurrently without regressions', async () => {
    // Record a decision via REST tool bridge using tokenMaheen
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/mcp/tools/record_project_decision`,
      headers: { authorization: `Bearer ${tokenMaheen}` },
      payload: {
        user_id: userMaheenId,
        title: 'Use RS256 for GitHub App Tokens',
        rationale: 'Required by GitHub App API standards',
        tags: ['security', 'github'],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.success).toBe(true);
    expect(body.result.title).toBe('Use RS256 for GitHub App Tokens');

    // Shivam queries recent changes via REST bridge using tokenShivam
    const changesRes = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/mcp/tools/get_recent_changes`,
      headers: { authorization: `Bearer ${tokenShivam}` },
      payload: { limit: 10 },
    });
    expect(changesRes.statusCode).toBe(200);

    // Verify recent decisions in project context
    const context = await contextEngine.getProjectContext(projectId);
    expect(context.recent_decisions.length).toBeGreaterThan(0);
    expect(context.recent_decisions[0].title).toBe('Use RS256 for GitHub App Tokens');
  });
});
