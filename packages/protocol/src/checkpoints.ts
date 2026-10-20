/**
 * @file checkpoints.ts
 * Work-in-Progress and Verified Integration Checkpoint schemas.
 * Enforces Safeguards 2 and 3: Separates WIP from verified snapshots, uses immutable tree hashes,
 * and ensures only verified snapshots are published to GitHub.
 */

import crypto from 'node:crypto';
import { z } from 'zod';
import { EntityIdSchema, Sha256HashSchema } from './sync-events.js';
import { CheckpointKind, CheckpointStatus } from './opcodes.js';

// File Manifest Item for Snapshot Identity (Safeguard 3)
export const FileManifestItemSchema = z.object({
  relative_path: z.string().min(1),
  content_hash: Sha256HashSchema,
  size_bytes: z.number().int().nonnegative(),
});
export type FileManifestItem = z.infer<typeof FileManifestItemSchema>;

// Immutable Snapshot Identity (Safeguard 3)
export const SnapshotIdentitySchema = z.object({
  tree_sha256: Sha256HashSchema, // SHA-256 computed across sorted manifest items
  file_count: z.number().int().nonnegative(),
  manifest: z.array(FileManifestItemSchema),
});
export type SnapshotIdentity = z.infer<typeof SnapshotIdentitySchema>;

export const ValidationIssueSchema = z.object({
  severity: z.enum(['ERROR', 'WARNING']),
  check_type: z.enum([
    'TYPECHECK',
    'CONTRACT_CONFORMANCE',
    'IMPORT_INTEGRITY',
    'DATABASE_SCHEMA',
    'CONFLICT_CHECK',
  ]),
  module: z.string(),
  message: z.string(),
  file_path: z.string().optional(),
  line_number: z.number().int().positive().optional(),
});
export type ValidationIssue = z.infer<typeof ValidationIssueSchema>;

export const CheckpointValidationReportSchema = z.object({
  snapshot_tree_sha256: Sha256HashSchema,
  started_at_utc: z.string().datetime(),
  completed_at_utc: z.string().datetime(),
  passed: z.boolean(),
  issues: z.array(ValidationIssueSchema).default([]),
  typecheck_passed: z.boolean(),
  contracts_conformance_passed: z.boolean(),
  has_unresolved_conflicts: z.boolean(),
});
export type CheckpointValidationReport = z.infer<typeof CheckpointValidationReportSchema>;

// Work-in-Progress Snapshot (Safeguard 2: Never discarded if verification fails)
export const WIPCheckpointSchema = z.object({
  id: EntityIdSchema,
  project_id: EntityIdSchema,
  kind: z.literal(CheckpointKind.WIP_SNAPSHOT),
  sync_sequence_num: z.number().int().nonnegative(),
  snapshot: SnapshotIdentitySchema,
  created_by_device_id: EntityIdSchema,
  label: z.string().optional(),
  created_at_utc: z.string().datetime(),
});
export type WIPCheckpoint = z.infer<typeof WIPCheckpointSchema>;

// Verified Integration Checkpoint (Safeguard 3: Only published when passed)
export const IntegrationCheckpointSchema = z.object({
  id: EntityIdSchema,
  project_id: EntityIdSchema,
  kind: z.literal(CheckpointKind.VERIFIED_INTEGRATION),
  status: z.nativeEnum(CheckpointStatus),
  sync_sequence_num: z.number().int().nonnegative(),
  snapshot: SnapshotIdentitySchema,
  validation_report: CheckpointValidationReportSchema.nullable(),
  github_target_branch: z.string().default('collab/integrated'),
  github_commit_sha: z.string().regex(/^[a-f0-9]{40}$/i).nullable(), // 40-char Git SHA
  commit_message: z.string().min(1),
  created_by_user_id: EntityIdSchema,
  created_at_utc: z.string().datetime(),
  published_at_utc: z.string().datetime().nullable(),
});
export type IntegrationCheckpoint = z.infer<typeof IntegrationCheckpointSchema>;

/**
 * Computes an immutable, canonical SnapshotIdentity (Safeguard 3)
 * Files are sorted alphabetically by relative_path to guarantee determinism.
 */
export function computeSnapshotIdentity(
  files: Array<{ relative_path: string; content: string | Buffer }>
): SnapshotIdentity {
  const sorted = [...files].sort((a, b) => a.relative_path.localeCompare(b.relative_path));
  const manifest: FileManifestItem[] = sorted.map((f) => {
    const buf = typeof f.content === 'string' ? Buffer.from(f.content, 'utf-8') : f.content;
    const hash = crypto.createHash('sha256').update(buf).digest('hex');
    return {
      relative_path: f.relative_path,
      content_hash: hash,
      size_bytes: buf.length,
    };
  });

  const manifestStr = manifest
    .map((m) => `${m.relative_path}:${m.content_hash}:${m.size_bytes}`)
    .join('\n');
  const treeSha = crypto.createHash('sha256').update(manifestStr).digest('hex');

  return {
    tree_sha256: treeSha,
    file_count: manifest.length,
    manifest,
  };
}

