/**
 * @file config.ts
 * Desktop companion configuration and workspace binding.
 */

import { z } from 'zod';
import * as path from 'node:path';

export const CompanionConfigSchema = z.object({
  workspacePath: z.string().min(1),
  serverUrl: z.string().url().default('ws://127.0.0.1:4000/ws'),
  token: z.string().min(1),
  projectId: z.string().uuid(),
  deviceId: z.string().uuid(),
  userId: z.string().uuid(),
  debounceMs: z.number().int().min(50).max(2000).default(150),
  dataDirName: z.string().default('.collab'),
});

export type CompanionConfig = z.infer<typeof CompanionConfigSchema>;

export function resolveDataDir(config: CompanionConfig): string {
  return path.join(config.workspacePath, config.dataDirName);
}
