/**
 * @file protocol.ts
 * Model Context Protocol (MCP) tool schemas and JSON-RPC 2.0 types.
 */

export interface McpToolParameterProperty {
  type: string;
  description?: string;
  enum?: string[];
  items?: { type: string };
  default?: unknown;
}

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, McpToolParameterProperty>;
    required: string[];
  };
}

export const MCP_TOOLS: McpToolDefinition[] = [
  {
    name: 'get_project_context',
    description:
      'Retrieves authoritative shared project context including active contracts, current module intents, tasks, decisions, and system freshness.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'UUID of the collaborative project' },
      },
      required: ['project_id'],
    },
  },
  {
    name: 'get_api_contract',
    description:
      'Retrieves an active or versioned API contract definition, its JSON/YAML schema, and consumer staleness indicators.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'UUID of the collaborative project' },
        identifier: { type: 'string', description: 'Unique contract identifier (e.g. POST /api/v1/auth/login)' },
        version: { type: 'number', description: 'Optional specific integer version. Defaults to latest.' },
      },
      required: ['project_id', 'identifier'],
    },
  },
  {
    name: 'publish_api_contract',
    description:
      'Publishes or updates an API contract, detects breaking changes across versions, and automatically flags dependent consumer modules as stale.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'UUID of the collaborative project' },
        device_id: { type: 'string', description: 'Device ID of the publishing agent' },
        identifier: { type: 'string', description: 'Unique contract identifier' },
        contract_type: {
          type: 'string',
          enum: ['OPENAPI_ENDPOINT', 'JSON_SCHEMA', 'TYPESCRIPT_INTERFACE', 'DATABASE_SCHEMA', 'ENV_SPECIFICATION'],
          description: 'Type of contract',
        },
        owner_module: { type: 'string', description: 'Module owning this contract (e.g. backend-auth)' },
        schema_definition: { type: 'object', description: 'Parsed schema object or OpenAPI document' },
        supported_language_framework: { type: 'string', description: 'e.g. OpenAPI 3.1.x, TypeScript 5.x' },
        confidence: {
          type: 'string',
          enum: ['VERIFIED_EXPLICIT', 'INFERRED_HIGH', 'INFERRED_UNCERTAIN'],
          description: 'Contract confidence level',
        },
      },
      required: ['project_id', 'device_id', 'identifier', 'contract_type', 'owner_module', 'schema_definition', 'supported_language_framework'],
    },
  },
  {
    name: 'get_recent_changes',
    description:
      'Returns recent file changes and checkpoints across all teammates to maintain agent situational awareness.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'UUID of the collaborative project' },
        limit: { type: 'number', description: 'Maximum number of recent events to return (max 100)' },
        from_seq: { type: 'number', description: 'Starting sequence number' },
      },
      required: ['project_id'],
    },
  },
  {
    name: 'record_project_decision',
    description:
      'Records an architectural, API, or integration decision in shared persistent memory for all teammates and agents.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'UUID of the collaborative project' },
        user_id: { type: 'string', description: 'Authoring user UUID' },
        title: { type: 'string', description: 'Short summary of the decision' },
        rationale: { type: 'string', description: 'Detailed rationale and context' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags for categorization' },
      },
      required: ['project_id', 'user_id', 'title', 'rationale'],
    },
  },
  {
    name: 'claim_module_intent',
    description:
      'Declares that an agent is actively working on a specific module or feature, providing collision warnings if another teammate is working on it.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'UUID of the collaborative project' },
        device_id: { type: 'string', description: 'Device UUID of the claiming agent' },
        user_id: { type: 'string', description: 'User UUID of the claiming agent' },
        module_name: { type: 'string', description: 'Module identifier (e.g. backend-auth, frontend-billing)' },
        intent_description: { type: 'string', description: 'What the agent is implementing or modifying' },
        ttl_minutes: { type: 'number', description: 'Time-to-live in minutes (default 120)' },
      },
      required: ['project_id', 'device_id', 'user_id', 'module_name', 'intent_description'],
    },
  },
  {
    name: 'verify_integration_status',
    description:
      'Checks overall system integration health, checking for active conflicts, stale consumer contracts, and checkpoint status.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'UUID of the collaborative project' },
      },
      required: ['project_id'],
    },
  },
];
