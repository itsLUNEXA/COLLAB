/**
 * @file ws-handler.ts
 * Core WebSocket message processor.
 * Enforces protocol schema validation, path jailing, monotonic sequence assignment,
 * idempotency, peer broadcasting, and catch-up range retrieval.
 */

import { WebSocket } from 'ws';
import {
  ProtocolVersion,
  MessageType,
  SyncEnvelope,
  SyncEnvelopeSchema,
  FileOperationPayloadSchema,
  SyncHandshakePayloadSchema,
  MissingEventsRequestPayloadSchema,
  normalizeRelativePath,
  isPathEligibleForSync,
  CollabError,
  ErrorCode,
} from '@collab/protocol';
import { ISyncRepository } from '../storage/sync-repository.interface.js';
import { ConnectionManager, ClientSession } from './connection-manager.js';
import { ServerConfig } from '../config.js';

export class WebSocketHandler {
  constructor(
    private repository: ISyncRepository,
    private connectionManager: ConnectionManager,
    private config: ServerConfig
  ) {}

  /**
   * Processes a raw string or buffer from a WebSocket client.
   */
  public async handleMessage(socket: WebSocket, rawData: string | Buffer): Promise<void> {
    const session = this.connectionManager.getSession(socket);
    if (!session) {
      this.sendError(
        socket,
        ErrorCode.UNAUTHORIZED,
        'Socket connection is not registered or authenticated'
      );
      socket.close(1008, 'Unauthorized');
      return;
    }

    // Task 10: Payload size limit check
    const rawByteLength = Buffer.byteLength(rawData);
    if (rawByteLength > this.config.MAX_PAYLOAD_BYTES) {
      this.sendError(
        socket,
        ErrorCode.PAYLOAD_TOO_LARGE,
        `Payload size (${rawByteLength} bytes) exceeds limit of ${this.config.MAX_PAYLOAD_BYTES} bytes`
      );
      return;
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawData.toString('utf-8'));
    } catch {
      this.sendError(socket, ErrorCode.INVALID_ENVELOPE, 'Malformed JSON payload');
      return;
    }

    // Task 4: Validate envelope against shared protocol schema
    const envelopeResult = SyncEnvelopeSchema.safeParse(parsedJson);
    if (!envelopeResult.success) {
      this.sendError(
        socket,
        ErrorCode.INVALID_ENVELOPE,
        'Invalid sync envelope structure',
        { errors: envelopeResult.error.errors }
      );
      return;
    }

    const envelope = envelopeResult.data;

    // Verify session match
    if (envelope.project_id !== session.projectId || envelope.device_id !== session.deviceId) {
      this.sendError(
        socket,
        ErrorCode.UNAUTHORIZED,
        'Project or Device ID mismatch with authenticated session'
      );
      return;
    }

    try {
      switch (envelope.message_type) {
        case MessageType.SYNC_HANDSHAKE:
          await this.handleHandshake(socket, session, envelope);
          break;

        case MessageType.CLIENT_EVENT:
          await this.handleClientEvent(socket, session, envelope);
          break;

        case MessageType.REQUEST_MISSING_EVENTS:
          await this.handleRequestMissingEvents(socket, session, envelope);
          break;

        default:
          this.sendError(
            socket,
            ErrorCode.INVALID_ENVELOPE,
            `Unsupported message type: ${envelope.message_type}`
          );
      }
    } catch (err) {
      if (err instanceof CollabError) {
        this.sendError(socket, err.code, err.message, err.details);
      } else {
        const errorMsg = err instanceof Error ? err.message : 'Unknown server error';
        this.sendError(socket, ErrorCode.INTERNAL_ERROR, errorMsg);
      }
    }
  }

  /**
   * Handles client initial handshake and calculates catch-up status.
   */
  private async handleHandshake(
    socket: WebSocket,
    session: ClientSession,
    envelope: SyncEnvelope
  ): Promise<void> {
    const handshakeResult = SyncHandshakePayloadSchema.safeParse(envelope.payload);
    if (!handshakeResult.success) {
      throw new CollabError(ErrorCode.INVALID_ENVELOPE, 'Invalid handshake payload');
    }

    const currentSeq = await this.repository.getCurrentSequenceNum(session.projectId);
    const clientLastSeq = handshakeResult.data.last_received_seq;
    const catchUpRequired = currentSeq > clientLastSeq;
    const missingCount = catchUpRequired ? currentSeq - clientLastSeq : 0;

    const ackEnvelope: SyncEnvelope = {
      protocol_version: ProtocolVersion,
      project_id: session.projectId,
      device_id: session.deviceId,
      message_type: MessageType.HANDSHAKE_ACK,
      client_op_id: envelope.client_op_id,
      sequence_num: currentSeq,
      timestamp_utc: new Date().toISOString(),
      payload: {
        server_version: '0.1.0',
        current_server_seq: currentSeq,
        catch_up_required: catchUpRequired,
        missing_events_count: missingCount,
      },
    };

    this.connectionManager.send(socket, ackEnvelope);
  }

  /**
   * Handles a client filesystem change event:
   * 1. Path validation & jailing (Task 10)
   * 2. Idempotency verification (Task 6)
   * 3. Sequence assignment & persistence (Task 5)
   * 4. ACK to sender (Task 8)
   * 5. Peer broadcast with originator exclusion (Task 7)
   */
  private async handleClientEvent(
    socket: WebSocket,
    session: ClientSession,
    envelope: SyncEnvelope
  ): Promise<void> {
    // 1. Validate payload against FileOperationPayloadSchema
    const opResult = FileOperationPayloadSchema.safeParse(envelope.payload);
    if (!opResult.success) {
      throw new CollabError(
        ErrorCode.INVALID_ENVELOPE,
        'Invalid file operation payload',
        { errors: opResult.error.errors }
      );
    }

    const opPayload = opResult.data;

    // 2. Server-side path normalization and path traversal security
    const targetPath =
      opPayload.op_type === 'FILE_RENAME'
        ? opPayload.new_relative_path
        : opPayload.relative_path;

    const normalizedPath = normalizeRelativePath(targetPath);

    if (!isPathEligibleForSync(normalizedPath)) {
      throw new CollabError(
        ErrorCode.INVALID_PATH_CHARACTERS,
        `Path "${normalizedPath}" is excluded from synchronization`
      );
    }

    // 3. Idempotency Check (Task 6, Acceptance Criteria 4)
    const existingEvent = await this.repository.getEventByClientOpId(
      session.projectId,
      envelope.client_op_id
    );

    if (existingEvent) {
      // Operation already processed: send ACK without duplicate persistence or re-broadcast
      const duplicateAck: SyncEnvelope = {
        protocol_version: ProtocolVersion,
        project_id: session.projectId,
        device_id: session.deviceId,
        message_type: MessageType.EVENT_ACK,
        client_op_id: envelope.client_op_id,
        sequence_num: existingEvent.seq_num,
        timestamp_utc: new Date().toISOString(),
        payload: {
          client_op_id: envelope.client_op_id,
          assigned_seq: existingEvent.seq_num,
          status: 'DUPLICATE',
          reason: 'Operation already accepted and sequenced',
        },
      };
      this.connectionManager.send(socket, duplicateAck);
      return;
    }

    // 4. Monotonic Sequence Assignment & Persistence (Task 5, Acceptance Criteria 5)
    const nextSeq = await this.repository.getNextSequenceNum(session.projectId);

    const baseHash = 'base_hash' in opPayload ? opPayload.base_hash : null;
    const targetHash =
      'target_hash' in opPayload
        ? opPayload.target_hash
        : 'deleted_hash' in opPayload
        ? opPayload.deleted_hash
        : opPayload.content_hash;

    const contentBlob = 'content' in opPayload ? opPayload.content ?? null : null;
    const s3Url = 's3_blob_url' in opPayload ? opPayload.s3_blob_url ?? null : null;
    const isBinary = 'is_binary' in opPayload ? opPayload.is_binary : false;
    const fileSize = 'file_size_bytes' in opPayload ? opPayload.file_size_bytes : 0;

    await this.repository.saveSyncEvent({
      project_id: session.projectId,
      device_id: session.deviceId,
      seq_num: nextSeq,
      client_op_id: envelope.client_op_id,
      relative_path: normalizedPath,
      op_type: opPayload.op_type,
      base_hash: baseHash,
      target_hash: targetHash,
      file_size_bytes: fileSize,
      is_binary: isBinary,
      content_blob: contentBlob,
      blob_storage_url: s3Url,
      created_at: new Date().toISOString(),
    });

    // 5. Send ACK to originating client (Task 8)
    const ackEnvelope: SyncEnvelope = {
      protocol_version: ProtocolVersion,
      project_id: session.projectId,
      device_id: session.deviceId,
      message_type: MessageType.EVENT_ACK,
      client_op_id: envelope.client_op_id,
      sequence_num: nextSeq,
      timestamp_utc: new Date().toISOString(),
      payload: {
        client_op_id: envelope.client_op_id,
        assigned_seq: nextSeq,
        status: 'ACCEPTED',
      },
    };
    this.connectionManager.send(socket, ackEnvelope);

    // 6. Broadcast event to peers, strictly excluding the originator (Task 7, Acceptance Criteria 2 & 3)
    const broadcastEnvelope: SyncEnvelope = {
      protocol_version: ProtocolVersion,
      project_id: session.projectId,
      device_id: session.deviceId,
      message_type: MessageType.SERVER_BROADCAST,
      client_op_id: envelope.client_op_id,
      sequence_num: nextSeq,
      timestamp_utc: new Date().toISOString(),
      payload: {
        ...opPayload,
        relative_path: normalizedPath,
      },
    };

    this.connectionManager.broadcastToProject(
      session.projectId,
      broadcastEnvelope,
      session.deviceId // Exclude originator
    );
  }

  /**
   * Handles client request to fetch missed events after reconnection (Task 9, Acceptance Criteria 7).
   */
  private async handleRequestMissingEvents(
    socket: WebSocket,
    session: ClientSession,
    envelope: SyncEnvelope
  ): Promise<void> {
    const parseResult = MissingEventsRequestPayloadSchema.safeParse(envelope.payload);
    if (!parseResult.success) {
      throw new CollabError(ErrorCode.INVALID_ENVELOPE, 'Invalid missing events request payload');
    }

    const { from_seq_exclusive, max_batch_size } = parseResult.data;
    const events = await this.repository.getEventsRange(
      session.projectId,
      from_seq_exclusive,
      max_batch_size
    );

    const responseEnvelope: SyncEnvelope = {
      protocol_version: ProtocolVersion,
      project_id: session.projectId,
      device_id: session.deviceId,
      message_type: MessageType.MISSING_EVENTS_RESPONSE,
      client_op_id: envelope.client_op_id,
      sequence_num: await this.repository.getCurrentSequenceNum(session.projectId),
      timestamp_utc: new Date().toISOString(),
      payload: {
        events: events.map((e) => ({
          seq_num: e.seq_num,
          client_op_id: e.client_op_id,
          device_id: e.device_id,
          relative_path: e.relative_path,
          op_type: e.op_type,
          base_hash: e.base_hash,
          target_hash: e.target_hash,
          content: e.content_blob,
          s3_blob_url: e.blob_storage_url,
          is_binary: e.is_binary,
          created_at: e.created_at,
        })),
        has_more: events.length === max_batch_size,
      },
    };

    this.connectionManager.send(socket, responseEnvelope);
  }

  /**
   * Dispatches an ERROR_ALERT envelope to the socket.
   */
  private sendError(
    socket: WebSocket,
    code: ErrorCode,
    message: string,
    details?: Record<string, unknown>
  ): void {
    const errorEnvelope: SyncEnvelope = {
      protocol_version: ProtocolVersion,
      project_id: '00000000-0000-0000-0000-000000000000',
      device_id: '00000000-0000-0000-0000-000000000000',
      message_type: MessageType.ERROR_ALERT,
      client_op_id: '00000000-0000-0000-0000-000000000000',
      timestamp_utc: new Date().toISOString(),
      payload: {
        code,
        message,
        details,
        timestamp_utc: new Date().toISOString(),
      },
    };

    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(errorEnvelope));
    }
  }
}
