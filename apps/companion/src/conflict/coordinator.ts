/**
 * @file coordinator.ts
 * Companion Conflict Coordinator & Three-Way Merge Handler.
 * Enforces Tasks 1, 2, 3, 5, 7, 8: Auto-merges non-overlapping edits, isolates collisions,
 * executes resolution workflows, and cleans up conflict shadow files.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import {
  FileOperationPayload,
  threeWayMerge,
  normalizeRelativePath,
  ConflictStatus,
} from '@collab/protocol';
import { EchoFilter } from '../fs/echo-filter.js';

export interface LocalConflictRecord {
  id: string;
  relativePath: string;
  serverSeq: number;
  baseHash: string | null;
  remoteHash: string;
  detectedAt: string;
  status: ConflictStatus;
  shadowRemotePath: string;
  shadowBasePath?: string;
}

export type ConflictResolutionAction =
  | { type: 'KEEP_LOCAL' }
  | { type: 'ACCEPT_REMOTE' }
  | { type: 'MERGE_MANUAL'; mergedContent: string };

export class ConflictCoordinator {
  private activeConflicts = new Map<string, LocalConflictRecord>(); // key: normalized relativePath
  private lastCleanContent = new Map<string, string>(); // path -> last known synchronized clean content

  constructor(
    private workspaceRoot: string,
    private echoFilter: EchoFilter
  ) {}

  /**
   * Sets or updates last known clean content for a path (e.g. on initial sync).
   */
  public registerCleanContent(relativePath: string, content: string): void {
    const normalized = normalizeRelativePath(relativePath);
    this.lastCleanContent.set(normalized, content);
  }

  /**
   * Evaluates an incoming remote operation against the local file version.
   * Auto-merges non-overlapping edits; isolates collisions without destroying local work.
   */
  public async processIncomingChange(
    payload: FileOperationPayload,
    serverSeq: number,
    baseContent?: string | null
  ): Promise<{
    status: 'APPLIED_CLEAN' | 'AUTO_MERGED' | 'CONFLICT_DETECTED' | 'SKIPPED';
    mergedContent?: string;
    conflictRecord?: LocalConflictRecord;
  }> {
    if (payload.op_type !== 'FILE_CREATE' && payload.op_type !== 'FILE_UPDATE') {
      return { status: 'SKIPPED' };
    }

    const relativePath = payload.relative_path;

    const normalized = normalizeRelativePath(relativePath);
    const localFilePath = path.join(this.workspaceRoot, normalized);

    let localContent: string | null = null;
    try {
      localContent = await fs.readFile(localFilePath, 'utf-8');
    } catch {
      localContent = null;
    }

    const remoteContent = payload.content ?? '';

    // If file does not exist locally, no conflict possible -> clean write
    if (localContent === null) {
      this.lastCleanContent.set(normalized, remoteContent);
      await this.atomicWrite(localFilePath, remoteContent);
      return { status: 'APPLIED_CLEAN', mergedContent: remoteContent };
    }

    // Check if local matches remote base_hash (meaning local has had no un-synced edits since remote branched)
    const localHash = crypto.createHash('sha256').update(localContent).digest('hex');
    if (payload.base_hash && localHash === payload.base_hash) {
      this.lastCleanContent.set(normalized, remoteContent);
      await this.atomicWrite(localFilePath, remoteContent);
      return { status: 'APPLIED_CLEAN', mergedContent: remoteContent };
    }

    // If local matches baseContent directly
    if (baseContent !== null && baseContent !== undefined && localContent === baseContent) {
      this.lastCleanContent.set(normalized, remoteContent);
      await this.atomicWrite(localFilePath, remoteContent);
      return { status: 'APPLIED_CLEAN', mergedContent: remoteContent };
    }

    // Concurrent modification! Determine effective common ancestor base
    const effectiveBase = (baseContent !== null && baseContent !== undefined) ? baseContent : (this.lastCleanContent.get(normalized) ?? '');
    const mergeResult = threeWayMerge(effectiveBase, localContent, remoteContent);

    if (mergeResult.clean) {
      // Non-overlapping edits merged automatically without losing either edit
      this.lastCleanContent.set(normalized, mergeResult.mergedContent);
      await this.atomicWrite(localFilePath, mergeResult.mergedContent);
      return { status: 'AUTO_MERGED', mergedContent: mergeResult.mergedContent };
    }

    // Overlapping collision detected.
    // PRESERVE local file untouched; isolate incoming version into shadow conflict file.
    const shadowRemotePath = path.join(this.workspaceRoot, `${normalized}.conflict.remote`);
    const shadowBasePath = path.join(this.workspaceRoot, `${normalized}.conflict.base`);

    await this.atomicWrite(shadowRemotePath, remoteContent);
    if (effectiveBase) {
      await this.atomicWrite(shadowBasePath, effectiveBase);
    }

    const conflictId = crypto.randomUUID();
    const conflictRecord: LocalConflictRecord = {
      id: conflictId,
      relativePath: normalized,
      serverSeq,
      baseHash: payload.base_hash ?? null,
      remoteHash: payload.target_hash,
      detectedAt: new Date().toISOString(),
      status: ConflictStatus.DETECTED,
      shadowRemotePath,
      shadowBasePath,
    };

    this.activeConflicts.set(normalized, conflictRecord);

    return {
      status: 'CONFLICT_DETECTED',
      conflictRecord,
    };
  }

  /**
   * Executes a conflict resolution action (Task 5):
   * - KEEP_LOCAL: retains active local file
   * - ACCEPT_REMOTE: writes remote content over local file
   * - MERGE_MANUAL: writes custom merged content
   * Cleans up shadow conflict files (Task 8).
   */
  public async resolveConflict(
    relativePath: string,
    action: ConflictResolutionAction
  ): Promise<{
    resolvedContent: string;
    resolutionStatus: ConflictStatus;
  }> {
    const normalized = normalizeRelativePath(relativePath);
    const record = this.activeConflicts.get(normalized);
    if (!record) {
      throw new Error(`No active conflict found for path: ${normalized}`);
    }

    const localFilePath = path.join(this.workspaceRoot, normalized);
    let resolvedContent: string;
    let resolutionStatus: ConflictStatus;

    switch (action.type) {
      case 'KEEP_LOCAL':
        resolvedContent = await fs.readFile(localFilePath, 'utf-8');
        resolutionStatus = ConflictStatus.RESOLVED_KEEP_LOCAL;
        break;

      case 'ACCEPT_REMOTE': {
        const remoteContent = await fs.readFile(record.shadowRemotePath, 'utf-8');
        await this.atomicWrite(localFilePath, remoteContent);
        resolvedContent = remoteContent;
        resolutionStatus = ConflictStatus.RESOLVED_ACCEPT_REMOTE;
        break;
      }

      case 'MERGE_MANUAL':
        await this.atomicWrite(localFilePath, action.mergedContent);
        resolvedContent = action.mergedContent;
        resolutionStatus = ConflictStatus.RESOLVED_MERGED;
        break;
    }

    // Task 8: Clean up shadow conflict files only after successful resolution
    await this.cleanupShadowFiles(record);
    this.activeConflicts.delete(normalized);
    this.lastCleanContent.set(normalized, resolvedContent);

    return {
      resolvedContent,
      resolutionStatus,
    };
  }

  public getActiveConflict(relativePath: string): LocalConflictRecord | null {
    const normalized = normalizeRelativePath(relativePath);
    return this.activeConflicts.get(normalized) ?? null;
  }

  public listActiveConflicts(): LocalConflictRecord[] {
    return Array.from(this.activeConflicts.values());
  }

  private async atomicWrite(targetPath: string, content: string): Promise<void> {
    const dir = path.dirname(targetPath);
    await fs.mkdir(dir, { recursive: true });

    const relative = path.relative(this.workspaceRoot, targetPath);
    try {
      const normalized = normalizeRelativePath(relative);
      const hash = crypto.createHash('sha256').update(content).digest('hex');
      // Register in EchoFilter so local watcher ignores this write
      this.echoFilter.registerRemoteWrite(normalized, hash);
    } catch {
      // Internal or shadow files are ignored by watcher anyway
    }

    const tmpPath = `${targetPath}.${Date.now()}.${Math.random().toString(36).slice(2, 7)}.tmp`;
    await fs.writeFile(tmpPath, content, 'utf-8');
    await fs.rename(tmpPath, targetPath);
  }

  private async cleanupShadowFiles(record: LocalConflictRecord): Promise<void> {
    try {
      await fs.unlink(record.shadowRemotePath);
    } catch {
      // Ignore if already deleted
    }

    if (record.shadowBasePath) {
      try {
        await fs.unlink(record.shadowBasePath);
      } catch {
        // Ignore
      }
    }
  }
}
