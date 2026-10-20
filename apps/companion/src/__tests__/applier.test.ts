import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { FileApplier } from '../fs/applier.js';
import { EchoFilter } from '../fs/echo-filter.js';
import { SyncOpType, IncomingChangeHandlingPolicy } from '@collab/protocol';

describe('FileApplier - Atomic Writes & Editing Lease Protection', () => {
  let tempDir: string;
  let echoFilter: EchoFilter;
  let applier: FileApplier;

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'collab-applier-test-'));
    echoFilter = new EchoFilter();
    applier = new FileApplier(tempDir, echoFilter);
  });

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('should write a file atomically and create parent directories', async () => {
    const payload = {
      op_type: SyncOpType.FILE_CREATE as const,
      relative_path: 'nested/sub/hello.txt',
      base_hash: null,
      target_hash: '1'.repeat(64),
      encoding: 'utf-8' as const,
      content: 'Hello Antigravity Team',
      file_size_bytes: 22,
      is_binary: false,
    };

    const res = await applier.applyRemoteOperation(payload, 1);
    expect(res.success).toBe(true);
    expect(res.action).toBe('WRITTEN');

    const diskContent = await fs.readFile(path.join(tempDir, 'nested/sub/hello.txt'), 'utf-8');
    expect(diskContent).toBe('Hello Antigravity Team');
  });

  it('Safeguard 1: should isolate incoming changes to shadow file when file has active editing lease', async () => {
    const targetFile = 'backend/auth.ts';
    const originalLocalContent = 'export const myLocalUnsavedWork = true;';

    // 1. Establish file on disk
    await fs.mkdir(path.join(tempDir, 'backend'), { recursive: true });
    await fs.writeFile(path.join(tempDir, targetFile), originalLocalContent, 'utf-8');

    // 2. Protect file with editing lease
    applier.protectFile(targetFile, IncomingChangeHandlingPolicy.ISOLATE_TO_SHADOW);

    // 3. Incoming remote change arrives from teammate
    const remotePayload = {
      op_type: SyncOpType.FILE_UPDATE as const,
      relative_path: targetFile,
      base_hash: '1'.repeat(64),
      target_hash: '2'.repeat(64),
      encoding: 'utf-8' as const,
      content: 'export const teammateOverwritingContent = false;',
      file_size_bytes: 48,
      is_binary: false,
    };

    const res = await applier.applyRemoteOperation(remotePayload, 105);
    expect(res.success).toBe(true);
    expect(res.action).toBe('SHADOW_ISOLATED');
    expect(res.shadowPath).toBeDefined();

    // 4. Verify local active file was NOT overwritten (Zero lost work)
    const localContent = await fs.readFile(path.join(tempDir, targetFile), 'utf-8');
    expect(localContent).toBe(originalLocalContent);

    // 5. Verify shadow file was created with remote content
    const shadowContent = await fs.readFile(res.shadowPath!, 'utf-8');
    expect(shadowContent).toBe('export const teammateOverwritingContent = false;');
    expect(res.shadowPath).toContain('.collab-remote-105');
  });

  it('should safely delete a file on FILE_DELETE', async () => {
    const filePath = 'to-delete.txt';
    await fs.writeFile(path.join(tempDir, filePath), 'delete me', 'utf-8');

    const res = await applier.applyRemoteOperation(
      {
        op_type: SyncOpType.FILE_DELETE,
        relative_path: filePath,
        deleted_hash: '3'.repeat(64),
      },
      106
    );

    expect(res.success).toBe(true);
    expect(res.action).toBe('DELETED');

    const exists = await fs
      .access(path.join(tempDir, filePath))
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(false);
  });
});
