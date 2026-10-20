/**
 * @file leases.ts
 * Editing lease protocols and file-protection models.
 * Enforces Safeguard 1: Prevents incoming sync events from destroying unsaved or actively edited work.
 */

import { z } from 'zod';
import { EntityIdSchema } from './sync-events.js';
import { LeaseStatus } from './opcodes.js';

export enum IncomingChangeHandlingPolicy {
  ISOLATE_TO_SHADOW = 'ISOLATE_TO_SHADOW', // Write to <file>.collab-remote-<seq>
  AUTO_MERGE_IF_CLEAN = 'AUTO_MERGE_IF_CLEAN', // Run line merge; if conflict, isolate
  PROMPT_USER = 'PROMPT_USER', // Require explicit manual confirmation before writing
}

export const EditingLeaseSchema = z.object({
  id: EntityIdSchema,
  project_id: EntityIdSchema,
  device_id: EntityIdSchema,
  user_id: EntityIdSchema,
  relative_path: z.string().min(1),
  lease_status: z.nativeEnum(LeaseStatus),
  handling_policy: z.nativeEnum(IncomingChangeHandlingPolicy).default(
    IncomingChangeHandlingPolicy.ISOLATE_TO_SHADOW
  ),
  reason: z.string().optional(), // e.g. "Maheen is editing auth route in Antigravity IDE"
  acquired_at_utc: z.string().datetime(),
  expires_at_utc: z.string().datetime(),
});
export type EditingLease = z.infer<typeof EditingLeaseSchema>;

export const ClaimLeaseRequestPayloadSchema = z.object({
  relative_path: z.string().min(1),
  duration_seconds: z.number().int().min(60).max(3600).default(900), // 15 min default
  handling_policy: z.nativeEnum(IncomingChangeHandlingPolicy).default(
    IncomingChangeHandlingPolicy.ISOLATE_TO_SHADOW
  ),
  reason: z.string().optional(),
});
export type ClaimLeaseRequestPayload = z.infer<typeof ClaimLeaseRequestPayloadSchema>;

export const ReleaseLeaseRequestPayloadSchema = z.object({
  lease_id: EntityIdSchema,
  relative_path: z.string().min(1),
});
export type ReleaseLeaseRequestPayload = z.infer<typeof ReleaseLeaseRequestPayloadSchema>;
