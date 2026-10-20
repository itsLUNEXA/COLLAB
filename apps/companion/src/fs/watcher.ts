/**
 * @file watcher.ts
 * Native cross-platform filesystem watcher wrapping Chokidar with debouncing and echo suppression.
 * Enforces Safeguards 5, 6, and 8.
 */

import chokidar, { FSWatcher } from 'chokidar';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import {
  SyncOpType,
  FileOperationPayload,
  normalizeRelativePath,
  isPathEligibleForSync,
  isInternalDiagnosticPath,
} from '@collab/protocol';
import { EchoFilter } from './echo-filter.js';

export type LocalChangeCallback = (payload: FileOperationPayload) => void | Promise<void>;

export class WorkspaceWatcher {
  private watcher: FSWatcher | null = null;
  private debounceTimers = new Map<string, NodeJS.Timeout>();
  private knownFileHashes = new Map<string, string>(); // path -> last SHA-256

  constructor(
    private workspaceRoot: string,
    private echoFilter: EchoFilter,
    private debounceMs: number = 150
  ) {}

  /**
   * Starts monitoring the local workspace folder.
   */
  public async start(callback: LocalChangeCallback): Promise<void> {
    if (this.watcher) {
      await this.stop();
    }

    this.watcher = chokidar.watch(this.workspaceRoot, {
      ignored: (targetPath: string) => this.shouldIgnorePath(targetPath),
      persistent: true,
      ignoreInitial: true, // Don't emit for pre-existing files on startup
      awaitWriteFinish: {
        stabilityThreshold: 50,
        pollInterval: 20,
      },
    });

    this.watcher.on('add', (filePath) => this.handleFileEvent(filePath, SyncOpType.FILE_CREATE, callback));
    this.watcher.on('change', (filePath) => this.handleFileEvent(filePath, SyncOpType.FILE_UPDATE, callback));
    this.watcher.on('unlink', (filePath) => this.handleFileDelete(filePath, callback));

    await new Promise<void>((resolve) => {
      if (!this.watcher) return resolve();
      this.watcher.on('ready', () => resolve());
    });
  }

  /**
   * Registers a known hash immediately for a path (e.g. written by applier).
   */
  public registerKnownHash(relativePath: string, hash: string): void {
    try {
      const normalized = normalizeRelativePath(relativePath);
      this.knownFileHashes.set(normalized, hash);
    } catch {}
  }

  /**
   * Stops the watcher and cancels all active debounce timers.
   */
  public async stop(): Promise<void> {
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }

  private shouldIgnorePath(targetPath: string): boolean {
    const relative = path.relative(this.workspaceRoot, targetPath);
    if (!relative || relative === '.') {
      return false;
    }

    let normalized: string;
    try {
      normalized = normalizeRelativePath(relative);
    } catch {
      return true; // Ignore invalid paths
    }

    // Ignore internal diagnostic and loopback directories (Safeguard 8)
    if (isInternalDiagnosticPath(normalized)) {
      return true;
    }

    // Ignore secrets, git internals, node_modules, dist (Safeguards 5 & 8)
    if (!isPathEligibleForSync(normalized)) {
      return true;
    }

    return false;
  }

  private handleFileEvent(
    fullPath: string,
    opType: SyncOpType.FILE_CREATE | SyncOpType.FILE_UPDATE,
    callback: LocalChangeCallback
  ): void {
    const relative = path.relative(this.workspaceRoot, fullPath);
    let normalized: string;
    try {
      normalized = normalizeRelativePath(relative);
    } catch {
      return;
    }

    // Clear existing timer for this file to debounce rapid typing
    const existingTimer = this.debounceTimers.get(normalized);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(async () => {
      this.debounceTimers.delete(normalized);

      try {
        const buffer = await fs.readFile(fullPath);
        const hash = crypto.createHash('sha256').update(buffer).digest('hex');

        // Check echo suppression filter: was this write initiated by remote sync?
        if (this.echoFilter.shouldSuppress(normalized, hash)) {
          this.knownFileHashes.set(normalized, hash);
          return; // Dropped without network broadcast!
        }

        const baseHash = this.knownFileHashes.get(normalized) ?? null;

        // If content didn't change from what we already knew, ignore
        if (baseHash === hash) {
          return;
        }

        this.knownFileHashes.set(normalized, hash);

        const isBinary = buffer.includes(0);
        const encoding = isBinary ? 'base64' : 'utf-8';
        const content = isBinary ? buffer.toString('base64') : buffer.toString('utf-8');

        const isExistingFile = baseHash !== null;
        const effectiveOpType = isExistingFile ? SyncOpType.FILE_UPDATE : opType;

        const payload: FileOperationPayload = {
          op_type: effectiveOpType,
          relative_path: normalized,
          base_hash: effectiveOpType === SyncOpType.FILE_CREATE ? null : baseHash,
          target_hash: hash,
          encoding,
          content,
          file_size_bytes: buffer.byteLength,
          is_binary: isBinary,
        };

        await callback(payload);
      } catch (err: unknown) {
        // File may have been deleted while debouncing, ignore ENOENT
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          console.error(`[Watcher] Error reading ${normalized}:`, err);
        }
      }
    }, this.debounceMs);

    this.debounceTimers.set(normalized, timer);
  }

  private async handleFileDelete(fullPath: string, callback: LocalChangeCallback): Promise<void> {
    const relative = path.relative(this.workspaceRoot, fullPath);
    let normalized: string;
    try {
      normalized = normalizeRelativePath(relative);
    } catch {
      return;
    }

    const lastHash = this.knownFileHashes.get(normalized) ?? '0'.repeat(64);
    this.knownFileHashes.delete(normalized);

    const payload: FileOperationPayload = {
      op_type: SyncOpType.FILE_DELETE,
      relative_path: normalized,
      deleted_hash: lastHash,
    };

    await callback(payload);
  }
}
