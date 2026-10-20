/**
 * @file outbox.ts
 * Local persistent outbox queue for offline resilience and event replay.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { FileOperationPayload } from '@collab/protocol';

export interface OutboxItem {
  client_op_id: string;
  payload: FileOperationPayload;
  created_at: string;
  status: 'PENDING' | 'COMMITTED';
  assigned_seq?: number;
}

export class LocalOutbox {
  private items: OutboxItem[] = [];
  private outboxFilePath: string;

  constructor(private storageDir: string) {
    this.outboxFilePath = path.join(this.storageDir, 'outbox.json');
  }

  /**
   * Initializes outbox and loads uncommitted items from disk if available.
   */
  public async init(): Promise<void> {
    try {
      await fs.mkdir(this.storageDir, { recursive: true });
      const raw = await fs.readFile(this.outboxFilePath, 'utf-8');
      const loaded = JSON.parse(raw) as OutboxItem[];
      // Keep only pending items
      this.items = loaded.filter((item) => item.status === 'PENDING');
    } catch {
      this.items = [];
    }
  }

  /**
   * Enqueues a new local change operation.
   */
  public async enqueue(payload: FileOperationPayload): Promise<OutboxItem> {
    const item: OutboxItem = {
      client_op_id: crypto.randomUUID(),
      payload,
      created_at: new Date().toISOString(),
      status: 'PENDING',
    };

    this.items.push(item);
    await this.persist();
    return item;
  }

  /**
   * Marks an operation acknowledged by the server.
   */
  public async markAcknowledged(clientOpId: string, assignedSeq: number): Promise<void> {
    const item = this.items.find((i) => i.client_op_id === clientOpId);
    if (item) {
      item.status = 'COMMITTED';
      item.assigned_seq = assignedSeq;
    }
    // Prune committed items and persist
    this.items = this.items.filter((i) => i.status === 'PENDING');
    await this.persist();
  }

  /**
   * Retrieves all currently pending uncommitted items.
   */
  public getPending(): OutboxItem[] {
    return this.items.filter((i) => i.status === 'PENDING');
  }

  private async persist(): Promise<void> {
    try {
      await fs.writeFile(this.outboxFilePath, JSON.stringify(this.items, null, 2), 'utf-8');
    } catch (err) {
      console.error('[Outbox] Failed to persist outbox to disk:', err);
    }
  }
}
