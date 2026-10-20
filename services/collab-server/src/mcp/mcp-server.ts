/**
 * @file mcp-server.ts
 * Model Context Protocol (MCP) Server for Antigravity IDE Integration.
 * Implements JSON-RPC 2.0 stdio & programmatic dispatch for shared AI context.
 */

import { MCP_TOOLS } from './protocol.js';
import { SharedContextEngine } from '../context/context-engine.js';
import { ContractType, ContractConfidenceLevel, CollabError } from '@collab/protocol';
import readline from 'node:readline';

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export class McpServer {
  constructor(
    private contextEngine: SharedContextEngine,
    private authChecker?: (projectId: string, authToken?: string) => Promise<boolean>
  ) {}

  /**
   * Dispatches a single JSON-RPC message and returns the response.
   */
  public async handleMessage(rawMessage: string | JsonRpcRequest): Promise<JsonRpcResponse | null> {
    let req: JsonRpcRequest;
    if (typeof rawMessage === 'string') {
      try {
        req = JSON.parse(rawMessage);
      } catch {
        return {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'Parse error: Invalid JSON' },
        };
      }
    } else {
      req = rawMessage;
    }

    if (!req || req.jsonrpc !== '2.0' || typeof req.method !== 'string') {
      return {
        jsonrpc: '2.0',
        id: req?.id ?? null,
        error: { code: -32600, message: 'Invalid Request: jsonrpc must be "2.0" and method is required' },
      };
    }

    // Notifications (no id) do not produce responses
    const isNotification = req.id === undefined || req.id === null;
    const reqId = req.id ?? null;

    try {
      switch (req.method) {
        case 'initialize': {
          return {
            jsonrpc: '2.0',
            id: reqId,
            result: {
              protocolVersion: '2024-11-05',
              capabilities: {
                tools: {},
              },
              serverInfo: {
                name: 'collab-mcp-context-engine',
                version: '0.1.0',
              },
            },
          };
        }

        case 'notifications/initialized': {
          return null; // Acknowledgment of initialization
        }

        case 'tools/list': {
          return {
            jsonrpc: '2.0',
            id: reqId,
            result: {
              tools: MCP_TOOLS,
            },
          };
        }

        case 'tools/call': {
          const params = req.params as { name?: string; arguments?: Record<string, unknown> } | undefined;
          if (!params || !params.name) {
            return {
              jsonrpc: '2.0',
              id: reqId,
              error: { code: -32602, message: 'Invalid params: "name" is required for tools/call' },
            };
          }

          const args = params.arguments || {};
          const toolResult = await this.executeTool(params.name, args);

          return {
            jsonrpc: '2.0',
            id: reqId,
            result: {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(toolResult, null, 2),
                },
              ],
            },
          };
        }

        default: {
          if (isNotification) return null;
          return {
            jsonrpc: '2.0',
            id: reqId,
            error: { code: -32601, message: `Method not found: ${req.method}` },
          };
        }
      }
    } catch (err: unknown) {
      if (isNotification) return null;
      const message = err instanceof Error ? err.message : String(err);
      return {
        jsonrpc: '2.0',
        id: reqId,
        error: {
          code: err instanceof CollabError ? -32000 : -32603,
          message,
        },
      };
    }
  }

  /**
   * Executes an MCP tool by name.
   */
  public async executeTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    const projectId = String(args.project_id || '');
    if (!projectId) {
      throw new Error('Missing required argument: project_id');
    }

    // Requirement 5: Project-level authorization check
    if (this.authChecker) {
      const isAuthorized = await this.authChecker(projectId, args._auth_token as string | undefined);
      if (!isAuthorized) {
        throw new Error(`Unauthorized: Caller lacks permission for project '${projectId}'`);
      }
    }

    switch (toolName) {
      case 'get_project_context': {
        return this.contextEngine.getProjectContext(projectId);
      }

      case 'get_api_contract': {
        const identifier = String(args.identifier || '');
        if (!identifier) throw new Error('Missing required argument: identifier');
        const version = typeof args.version === 'number' ? args.version : undefined;
        return this.contextEngine.getApiContract(projectId, identifier, version);
      }

      case 'publish_api_contract': {
        return this.contextEngine.publishApiContract({
          projectId,
          deviceId: String(args.device_id || ''),
          identifier: String(args.identifier || ''),
          contractType: args.contract_type as ContractType,
          ownerModule: String(args.owner_module || ''),
          schemaDefinition: (args.schema_definition as Record<string, unknown>) || {},
          supportedLanguageFramework: String(args.supported_language_framework || ''),
          confidence: args.confidence as ContractConfidenceLevel | undefined,
        });
      }

      case 'get_recent_changes': {
        const limit = typeof args.limit === 'number' ? args.limit : 20;
        const fromSeq = typeof args.from_seq === 'number' ? args.from_seq : 0;
        return this.contextEngine.getRecentChanges(projectId, limit, fromSeq);
      }

      case 'record_project_decision': {
        return this.contextEngine.recordProjectDecision({
          projectId,
          userId: String(args.user_id || ''),
          title: String(args.title || ''),
          rationale: String(args.rationale || ''),
          tags: Array.isArray(args.tags) ? (args.tags as string[]) : undefined,
        });
      }

      case 'claim_module_intent': {
        return this.contextEngine.claimModuleIntent({
          projectId,
          deviceId: String(args.device_id || ''),
          userId: String(args.user_id || ''),
          moduleName: String(args.module_name || ''),
          intentDescription: String(args.intent_description || ''),
          ttlMinutes: typeof args.ttl_minutes === 'number' ? args.ttl_minutes : undefined,
        });
      }

      case 'verify_integration_status': {
        return this.contextEngine.verifyIntegrationStatus(projectId);
      }

      default: {
        throw new Error(`Unknown tool: ${toolName}`);
      }
    }
  }

  /**
   * Connects the MCP server to stdio streams for Antigravity IDE integration.
   */
  public connectStdio(
    inStream: NodeJS.ReadableStream = process.stdin,
    outStream: NodeJS.WritableStream = process.stdout
  ): void {
    const rl = readline.createInterface({
      input: inStream,
      terminal: false,
    });

    rl.on('line', async (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      const response = await this.handleMessage(trimmed);
      if (response) {
        outStream.write(`${JSON.stringify(response)}\n`);
      }
    });
  }
}
