/**
 * @file sync-events.ts
 * Real-time synchronization event schemas, envelopes, and validation types using Zod.
 */

import { z } from 'zod';
import { ProtocolVersion, SyncOpType, MessageType, ConflictStatus } from './opcodes.js';

// Base SHA-256 string validator
export const Sha256HashSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/i, 'Hash must be a valid 64-character lowercase/uppercase hex string');

// Client Operation UUIDv4 validator
export const ClientOpIdSchema = z.string().uuid('Operation ID must be a valid UUIDv4');

// Project and Device IDs
export const EntityIdSchema = z.string().uuid('ID must be a valid UUIDv4');

// Payload for FILE_CREATE or FILE_UPDATE
export const FileUpsertPayloadSchema = z.object({
  op_type: z.enum([SyncOpType.FILE_CREATE, SyncOpType.FILE_UPDATE]),
  relative_path: z.string().min(1),
  base_hash: Sha256HashSchema.nullable(), // null for brand new files
  target_hash: Sha256HashSchema,
  encoding: z.enum(['utf-8', 'base64', 's3_pointer']),
  content: z.string().optional(), // Inlined if small, omitted if s3_pointer
  s3_blob_url: z.string().url().optional(),
  file_size_bytes: z.number().nonnegative(),
  is_binary: z.boolean(),
});
export type FileUpsertPayload = z.infer<typeof FileUpsertPayloadSchema>;

// Payload for FILE_DELETE
export const FileDeletePayloadSchema = z.object({
  op_type: z.literal(SyncOpType.FILE_DELETE),
  relative_path: z.string().min(1),
  deleted_hash: Sha256HashSchema,
});
export type FileDeletePayload = z.infer<typeof FileDeletePayloadSchema>;

// Payload for FILE_RENAME
export const FileRenamePayloadSchema = z.object({
  op_type: z.literal(SyncOpType.FILE_RENAME),
  old_relative_path: z.string().min(1),
  new_relative_path: z.string().min(1),
  content_hash: Sha256HashSchema,
});
export type FileRenamePayload = z.infer<typeof FileRenamePayloadSchema>;

// Union of all filesystem operation payloads
export const FileOperationPayloadSchema = z.discriminatedUnion('op_type', [
  FileUpsertPayloadSchema,
  FileDeletePayloadSchema,
  FileRenamePayloadSchema,
]);
export type FileOperationPayload = z.infer<typeof FileOperationPayloadSchema>;

// Handshake between Companion and Cloud Server
export const SyncHandshakePayloadSchema = z.object({
  workspace_id: EntityIdSchema,
  client_version: z.string(),
  last_received_seq: z.number().int().nonnegative(),
  supported_encodings: z.array(z.string()).default(['utf-8', 'base64']),
});
export type SyncHandshakePayload = z.infer<typeof SyncHandshakePayloadSchema>;

export const HandshakeAckPayloadSchema = z.object({
  server_version: z.string(),
  current_server_seq: z.number().int().nonnegative(),
  catch_up_required: z.boolean(),
  missing_events_count: z.number().int().nonnegative(),
});
export type HandshakeAckPayload = z.infer<typeof HandshakeAckPayloadSchema>;

// Acknowledgement payload
export const EventAckPayloadSchema = z.object({
  client_op_id: ClientOpIdSchema,
  assigned_seq: z.number().int().positive(),
  status: z.enum(['ACCEPTED', 'DUPLICATE', 'REJECTED']),
  reason: z.string().optional(),
});
export type EventAckPayload = z.infer<typeof EventAckPayloadSchema>;

// Missing events catch-up protocol
export const MissingEventsRequestPayloadSchema = z.object({
  from_seq_exclusive: z.number().int().nonnegative(),
  max_batch_size: z.number().int().min(1).max(500).default(100),
});
export type MissingEventsRequestPayload = z.infer<typeof MissingEventsRequestPayloadSchema>;

// Conflict Alert payload
export const ConflictAlertPayloadSchema = z.object({
  conflict_id: EntityIdSchema,
  relative_path: z.string(),
  server_seq: z.number().int().positive(),
  base_hash: Sha256HashSchema.nullable(),
  remote_hash: Sha256HashSchema,
  remote_device_id: EntityIdSchema,
  remote_content: z.string().optional(),
  conflict_status: z.nativeEnum(ConflictStatus),
  detected_at_utc: z.string().datetime(),
});
export type ConflictAlertPayload = z.infer<typeof ConflictAlertPayloadSchema>;

// Conflict Resolution payload
export const ConflictResolutionPayloadSchema = z.object({
  conflict_id: EntityIdSchema,
  relative_path: z.string(),
  resolution_type: z.enum([
    ConflictStatus.RESOLVED_KEEP_LOCAL,
    ConflictStatus.RESOLVED_ACCEPT_REMOTE,
    ConflictStatus.RESOLVED_MERGED,
  ]),
  resolved_hash: Sha256HashSchema,
  resolved_content: z.string().optional(),
  resolved_at_utc: z.string().datetime(),
});
export type ConflictResolutionPayload = z.infer<typeof ConflictResolutionPayloadSchema>;

// The Universal Wire Envelope
export const SyncEnvelopeSchema = z.object({
  protocol_version: z.literal(ProtocolVersion),
  project_id: EntityIdSchema,
  device_id: EntityIdSchema,
  message_type: z.nativeEnum(MessageType),
  client_op_id: ClientOpIdSchema,
  sequence_num: z.number().int().positive().optional(), // Assigned by server
  timestamp_utc: z.string().datetime(),
  payload: z.record(z.unknown()), // Specialized per message_type
});
export type SyncEnvelope = z.infer<typeof SyncEnvelopeSchema>;
