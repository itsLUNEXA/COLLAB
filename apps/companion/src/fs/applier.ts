/**
 * @file applier.ts
 * Atomic filesystem applier with active editing lease protection and conflict isolation.
 * Enforces Safeguard 1 & 5: Incoming remote changes to protected/diverged files are safely isolated.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import {
  FileOperationPayload,
  normalizeRelativePath,
  isPathEligibleForSync,
  IncomingChangeHandlingPolicy,
} from '@collab/protocol';
import { EchoFilter } from './echo-filter.js';
import type { ConflictCoordinator } from '../conflict/coordinator.js';

export interface ApplyResult {
  success: boolean;
  action: 'WRITTEN' | 'SHADOW_ISOLATED' | 'DELETED' | 'SKIPPED';
  targetPath: string;
  shadowPath?: string;
  error?: string;
}

export class FileApplier {
  private protectedFiles = new Map<string, { policy: IncomingChangeHandlingPolicy }>();
  public onRemoteFileApplied?: (relativePath: string, hash: string) => void;

  constructor(
    private workspaceRoot: string,
    private echoFilter: EchoFilter,
    private coordinator?: ConflictCoordinator
  ) {}

  /**
   * Registers a locally protected file path (e.g. active editing lease).
   */
  public protectFile(relativePath: string, policy: IncomingChangeHandlingPolicy): void {
    const normalized = normalizeRelativePath(relativePath);
    this.protectedFiles.set(normalized, { policy });
  }

  /**
   * Unprotects a file path when lease expires.
   */
  public unprotectFile(relativePath: string): void {
    const normalized = normalizeRelativePath(relativePath);
    this.protectedFiles.delete(normalized);
  }

  /**
   * Applies an incoming remote operation payload to the local workspace.
   */
  public async applyRemoteOperation(
    payload: FileOperationPayload,
    serverSeq: number,
    baseContent?: string | null
  ): Promise<ApplyResult> {
    const relativePath =
      payload.op_type === 'FILE_RENAME'
        ? payload.new_relative_path
        : payload.relative_path;

    const normalized = normalizeRelativePath(relativePath);

    // Safeguard 5 & 8: Explicit exclusion rules apply to inbound transfers
    if (!isPathEligibleForSync(normalized)) {
      return {
        success: false,
        action: 'SKIPPED',
        targetPath: path.join(this.workspaceRoot, normalized),
        error: `Path "${normalized}" is excluded from synchronization`,
      };
    }

    const destinationPath = path.join(this.workspaceRoot, normalized);

    // Safeguard 1: Check active file protection lease
    const protection = this.protectedFiles.get(normalized);
    if (protection && protection.policy === IncomingChangeHandlingPolicy.ISOLATE_TO_SHADOW) {
      const shadowFileName = `${normalized}.collab-remote-${serverSeq}`;
      const shadowPath = path.join(this.workspaceRoot, shadowFileName);

      if ('content' in payload && payload.content !== undefined) {
        const encoding = payload.encoding === 'base64' ? 'base64' : 'utf-8';
        await this.atomicWriteFile(shadowPath, payload.content, encoding);
        return {
          success: true,
          action: 'SHADOW_ISOLATED',
          targetPath: destinationPath,
          shadowPath,
        };
      }
    }

    try {
      if (payload.op_type === 'FILE_DELETE') {
        try {
          await fs.unlink(destinationPath);
        } catch (err: unknown) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw err;
          }
        }
        return {
          success: true,
          action: 'DELETED',
          targetPath: destinationPath,
        };
      }

      if (payload.op_type === 'FILE_RENAME') {
        const oldNormalized = normalizeRelativePath(payload.old_relative_path);
        const oldPath = path.join(this.workspaceRoot, oldNormalized);
        try {
          await fs.unlink(oldPath);
        } catch {}
      }

      if (payload.op_type === 'FILE_CREATE' || payload.op_type === 'FILE_UPDATE') {
        if (payload.content !== undefined) {
          const encoding = payload.encoding === 'base64' ? 'base64' : 'utf-8';
          const buffer = encoding === 'base64' ? Buffer.from(payload.content, 'base64') : Buffer.from(payload.content, 'utf-8');
          const contentHash = crypto.createHash('sha256').update(buffer).digest('hex');

          // If conflict coordinator is active and not binary, evaluate three-way merge
          if (this.coordinator && !payload.is_binary) {
            const conflictRes = await this.coordinator.processIncomingChange(
              payload,
              serverSeq,
              baseContent ?? null
            );

            if (conflictRes.status === 'CONFLICT_DETECTED') {
              return {
                success: true,
                action: 'SHADOW_ISOLATED',
                targetPath: destinationPath,
                shadowPath: conflictRes.conflictRecord?.shadowRemotePath,
              };
            }

            if (conflictRes.status === 'AUTO_MERGED' || conflictRes.status === 'APPLIED_CLEAN') {
              this.onRemoteFileApplied?.(normalized, contentHash);
              return {
                success: true,
                action: 'WRITTEN',
                targetPath: destinationPath,
              };
            }
          }

          // Pre-register with EchoFilter so watcher ignores the write
          this.echoFilter.registerRemoteWrite(normalized, contentHash);

          await this.atomicWriteFile(destinationPath, payload.content, encoding);
          this.onRemoteFileApplied?.(normalized, contentHash);
          return {
            success: true,
            action: 'WRITTEN',
            targetPath: destinationPath,
          };
        }
      }

      return {
        success: false,
        action: 'SKIPPED',
        targetPath: destinationPath,
        error: 'Unsupported payload or missing content in live sync plane',
      };
    } catch (err) {
      return {
        success: false,
        action: 'SKIPPED',
        targetPath: destinationPath,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Performs an atomic write by writing to a .tmp file and renaming it.
   */
  private async atomicWriteFile(
    filePath: string,
    content: string,
    encoding: 'utf-8' | 'base64' = 'utf-8'
  ): Promise<void> {
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });

    const tmpPath = `${filePath}.${Date.now()}.${Math.random().toString(36).slice(2, 7)}.tmp`;
    if (encoding === 'base64') {
      await fs.writeFile(tmpPath, Buffer.from(content, 'base64'));
    } else {
      await fs.writeFile(tmpPath, content, 'utf-8');
    }
    await fs.rename(tmpPath, filePath);
  }
}
