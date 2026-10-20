/**
 * @file contracts.ts
 * Machine-readable integration contract schemas and versioned dependency tracking.
 * Enforces Safeguards 4 and 7: Explicit schemas, confidence labels, and immutable version history.
 */

import { z } from 'zod';
import { EntityIdSchema, Sha256HashSchema } from './sync-events.js';
import { ContractType, ContractStatus } from './opcodes.js';

export enum ContractConfidenceLevel {
  VERIFIED_EXPLICIT = 'VERIFIED_EXPLICIT', // Explicitly authored OpenAPI / JSON Schema
  INFERRED_HIGH = 'INFERRED_HIGH', // Deterministic AST parse from supported TypeScript patterns
  INFERRED_UNCERTAIN = 'INFERRED_UNCERTAIN', // Heuristic/dynamic inference - requires human review
}

export enum BreakingChangeSeverity {
  INFO = 'INFO', // Added optional field, relaxed constraint
  WARNING = 'WARNING', // Deprecated endpoint, changed description
  BREAKING = 'BREAKING', // Removed field, changed type, added required param
}

export const BreakingChangeDetailSchema = z.object({
  severity: z.nativeEnum(BreakingChangeSeverity),
  path: z.string(), // e.g. "responses.200.content.application/json.schema.userId"
  message: z.string(), // e.g. "Property 'userId' was removed"
  previous_type: z.string().optional(),
  current_type: z.string().optional(),
});
export type BreakingChangeDetail = z.infer<typeof BreakingChangeDetailSchema>;

// Immutable Contract Version Entry (Safeguard 7)
export const ContractVersionRecordSchema = z.object({
  id: EntityIdSchema,
  contract_id: EntityIdSchema,
  version: z.number().int().positive(),
  identifier: z.string().min(1), // e.g. "POST /api/v1/auth/login"
  contract_type: z.nativeEnum(ContractType),
  owner_module: z.string().min(1), // e.g. "backend-auth"
  schema_definition: z.record(z.unknown()), // OpenAPI 3.1 object / JSON Schema
  schema_hash: Sha256HashSchema,
  confidence: z.nativeEnum(ContractConfidenceLevel),
  supported_language_framework: z.string(), // e.g. "OpenAPI 3.1" or "TypeScript 5.x / Express"
  breaking_changes: z.array(BreakingChangeDetailSchema).default([]),
  created_by_device_id: EntityIdSchema,
  created_at_utc: z.string().datetime(),
});
export type ContractVersionRecord = z.infer<typeof ContractVersionRecordSchema>;

// Active Contract State in the Registry
export const IntegrationContractSchema = z.object({
  id: EntityIdSchema,
  project_id: EntityIdSchema,
  identifier: z.string().min(1),
  contract_type: z.nativeEnum(ContractType),
  owner_module: z.string().min(1),
  current_version: z.number().int().positive(),
  status: z.nativeEnum(ContractStatus),
  current_schema_hash: Sha256HashSchema,
  last_updated_at_utc: z.string().datetime(),
});
export type IntegrationContract = z.infer<typeof IntegrationContractSchema>;

// Module Dependency Specification
export const ModuleDependencySchema = z.object({
  id: EntityIdSchema,
  project_id: EntityIdSchema,
  consumer_module: z.string().min(1), // e.g. "frontend-auth"
  contract_id: EntityIdSchema,
  last_verified_version: z.number().int().positive(),
  is_stale: z.boolean(),
  stale_reason: z.string().nullable(),
  updated_at_utc: z.string().datetime(),
});
export type ModuleDependency = z.infer<typeof ModuleDependencySchema>;

// Contract Invalidation Alert Payload (Pushed to affected companion)
export const ContractInvalidationAlertPayloadSchema = z.object({
  contract_id: EntityIdSchema,
  identifier: z.string(),
  new_version: z.number().int().positive(),
  previous_version: z.number().int().positive(),
  consumer_modules_affected: z.array(z.string()),
  breaking_changes: z.array(BreakingChangeDetailSchema),
  message: z.string(),
  emitted_at_utc: z.string().datetime(),
});
export type ContractInvalidationAlertPayload = z.infer<typeof ContractInvalidationAlertPayloadSchema>;
