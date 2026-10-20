/**
 * @file client.ts
 * Real-time WebSocket synchronization client for the desktop companion.
 * Manages connection lifecycle, handshakes, catch-up requests, and outbound flush.
 */

import { WebSocket } from 'ws';
import {
  ProtocolVersion,
  MessageType,
  SyncEnvelope,
  HandshakeAckPayload,
  EventAckPayload,
  FileOperationPayload,
} from '@collab/protocol';
import { CompanionConfig } from '../config.js';
import { LocalOutbox } from '../storage/outbox.js';
import { FileApplier } from '../fs/applier.js';

export class SyncClient {
  private socket: WebSocket | null = null;
  private isConnected = false;
  private lastReceivedSeq = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectDelayMs = 1000;
  private maxReconnectDelayMs = 15000;
  private shouldReconnect = true;

  constructor(
    private config: CompanionConfig,
    private outbox: LocalOutbox,
    private applier: FileApplier
  ) {}

  /**
   * Connects to the collaboration server and initiates the sync handshake.
   */
  public async connect(): Promise<void> {
    this.shouldReconnect = true;
    return new Promise((resolve) => {
      const url = `${this.config.serverUrl}?token=${this.config.token}`;
      this.socket = new WebSocket(url);

      this.socket.on('open', () => {
        this.isConnected = true;
        this.reconnectDelayMs = 1000;
        this.sendHandshake();
        this.flushOutbox();
        resolve();
      });

      this.socket.on('message', async (data: Buffer | string) => {
        await this.handleMessage(data);
      });

      this.socket.on('close', () => {
        this.isConnected = false;
        if (this.shouldReconnect) {
          this.scheduleReconnect();
        }
      });

      this.socket.on('error', () => {
        if (this.socket) {
          this.socket.close();
        }
      });
    });
  }

  /**
   * Gracefully disconnects and cancels reconnection timers.
   */
  public disconnect(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    this.isConnected = false;
  }

  /**
   * Enqueues a local change in the outbox and immediately flushes if connected.
   */
  public async sendLocalChange(payload: FileOperationPayload): Promise<void> {
    const item = await this.outbox.enqueue(payload);
    if (this.isConnected && this.socket?.readyState === WebSocket.OPEN) {
      this.sendClientEvent(item.client_op_id, item.payload);
    }
  }

  public getIsConnected(): boolean {
    return this.isConnected;
  }

  public getLastReceivedSeq(): number {
    return this.lastReceivedSeq;
  }

  private sendHandshake(): void {
    const handshakeEnvelope: SyncEnvelope = {
      protocol_version: ProtocolVersion,
      project_id: this.config.projectId,
      device_id: this.config.deviceId,
      message_type: MessageType.SYNC_HANDSHAKE,
      client_op_id: '00000000-0000-0000-0000-000000000000',
      timestamp_utc: new Date().toISOString(),
      payload: {
        workspace_id: this.config.deviceId,
        client_version: '0.1.0',
        last_received_seq: this.lastReceivedSeq,
        supported_encodings: ['utf-8', 'base64'],
      },
    };

    this.send(handshakeEnvelope);
  }

  private sendClientEvent(clientOpId: string, payload: FileOperationPayload): void {
    const envelope: SyncEnvelope = {
      protocol_version: ProtocolVersion,
      project_id: this.config.projectId,
      device_id: this.config.deviceId,
      message_type: MessageType.CLIENT_EVENT,
      client_op_id: clientOpId,
      timestamp_utc: new Date().toISOString(),
      payload: { ...payload },
    };

    this.send(envelope);
  }

  private flushOutbox(): void {
    const pending = this.outbox.getPending();
    for (const item of pending) {
      this.sendClientEvent(item.client_op_id, item.payload);
    }
  }

  private async handleMessage(raw: Buffer | string): Promise<void> {
    let envelope: SyncEnvelope;
    try {
      envelope = JSON.parse(raw.toString('utf-8')) as SyncEnvelope;
    } catch {
      return;
    }

    switch (envelope.message_type) {
      case MessageType.HANDSHAKE_ACK: {
        const ackPayload = envelope.payload as HandshakeAckPayload;
        if (ackPayload.catch_up_required) {
          this.requestMissingEvents(this.lastReceivedSeq);
        }
        break;
      }

      case MessageType.EVENT_ACK: {
        const eventAck = envelope.payload as EventAckPayload;
        if (eventAck.status === 'ACCEPTED' || eventAck.status === 'DUPLICATE') {
          await this.outbox.markAcknowledged(eventAck.client_op_id, eventAck.assigned_seq);
          if (eventAck.assigned_seq > this.lastReceivedSeq) {
            this.lastReceivedSeq = eventAck.assigned_seq;
          }
        }
        break;
      }

      case MessageType.SERVER_BROADCAST: {
        const opPayload = envelope.payload as FileOperationPayload;
        const seqNum = envelope.sequence_num ?? 0;
        await this.applier.applyRemoteOperation(opPayload, seqNum);
        if (seqNum > this.lastReceivedSeq) {
          this.lastReceivedSeq = seqNum;
        }
        break;
      }

      case MessageType.MISSING_EVENTS_RESPONSE: {
        const payload = envelope.payload as {
          events: Array<{ seq_num: number; op_type: string; relative_path: string; content?: string }>;
        };
        for (const evt of payload.events) {
          await this.applier.applyRemoteOperation(evt as unknown as FileOperationPayload, evt.seq_num);
          if (evt.seq_num > this.lastReceivedSeq) {
            this.lastReceivedSeq = evt.seq_num;
          }
        }
        break;
      }
    }
  }

  private requestMissingEvents(fromSeq: number): void {
    const envelope: SyncEnvelope = {
      protocol_version: ProtocolVersion,
      project_id: this.config.projectId,
      device_id: this.config.deviceId,
      message_type: MessageType.REQUEST_MISSING_EVENTS,
      client_op_id: '00000000-0000-0000-0000-000000000000',
      timestamp_utc: new Date().toISOString(),
      payload: {
        from_seq_exclusive: fromSeq,
        max_batch_size: 100,
      },
    };

    this.send(envelope);
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.shouldReconnect) {
        try {
          await this.connect();
        } catch {
          this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, this.maxReconnectDelayMs);
          this.scheduleReconnect();
        }
      }
    }, this.reconnectDelayMs);
  }

  private send(envelope: SyncEnvelope): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(envelope));
    }
  }
}
