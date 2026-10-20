import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { ConflictCoordinator } from '../conflict/coordinator.js';
import { EchoFilter } from '../fs/echo-filter.js';
import { SyncOpType, ConflictStatus } from '@collab/protocol';

describe('ConflictCoordinator - Auto-Merge & Conflict Isolation (Phase 4)', () => {
  let tempDir: string;
  let echoFilter: EchoFilter;
  let coordinator: ConflictCoordinator;

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'collab-conflict-test-'));
    echoFilter = new EchoFilter();
    coordinator = new ConflictCoordinator(tempDir, echoFilter);
  });

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('Criteria 1: Non-overlapping edits automatically merge without losing either edit', async () => {
    const baseContent = [
      '// File: service.ts',
      'export function getHeader() { return "Header v1"; }',
      '',
      'export function getFooter() { return "Footer v1"; }',
    ].join('\n');

    const localContent = [
      '// File: service.ts',
      'export function getHeader() { return "Header v2 - Local Edit"; }',
      '',
      'export function getFooter() { return "Footer v1"; }',
    ].join('\n');

    const remoteContent = [
      '// File: service.ts',
      'export function getHeader() { return "Header v1"; }',
      '',
      'export function getFooter() { return "Footer v2 - Remote Edit"; }',
    ].join('\n');

    const filePath = 'service.ts';
    const fullPath = path.join(tempDir, filePath);
    await fs.writeFile(fullPath, localContent, 'utf-8');

    const payload = {
      op_type: SyncOpType.FILE_UPDATE as const,
      relative_path: filePath,
      base_hash: '1'.repeat(64),
      target_hash: '2'.repeat(64),
      encoding: 'utf-8' as const,
      content: remoteContent,
      file_size_bytes: Buffer.byteLength(remoteContent),
      is_binary: false,
    };

    const res = await coordinator.processIncomingChange(payload, 101, baseContent);
    expect(res.status).toBe('AUTO_MERGED');
    expect(res.mergedContent).toContain('Header v2 - Local Edit');
    expect(res.mergedContent).toContain('Footer v2 - Remote Edit');

    // Verify disk content
    const disk = await fs.readFile(fullPath, 'utf-8');
    expect(disk).toBe(res.mergedContent);
  });

  it('Criteria 2 & 3: Overlapping collision preserves local file and isolates remote version in conflict file', async () => {
    const baseContent = 'const PORT = 3000;';
    const localContent = 'const PORT = 4000; // Local change';
    const remoteContent = 'const PORT = 5000; // Remote change';

    const filePath = 'config/port.ts';
    const fullPath = path.join(tempDir, filePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, localContent, 'utf-8');

    const payload = {
      op_type: SyncOpType.FILE_UPDATE as const,
      relative_path: filePath,
      base_hash: '1'.repeat(64),
      target_hash: '3'.repeat(64),
      encoding: 'utf-8' as const,
      content: remoteContent,
      file_size_bytes: Buffer.byteLength(remoteContent),
      is_binary: false,
    };

    const res = await coordinator.processIncomingChange(payload, 102, baseContent);
    expect(res.status).toBe('CONFLICT_DETECTED');
    expect(res.conflictRecord).toBeDefined();

    // 1. Verify local file was NOT overwritten (Criteria 3: Local changes never silently overwritten)
    const activeLocal = await fs.readFile(fullPath, 'utf-8');
    expect(activeLocal).toBe(localContent);

    // 2. Verify shadow remote file exists
    const shadowRemote = await fs.readFile(res.conflictRecord!.shadowRemotePath, 'utf-8');
    expect(shadowRemote).toBe(remoteContent);

    // 3. Verify shadow base file exists
    const shadowBase = await fs.readFile(res.conflictRecord!.shadowBasePath!, 'utf-8');
    expect(shadowBase).toBe(baseContent);
  });

  it('Criteria 5: Resolution action KEEP_LOCAL preserves local file and cleans up shadow files', async () => {
    const filePath = 'config/port.ts';
    const conflict = coordinator.getActiveConflict(filePath);
    expect(conflict).toBeDefined();

    const resolveRes = await coordinator.resolveConflict(filePath, { type: 'KEEP_LOCAL' });
    expect(resolveRes.resolutionStatus).toBe(ConflictStatus.RESOLVED_KEEP_LOCAL);
    expect(resolveRes.resolvedContent).toContain('const PORT = 4000; // Local change');

    // Verify shadow files were cleaned up (Task 8)
    const remoteExists = await fs.access(conflict!.shadowRemotePath).then(() => true).catch(() => false);
    expect(remoteExists).toBe(false);

    // Verify active conflict cleared
    expect(coordinator.getActiveConflict(filePath)).toBeNull();
  });

  it('Resolution action ACCEPT_REMOTE overwrites with remote content and cleans up shadow files', async () => {
    // Setup a new conflict
    const filePath = 'config/db.ts';
    const fullPath = path.join(tempDir, filePath);
    await fs.writeFile(fullPath, 'const DB = "local_db";', 'utf-8');

    const payload = {
      op_type: SyncOpType.FILE_UPDATE as const,
      relative_path: filePath,
      base_hash: '1'.repeat(64),
      target_hash: '2'.repeat(64),
      encoding: 'utf-8' as const,
      content: 'const DB = "remote_db";',
      file_size_bytes: 23,
      is_binary: false,
    };

    const detectRes = await coordinator.processIncomingChange(payload, 103, 'const DB = "base_db";');
    expect(detectRes.status).toBe('CONFLICT_DETECTED');

    // Resolve with ACCEPT_REMOTE
    const resolveRes = await coordinator.resolveConflict(filePath, { type: 'ACCEPT_REMOTE' });
    expect(resolveRes.resolutionStatus).toBe(ConflictStatus.RESOLVED_ACCEPT_REMOTE);
    expect(resolveRes.resolvedContent).toBe('const DB = "remote_db";');

    const disk = await fs.readFile(fullPath, 'utf-8');
    expect(disk).toBe('const DB = "remote_db";');

    // Shadow file cleaned up
    const shadowExists = await fs.access(detectRes.conflictRecord!.shadowRemotePath).then(() => true).catch(() => false);
    expect(shadowExists).toBe(false);
  });

  it('Resolution action MERGE_MANUAL writes combined content and cleans up shadow files', async () => {
    const filePath = 'config/api.ts';
    const fullPath = path.join(tempDir, filePath);
    await fs.writeFile(fullPath, 'const API_KEY = "local_key";', 'utf-8');

    const payload = {
      op_type: SyncOpType.FILE_UPDATE as const,
      relative_path: filePath,
      base_hash: '1'.repeat(64),
      target_hash: '2'.repeat(64),
      encoding: 'utf-8' as const,
      content: 'const API_KEY = "remote_key";',
      file_size_bytes: 29,
      is_binary: false,
    };

    const detectRes = await coordinator.processIncomingChange(payload, 104, 'const API_KEY = "base_key";');
    expect(detectRes.status).toBe('CONFLICT_DETECTED');

    const manuallyMerged = 'const API_KEY = process.env.API_KEY || "local_key";';
    const resolveRes = await coordinator.resolveConflict(filePath, {
      type: 'MERGE_MANUAL',
      mergedContent: manuallyMerged,
    });

    expect(resolveRes.resolutionStatus).toBe(ConflictStatus.RESOLVED_MERGED);
    expect(resolveRes.resolvedContent).toBe(manuallyMerged);

    const disk = await fs.readFile(fullPath, 'utf-8');
    expect(disk).toBe(manuallyMerged);

    // Shadow file cleaned up
    const shadowExists = await fs.access(detectRes.conflictRecord!.shadowRemotePath).then(() => true).catch(() => false);
    expect(shadowExists).toBe(false);
  });
});

