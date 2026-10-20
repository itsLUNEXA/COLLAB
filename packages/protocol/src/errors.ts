/**
 * @file errors.ts
 * Standard error codes and error structures for network and validation failures.
 */

export enum ErrorCode {
  // Protocol & Authentication
  INVALID_ENVELOPE = 'ERR_INVALID_ENVELOPE',
  PROTOCOL_VERSION_MISMATCH = 'ERR_PROTOCOL_VERSION_MISMATCH',
  UNAUTHORIZED = 'ERR_UNAUTHORIZED',
  DEVICE_REVOKED = 'ERR_DEVICE_REVOKED',
  PROJECT_NOT_FOUND = 'ERR_PROJECT_NOT_FOUND',

  // Path & Security (Safeguards 5 & 6)
  PATH_TRAVERSAL_DETECTED = 'ERR_PATH_TRAVERSAL_DETECTED',
  INVALID_PATH_CHARACTERS = 'ERR_INVALID_PATH_CHARACTERS',
  PROTECTED_FILE_VIOLATION = 'ERR_PROTECTED_FILE_VIOLATION',
  COMMAND_EXECUTION_PROHIBITED = 'ERR_COMMAND_EXECUTION_PROHIBITED',

  // Concurrency & Leases (Safeguard 1)
  EDIT_LEASE_CONFLICT = 'ERR_EDIT_LEASE_CONFLICT',
  SEQUENCE_GAP_DETECTED = 'ERR_SEQUENCE_GAP_DETECTED',
  DUPLICATE_OPERATION_ID = 'ERR_DUPLICATE_OPERATION_ID',
  UNACKNOWLEDGED_DEPENDENCY = 'ERR_UNACKNOWLEDGED_DEPENDENCY',

  // Conflict & Checkpoints (Safeguards 2 & 3)
  UNRESOLVED_CONFLICT_EXISTS = 'ERR_UNRESOLVED_CONFLICT_EXISTS',
  CHECKPOINT_VALIDATION_FAILED = 'ERR_CHECKPOINT_VALIDATION_FAILED',
  SNAPSHOT_HASH_MISMATCH = 'ERR_SNAPSHOT_HASH_MISMATCH',
  BRANCH_DIVERGENCE = 'ERR_BRANCH_DIVERGENCE',

  // Contracts (Safeguards 4 & 7)
  CONTRACT_PARSE_ERROR = 'ERR_CONTRACT_PARSE_ERROR',
  CONTRACT_BREAKING_CHANGE = 'ERR_CONTRACT_BREAKING_CHANGE',
  CONTRACT_VERSION_MISMATCH = 'ERR_CONTRACT_VERSION_MISMATCH',
  UNSUPPORTED_LANGUAGE_PATTERN = 'ERR_UNSUPPORTED_LANGUAGE_PATTERN',

  // System & Storage
  PAYLOAD_TOO_LARGE = 'ERR_PAYLOAD_TOO_LARGE',
  INTERNAL_ERROR = 'ERR_INTERNAL_ERROR',
}

export interface CollabErrorPayload {
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
  timestamp_utc: string;
}

export class CollabError extends Error {
  public readonly code: ErrorCode;
  public readonly details?: Record<string, unknown>;
  public readonly timestamp_utc: string;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'CollabError';
    this.code = code;
    this.details = details;
    this.timestamp_utc = new Date().toISOString();
    Object.setPrototypeOf(this, CollabError.prototype);
  }

  public toJSON(): CollabErrorPayload {
    return {
      code: this.code,
      message: this.message,
      details: this.details,
      timestamp_utc: this.timestamp_utc,
    };
  }
}
