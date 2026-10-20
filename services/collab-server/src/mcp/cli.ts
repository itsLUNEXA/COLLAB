#!/usr/bin/env node
/**
 * @file cli.ts
 * Executable CLI entrypoint for Antigravity IDE stdio MCP transport.
 * Reads JSON-RPC from stdin, outputs JSON-RPC to stdout, logs diagnostics to stderr.
 */

import { SharedContextEngine } from '../context/context-engine.js';
import { MemorySyncRepository } from '../storage/memory-sync-repository.js';
import { PostgresSyncRepository } from '../storage/postgres-sync-repository.js';
import { ISyncRepository } from '../storage/sync-repository.interface.js';
import { McpServer } from './mcp-server.js';
import pg from 'pg';

async function main() {
  let repository: ISyncRepository;

  const dbUrl = process.env.DATABASE_URL;
  if (dbUrl) {
    const pool = new pg.Pool({ connectionString: dbUrl });
    repository = new PostgresSyncRepository(pool);
    process.stderr.write('[MCP Context Engine] Connected to PostgreSQL storage.\n');
  } else {
    repository = new MemorySyncRepository();
    process.stderr.write('[MCP Context Engine] Running with high-performance in-memory repository.\n');
  }

  const defaultProjectId = process.env.COLLAB_PROJECT_ID || '11111111-1111-4111-8111-111111111111';

  if (repository instanceof MemorySyncRepository) {
    repository.seedProject({
      id: defaultProjectId,
      team_id: 'team-hackathon',
      name: process.env.COLLAB_PROJECT_NAME || 'Collaborative AI Platform',
      github_repo_owner: process.env.GITHUB_REPO_OWNER || 'org',
      github_repo_name: process.env.GITHUB_REPO_NAME || 'collaborative-ai-platform',
      github_installation_id: null,
      default_branch: 'main',
      wip_branch: 'collab/wip',
      integrated_branch: 'collab/integrated',
      current_seq_num: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    process.stderr.write(`[MCP Context Engine] Active project: ${defaultProjectId}\n`);
  }

  const contextEngine = new SharedContextEngine(repository);
  const mcpServer = new McpServer(contextEngine, async (projectId) => {
    const proj = await repository.getProject(projectId);
    return !!proj;
  });

  // Connect to standard I/O for Antigravity
  mcpServer.connectStdio(process.stdin, process.stdout);
  process.stderr.write('[MCP Context Engine] Initialized and listening on stdio.\n');
}

main().catch((err) => {
  process.stderr.write(`[MCP Context Engine Error] ${err}\n`);
  process.exit(1);
});
