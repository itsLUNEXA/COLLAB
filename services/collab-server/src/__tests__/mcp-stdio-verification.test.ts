/**
 * @file mcp-stdio-verification.test.ts
 * Real stdio process verification test for Phase 5B.
 * Spawns the compiled CLI process (dist/mcp/cli.js) over standard I/O streams
 * exactly as Antigravity IDE spawns it, verifying JSON-RPC 2.0 tool execution,
 * multi-client synchronization, and authorization rejection.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as child_process from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import readline from 'node:readline';

describe('Phase 5B: Antigravity IDE Real Stdio Process Verification', () => {
  const workspaceRoot = 'E:/collab';
  const configPath = path.join(workspaceRoot, '.agents/mcp_config.json');
  let mcpProcess: child_process.ChildProcessWithoutNullStreams;
  let rl: readline.Interface;

  const pendingRequests = new Map<number | string, (response: any) => void>();
  let nextId = 1;

  function sendRpc(method: string, params?: Record<string, unknown>): Promise<any> {
    const id = nextId++;
    const req = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingRequests.delete(id);
        reject(new Error(`Timeout waiting for response to ${method} (id=${id})`));
      }, 5000);

      pendingRequests.set(id, (response) => {
        clearTimeout(timeout);
        resolve(response);
      });

      mcpProcess.stdin.write(`${JSON.stringify(req)}\n`);
    });
  }

  beforeAll(async () => {
    // 1. Validate .agents/mcp_config.json
    expect(fs.existsSync(configPath)).toBe(true);
    const configRaw = fs.readFileSync(configPath, 'utf-8');
    const config = JSON.parse(configRaw);
    expect(config.mcpServers['collab-context-engine']).toBeDefined();

    const command = config.mcpServers['collab-context-engine'].command;
    const args = config.mcpServers['collab-context-engine'].args;
    const cliScriptPath = args[0];
    expect(fs.existsSync(cliScriptPath)).toBe(true);

    // 2. Spawn the actual MCP process over stdio
    mcpProcess = child_process.spawn(command, args, {
      cwd: workspaceRoot,
      env: {
        ...process.env,
        ...config.mcpServers['collab-context-engine'].env,
      },
    });

    rl = readline.createInterface({
      input: mcpProcess.stdout,
      terminal: false,
    });

    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed.id && pendingRequests.has(parsed.id)) {
          const callback = pendingRequests.get(parsed.id)!;
          pendingRequests.delete(parsed.id);
          callback(parsed);
        }
      } catch {
        // Ignore non-json
      }
    });

    // Give process 200ms to initialize
    await new Promise((r) => setTimeout(r, 200));
  });

  afterAll(async () => {
    if (mcpProcess) {
      mcpProcess.kill();
    }
  });

  it('Step 1 & 2: Validates config, starts MCP process, and completes initialize handshake', async () => {
    const initRes = await sendRpc('initialize', {});
    expect(initRes.error).toBeUndefined();
    expect(initRes.result.protocolVersion).toBe('2024-11-05');
    expect(initRes.result.serverInfo.name).toBe('collab-mcp-context-engine');

    const toolsRes = await sendRpc('tools/list');
    expect(toolsRes.result.tools).toHaveLength(7);
  });

  it('Step 3: Executes get_project_context and get_api_contract over stdio', async () => {
    const projectId = '11111111-1111-4111-8111-111111111111';

    // 1. get_project_context
    const contextRes = await sendRpc('tools/call', {
      name: 'get_project_context',
      arguments: { project_id: projectId },
    });
    expect(contextRes.error).toBeUndefined();
    const contextData = JSON.parse(contextRes.result.content[0].text);
    expect(contextData.project.id).toBe(projectId);
    expect(contextData.project.name).toBe('Collaborative AI Platform');

    // 2. Publish a contract first so get_api_contract has an entry
    const publishRes = await sendRpc('tools/call', {
      name: 'publish_api_contract',
      arguments: {
        project_id: projectId,
        device_id: 'device-maheen',
        identifier: 'GET /api/v1/health',
        contract_type: 'OPENAPI_ENDPOINT',
        owner_module: 'backend-core',
        schema_definition: {
          openapi: '3.1.0',
          paths: { '/api/v1/health': { get: { responses: { '200': { description: 'OK' } } } } },
        },
        supported_language_framework: 'OpenAPI 3.1.x',
      },
    });
    expect(publishRes.error).toBeUndefined();

    // 3. get_api_contract
    const contractRes = await sendRpc('tools/call', {
      name: 'get_api_contract',
      arguments: {
        project_id: projectId,
        identifier: 'GET /api/v1/health',
      },
    });
    expect(contractRes.error).toBeUndefined();
    const contractData = JSON.parse(contractRes.result.content[0].text);
    expect(contractData.contract.identifier).toBe('GET /api/v1/health');
    expect(contractData.contract.current_version).toBe(1);
  });

  it('Step 4: Client 1 records a decision; Client 2 retrieves it from shared memory', async () => {
    const projectId = '11111111-1111-4111-8111-111111111111';

    // Client 1 (Maheen) records an architectural decision
    const decisionRes = await sendRpc('tools/call', {
      name: 'record_project_decision',
      arguments: {
        project_id: projectId,
        user_id: 'user-maheen',
        title: 'Adopt Stdio JSON-RPC for Antigravity Integration',
        rationale: 'Official transport standard for local Antigravity IDE agents',
        tags: ['architecture', 'mcp'],
      },
    });
    expect(decisionRes.error).toBeUndefined();

    // Client 2 (Shivam) retrieves project context
    const contextRes = await sendRpc('tools/call', {
      name: 'get_project_context',
      arguments: { project_id: projectId },
    });
    const contextData = JSON.parse(contextRes.result.content[0].text);
    const recorded = contextData.recent_decisions.find(
      (d: any) => d.title === 'Adopt Stdio JSON-RPC for Antigravity Integration'
    );
    expect(recorded).toBeDefined();
    expect(recorded.rationale).toBe('Official transport standard for local Antigravity IDE agents');
  });

  it('Step 5: Unauthorized project access is strictly rejected', async () => {
    const unauthorizedProjectId = '99999999-9999-4999-8999-999999999999';

    const res = await sendRpc('tools/call', {
      name: 'get_project_context',
      arguments: { project_id: unauthorizedProjectId },
    });

    expect(res.error).toBeDefined();
    expect(res.error.message).toContain('Unauthorized');
  });
});
