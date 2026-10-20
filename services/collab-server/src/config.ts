/**
 * @file config.ts
 * Environment and runtime configuration for the collaboration server.
 */

import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

export const ServerConfigSchema = z.object({
  PORT: z.coerce.number().int().positive().default(4000),
  HOST: z.string().default('127.0.0.1'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  MAX_PAYLOAD_BYTES: z.coerce.number().int().positive().default(5 * 1024 * 1024), // 5MB
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(1000),
  JWT_SECRET: z.string().min(16).default('collab-dev-jwt-secret-minimum-32-chars-long-fallback'),
  DATABASE_URL: z.string().optional(),
  // GitHub App Integration (Requirements 3 & 5)
  GITHUB_APP_ID: z.string().optional(),
  GITHUB_INSTALLATION_ID: z.coerce.number().int().positive().optional(),
  GITHUB_PRIVATE_KEY_PATH: z.string().optional(),
  GITHUB_REPO_OWNER: z.string().optional(),
  GITHUB_REPO_NAME: z.string().optional(),
  GITHUB_API_URL: z.string().url().optional(),
  GITHUB_MOCK_CLIENT: z.coerce.boolean().optional(),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

function parseEnvFile(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) return {};
  const content = fs.readFileSync(filePath, 'utf8');
  const env: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) {
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      env[key] = val;
    }
  }
  return env;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): ServerConfig {
  // If running without pre-populated environment, try loading from .env
  const merged: Record<string, string | undefined> = { ...env };
  const candidatePaths = [
    path.resolve(process.cwd(), '.env'),
    path.resolve(process.cwd(), '..', '..', '.env'),
  ];
  for (const p of candidatePaths) {
    if (fs.existsSync(p)) {
      const fromFile = parseEnvFile(p);
      for (const [k, v] of Object.entries(fromFile)) {
        if (merged[k] === undefined) {
          merged[k] = v;
        }
      }
      break;
    }
  }
  return ServerConfigSchema.parse(merged);
}

