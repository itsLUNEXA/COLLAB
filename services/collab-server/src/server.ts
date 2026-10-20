/**
 * @file server.ts
 * Standalone server entry point.
 */

import { loadConfig } from './config.js';
import { MemorySyncRepository } from './storage/memory-sync-repository.js';
import { buildApp } from './app.js';

async function main(): Promise<void> {
  const config = loadConfig();
  
  let repository;
  if (config.NODE_ENV === 'production') {
    if (!config.DATABASE_URL) {
      throw new Error(
        'FATAL: DATABASE_URL is required in production mode. Refusing to run with in-memory fallback.'
      );
    }
    const isLocalhost = config.DATABASE_URL.includes('localhost') || config.DATABASE_URL.includes('127.0.0.1');
    const ssl = isLocalhost ? false : { rejectUnauthorized: false };
    // Dynamic import to avoid loading pg driver if not in production
    const { PostgresSyncRepository } = await import('./storage/postgres-sync-repository.js');
    const { Client } = await import('pg');
    const client = new Client({ connectionString: config.DATABASE_URL, ssl });
    await client.connect();
    repository = new PostgresSyncRepository(client);
  } else if (config.DATABASE_URL) {
    const isLocalhost = config.DATABASE_URL.includes('localhost') || config.DATABASE_URL.includes('127.0.0.1');
    const ssl = isLocalhost ? false : { rejectUnauthorized: false };
    const { PostgresSyncRepository } = await import('./storage/postgres-sync-repository.js');
    const { Client } = await import('pg');
    const client = new Client({ connectionString: config.DATABASE_URL, ssl });
    await client.connect();
    repository = new PostgresSyncRepository(client);
  } else {
    // In-memory fallback for local development without DB and automated tests
    const memoryRepo = new MemorySyncRepository();
    memoryRepo.seedProject({
      id: '11111111-1111-4111-8111-111111111111',
      team_id: 'team-hackathon',
      name: 'Collaborative AI Platform (Dev Workspace)',
      github_repo_owner: config.GITHUB_REPO_OWNER || 'itsLUNEXA',
      github_repo_name: config.GITHUB_REPO_NAME || 'COLLAB',
      github_installation_id: config.GITHUB_INSTALLATION_ID || null,
      default_branch: 'main',
      wip_branch: 'collab/wip',
      integrated_branch: 'collab/integrated',
      current_seq_num: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    repository = memoryRepo;
  }

  // GitHub Client Initialization (Mandatory Task 5)
  let githubClient;
  const hasGitHubAppConfig = Boolean(
    config.GITHUB_APP_ID &&
    config.GITHUB_INSTALLATION_ID &&
    config.GITHUB_PRIVATE_KEY_PATH
  );

  if (config.NODE_ENV === 'production') {
    if (config.GITHUB_MOCK_CLIENT) {
      throw new Error(
        'FATAL: GITHUB_MOCK_CLIENT cannot be enabled in production mode. Refusing to run with mock client.'
      );
    }
    if (!hasGitHubAppConfig) {
      throw new Error(
        'FATAL: GITHUB_APP_ID, GITHUB_INSTALLATION_ID, and GITHUB_PRIVATE_KEY_PATH are required in production mode. Refusing to run with silent mock publishing.'
      );
    }
    const { loadPrivateKeyPem } = await import('./github/key-loader.js');
    const { GitHubHttpClient } = await import('./github/http-client.js');
    const privateKeyPem = loadPrivateKeyPem(config.GITHUB_PRIVATE_KEY_PATH!);
    githubClient = new GitHubHttpClient({
      appId: config.GITHUB_APP_ID!,
      installationId: config.GITHUB_INSTALLATION_ID!,
      privateKeyPem,
      apiUrl: config.GITHUB_API_URL,
    });
  } else if (hasGitHubAppConfig && !config.GITHUB_MOCK_CLIENT) {
    try {
      const { loadPrivateKeyPem } = await import('./github/key-loader.js');
      const { GitHubHttpClient } = await import('./github/http-client.js');
      const privateKeyPem = loadPrivateKeyPem(config.GITHUB_PRIVATE_KEY_PATH!);
      githubClient = new GitHubHttpClient({
        appId: config.GITHUB_APP_ID!,
        installationId: config.GITHUB_INSTALLATION_ID!,
        privateKeyPem,
        apiUrl: config.GITHUB_API_URL,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`FATAL: Failed to initialize GitHub App integration: ${msg}`);
    }
  } else {
    const { MockGitHubClient } = await import('./github/mock-github-client.js');
    githubClient = new MockGitHubClient();
  }

  const app = buildApp({ config, repository, githubClient });

  try {
    const address = await app.listen({ port: config.PORT, host: config.HOST });
    const { GitHubHttpClient } = await import('./github/http-client.js').catch(() => ({ GitHubHttpClient: null }));
    if (GitHubHttpClient && githubClient instanceof GitHubHttpClient) {
      app.log.info(
        `[GitHub App] Active for ${config.GITHUB_REPO_OWNER}/${config.GITHUB_REPO_NAME} (Installation #${config.GITHUB_INSTALLATION_ID})`
      );
    } else {
      app.log.warn('========================================================================');
      app.log.warn('⚠️  NOTICE: RUNNING WITH IN-MEMORY MOCK GITHUB CLIENT');
      app.log.warn('Checkpoints will NOT be published to remote GitHub repositories.');
      app.log.warn('========================================================================');
    }
    if (!config.DATABASE_URL) {
      app.log.warn('========================================================================');
      app.log.warn('⚠️  NOTICE: RUNNING WITH IN-MEMORY STORAGE (Development Mode)');
      app.log.warn('Data will NOT be durable across server restarts.');
      app.log.warn('To use durable storage, configure DATABASE_URL in your .env file.');
      app.log.warn('========================================================================');
    }
    app.log.info(`Collaboration server listening on ${address}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

if (process.env.NODE_ENV !== 'test') {
  main().catch(console.error);
}
