import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { LocalOutbox } from '../storage/outbox.js';
import { SyncOpType } from '@collab/protocol';

describe('LocalOutbox - Offline Queuing & Persistence', () => {
  let tempDir: string;

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'collab-outbox-test-'));
  });

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('should enqueue items and persist across restarts', async () => {
    const outbox1 = new LocalOutbox(tempDir);
    await outbox1.init();

    const item1 = await outbox1.enqueue({
      op_type: SyncOpType.FILE_CREATE,
      relative_path: 'backend/api.ts',
      base_hash: null,
      target_hash: '1'.repeat(64),
      encoding: 'utf-8',
      content: 'console.log("hello");',
      file_size_bytes: 21,
      is_binary: false,
    });

    expect(outbox1.getPending()).toHaveLength(1);

    // Simulate companion crash and restart: instantiate outbox2 pointing to same storageDir
    const outbox2 = new LocalOutbox(tempDir);
    await outbox2.init();

    const pendingAfterRestart = outbox2.getPending();
    expect(pendingAfterRestart).toHaveLength(1);
    expect(pendingAfterRestart[0].client_op_id).toBe(item1.client_op_id);
    expect((pendingAfterRestart[0].payload as { relative_path: string }).relative_path).toBe('backend/api.ts');

    // Acknowledge item in outbox2
    await outbox2.markAcknowledged(item1.client_op_id, 101);
    expect(outbox2.getPending()).toHaveLength(0);

    // Verify outbox3 on next boot has 0 pending items
    const outbox3 = new LocalOutbox(tempDir);
    await outbox3.init();
    expect(outbox3.getPending()).toHaveLength(0);
  });
});
