#!/usr/bin/env node
/**
 * @file cli.ts
 * Executable CLI entrypoint for @collab/companion desktop sync daemon.
 * Watches local files and syncs real-time changes with the collab-server.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { EchoFilter } from './fs/echo-filter.js';
import { FileApplier } from './fs/applier.js';
import { LocalOutbox } from './storage/outbox.js';
import { SyncClient } from './sync/client.js';
import { ConflictCoordinator } from './conflict/coordinator.js';
import { WorkspaceWatcher } from './fs/watcher.js';
import { CompanionConfig } from './config.js';

function parseArgs(): Record<string, string> {
  const args = process.argv.slice(2);
  const parsed: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        parsed[key] = next;
        i++;
      } else {
        parsed[key] = 'true';
      }
    }
  }
  return parsed;
}

async function fetchToken(
  serverHttpUrl: string,
  payload: { userId: string; deviceId: string; projectId: string; deviceSecret?: string }
): Promise<string> {
  const res = await fetch(`${serverHttpUrl}/api/v1/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`Failed to obtain auth token: ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as { token: string };
  return data.token;
}

async function main() {
  const cliArgs = parseArgs();

  if (cliArgs.help || cliArgs.h) {
    console.log(`
COLLAB Companion Sync Daemon
Usage:
  collab-companion [options]

Options:
  --workspace <path>     Workspace directory to sync (default: cwd)
  --server <url>         WebSocket server URL (default: ws://127.0.0.1:4000/ws)
  --project-id <uuid>    Project ID to bind (default: 11111111-1111-4111-8111-111111111111)
  --device-id <uuid>     Device ID (default: read from or saved to .collab/device_id)
  --secret <secret>      Device secret for authenticated token issuance
  --user-id <uuid>       User ID (default: 00000000-0000-4000-8000-000000000002)
  --token <jwt>          Session token (auto-fetched from server if omitted)
  --debounce <ms>        Debounce window in ms (default: 150)
    `);
    process.exit(0);
  }

  const workspacePath = path.resolve(cliArgs.workspace || process.env.COLLAB_WORKSPACE_PATH || process.cwd());
  const serverWsUrl = cliArgs.server || process.env.COLLAB_SERVER_URL || 'ws://127.0.0.1:4000/ws';
  const projectId = cliArgs['project-id'] || process.env.COLLAB_PROJECT_ID || '11111111-1111-4111-8111-111111111111';
  const userId = cliArgs['user-id'] || process.env.COLLAB_USER_ID || '00000000-0000-4000-8000-000000000002';
  const deviceSecret = cliArgs.secret || cliArgs['device-secret'] || process.env.COLLAB_DEVICE_SECRET;
  const debounceMs = parseInt(cliArgs.debounce || '150', 10);

  const collabDir = path.join(workspacePath, '.collab');
  if (!fs.existsSync(collabDir)) {
    fs.mkdirSync(collabDir, { recursive: true });
  }

  const deviceIdFile = path.join(collabDir, 'device_id');
  let deviceId = cliArgs['device-id'] || process.env.COLLAB_DEVICE_ID;
  if (!deviceId) {
    if (fs.existsSync(deviceIdFile)) {
      deviceId = fs.readFileSync(deviceIdFile, 'utf8').trim();
    } else {
      deviceId = crypto.randomUUID();
      fs.writeFileSync(deviceIdFile, deviceId, 'utf8');
    }
  }

  let token = cliArgs.token || process.env.COLLAB_TOKEN;
  if (!token) {
    // Derive HTTP URL from WebSocket URL
    const httpUrl = serverWsUrl.replace(/^ws:\/\//, 'http://').replace(/^wss:\/\//, 'https://').replace(/\/ws\/?$/, '');
    try {
      token = await fetchToken(httpUrl, { userId, deviceId, projectId, deviceSecret });
    } catch (err: unknown) {
      console.warn(`[Companion] Warning: Could not auto-fetch token from ${httpUrl}: ${err instanceof Error ? err.message : String(err)}`);
      token = 'collab-dev-token-fallback';
    }
  }

  const config: CompanionConfig = {
    workspacePath,
    serverUrl: serverWsUrl,
    token,
    projectId,
    deviceId,
    userId,
    debounceMs,
    dataDirName: '.collab',
  };

  console.log(`[Companion] ========================================`);
  console.log(`[Companion] Workspace: ${workspacePath}`);
  console.log(`[Companion] Server:    ${serverWsUrl}`);
  console.log(`[Companion] Project:   ${projectId}`);
  console.log(`[Companion] Device:    ${deviceId}`);
  console.log(`[Companion] ========================================`);

  const echoFilter = new EchoFilter(5000);
  const coordinator = new ConflictCoordinator(workspacePath, echoFilter);
  const applier = new FileApplier(workspacePath, echoFilter, coordinator);
  const outbox = new LocalOutbox(path.join(workspacePath, '.collab'));
  await outbox.init();

  const watcher = new WorkspaceWatcher(workspacePath, echoFilter, debounceMs);
  applier.onRemoteFileApplied = (p, h) => watcher.registerKnownHash(p, h);
  const client = new SyncClient(config, outbox, applier);

  await watcher.start(async (payload) => {
    const targetPath = 'relative_path' in payload ? payload.relative_path : payload.new_relative_path;
    console.log(`[Companion] Local change detected: ${payload.op_type} ${targetPath}`);
    await client.sendLocalChange(payload);
  });

  await client.connect();
  console.log(`[Companion] Connected and listening for file changes...`);

  const shutdown = async () => {
    console.log(`\n[Companion] Shutting down sync daemon...`);
    await watcher.stop();
    client.disconnect();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[Companion Fatal Error]', err);
  process.exit(1);
});
