import { describe, it, expect } from 'vitest';
import {
  SyncEnvelopeSchema,
  FileUpsertPayloadSchema,
  EventAckPayloadSchema,
  SyncOpType,
  MessageType,
  ProtocolVersion,
} from '../index.js';

describe('sync-events.ts - Protocol Envelope & Event Validation', () => {
  const validDeviceId = '11111111-1111-4111-8111-111111111111';
  const validProjectId = '22222222-2222-4222-8222-222222222222';
  const validOpId = '33333333-3333-4333-8333-333333333333';
  const validHash1 = 'a'.repeat(64);
  const validHash2 = 'b'.repeat(64);

  it('should validate a compliant SyncEnvelope with FILE_UPDATE payload', () => {
    const rawEnvelope = {
      protocol_version: ProtocolVersion,
      project_id: validProjectId,
      device_id: validDeviceId,
      message_type: MessageType.CLIENT_EVENT,
      client_op_id: validOpId,
      timestamp_utc: new Date().toISOString(),
      payload: {
        op_type: SyncOpType.FILE_UPDATE,
        relative_path: 'backend/src/auth.ts',
        base_hash: validHash1,
        target_hash: validHash2,
        encoding: 'utf-8',
        content: 'console.log("hello");',
        file_size_bytes: 21,
        is_binary: false,
      },
    };

    const parsed = SyncEnvelopeSchema.safeParse(rawEnvelope);
    expect(parsed.success).toBe(true);

    const payloadParsed = FileUpsertPayloadSchema.safeParse(rawEnvelope.payload);
    expect(payloadParsed.success).toBe(true);
  });

  it('should reject an envelope with an invalid message_type', () => {
    const rawEnvelope = {
      protocol_version: ProtocolVersion,
      project_id: validProjectId,
      device_id: validDeviceId,
      message_type: 'INVALID_UNKNOWN_MESSAGE_TYPE',
      client_op_id: validOpId,
      timestamp_utc: new Date().toISOString(),
      payload: {},
    };

    const parsed = SyncEnvelopeSchema.safeParse(rawEnvelope);
    expect(parsed.success).toBe(false);
  });

  it('should reject invalid SHA-256 hash formatting', () => {
    const invalidPayload = {
      op_type: SyncOpType.FILE_UPDATE,
      relative_path: 'backend/src/auth.ts',
      base_hash: 'not-a-64-char-hash',
      target_hash: validHash2,
      encoding: 'utf-8',
      file_size_bytes: 10,
      is_binary: false,
    };

    const parsed = FileUpsertPayloadSchema.safeParse(invalidPayload);
    expect(parsed.success).toBe(false);
  });

  it('should validate EventAckPayload for accepted and duplicate events', () => {
    const acceptedAck = {
      client_op_id: validOpId,
      assigned_seq: 105,
      status: 'ACCEPTED',
    };
    expect(EventAckPayloadSchema.safeParse(acceptedAck).success).toBe(true);

    const duplicateAck = {
      client_op_id: validOpId,
      assigned_seq: 105,
      status: 'DUPLICATE',
      reason: 'Operation UUID already registered in project sequence ledger',
    };
    expect(EventAckPayloadSchema.safeParse(duplicateAck).success).toBe(true);
  });
});
