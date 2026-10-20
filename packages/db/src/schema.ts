/**
 * @file schema.ts
 * Strongly-typed database entity interfaces corresponding to 0001_initial_schema.sql.
 */

import {
  SyncOpType,
  ContractType,
  ContractStatus,
  CheckpointKind,
  CheckpointStatus,
  ConflictStatus,
  LeaseStatus,
  ContractConfidenceLevel,
} from '@collab/protocol';

export interface DbTeam {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

export interface DbUser {
  id: string;
  email: string;
  name: string;
  avatar_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface DbTeamMember {
  id: string;
  team_id: string;
  user_id: string;
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
  joined_at: string;
}

export interface DbProject {
  id: string;
  team_id: string;
  name: string;
  github_repo_owner: string | null;
  github_repo_name: string | null;
  github_installation_id: number | null;
  default_branch: string;
  wip_branch: string;
  integrated_branch: string;
  current_seq_num: number;
  created_at: string;
  updated_at: string;
}

export interface DbDevice {
  id: string;
  user_id: string;
  device_name: string;
  os_info: string | null;
  device_token_hash: string;
  is_revoked: boolean;
  last_active_at: string;
  created_at: string;
}

export interface DbWorkspace {
  id: string;
  project_id: string;
  device_id: string;
  local_path_hash: string; // Safeguard 5
  is_active: boolean;
  last_synced_seq: number;
  created_at: string;
  updated_at: string;
}

export interface DbSyncEvent {
  id: number;
  project_id: string;
  device_id: string;
  seq_num: number;
  client_op_id: string;
  relative_path: string;
  op_type: SyncOpType;
  base_hash: string | null;
  target_hash: string;
  file_size_bytes: number;
  is_binary: boolean;
  content_blob: string | null;
  blob_storage_url: string | null;
  created_at: string;
}

export interface DbEditingLease {
  id: string;
  project_id: string;
  device_id: string;
  user_id: string;
  relative_path: string;
  lease_status: LeaseStatus;
  handling_policy: 'ISOLATE_TO_SHADOW' | 'AUTO_MERGE_IF_CLEAN' | 'PROMPT_USER';
  reason: string | null;
  acquired_at: string;
  expires_at: string;
  created_at: string;
}

export interface DbIntegrationContract {
  id: string;
  project_id: string;
  contract_type: ContractType;
  identifier: string;
  owner_module: string;
  current_version: number;
  status: ContractStatus;
  current_schema_hash: string;
  created_at: string;
  updated_at: string;
}

export interface DbContractVersion {
  id: string;
  contract_id: string;
  version: number;
  identifier: string;
  contract_type: string;
  owner_module: string;
  schema_definition: Record<string, unknown>;
  schema_hash: string;
  confidence: ContractConfidenceLevel;
  supported_language_framework: string;
  breaking_changes: unknown[];
  created_by_device_id: string;
  created_at: string;
}

export interface DbActiveConflict {
  id: string;
  project_id: string;
  relative_path: string;
  server_seq: number;
  device_a_id: string;
  device_b_id: string;
  base_hash: string | null;
  remote_hash: string;
  conflict_status: ConflictStatus;
  resolution_payload: Record<string, unknown> | null;
  resolved_at: string | null;
  created_at: string;
}

export interface DbCheckpoint {
  id: string;
  project_id: string;
  kind: CheckpointKind;
  status: CheckpointStatus;
  sync_sequence_num: number;
  tree_sha256: string; // Safeguard 3
  file_count: number;
  manifest: unknown[];
  validation_report: Record<string, unknown> | null;
  github_target_branch: string | null;
  github_commit_sha: string | null;
  commit_message: string | null;
  created_by_user_id: string | null;
  created_at: string;
  published_at: string | null;
}

export interface DbPublishingAuditRecord {
  id: string;
  project_id: string;
  checkpoint_id: string;
  target_branch: string;
  base_sha: string | null;
  commit_sha: string | null;
  status: 'SUCCESS' | 'FAILED' | 'RETRYING';
  attempt: number;
  error_message: string | null;
  created_at: string;
}

export interface DbModuleDependency {
  id: string;
  project_id: string;
  consumer_module: string;
  contract_id: string;
  last_verified_version: number;
  is_stale: boolean;
  stale_reason: string | null;
  updated_at: string;
}

export interface DbTask {
  id: string;
  project_id: string;
  title: string;
  description: string | null;
  assigned_to_user_id: string | null;
  target_module: string | null;
  status: 'TODO' | 'IN_PROGRESS' | 'REVIEW' | 'DONE';
  created_at: string;
  updated_at: string;
}

export interface DbProjectDecision {
  id: string;
  project_id: string;
  title: string;
  rationale: string;
  tags: string[];
  decided_by_user_id: string | null;
  created_at: string;
}

export interface DbModuleIntent {
  id: string;
  project_id: string;
  device_id: string;
  user_id: string;
  module_name: string;
  intent_description: string;
  acquired_at: string;
  expires_at: string;
  created_at?: string;
}


