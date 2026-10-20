export interface Project {
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

export interface DeviceSession {
  device_id: string;
  user_id: string;
  connected_at: string;
  last_heartbeat: string;
  is_online: boolean;
}

export interface SyncEventItem {
  seq_num: number;
  client_op_id: string;
  device_id: string;
  relative_path: string;
  op_type: 'FILE_CREATE' | 'FILE_UPDATE' | 'FILE_DELETE' | 'FILE_RENAME';
  base_hash: string | null;
  target_hash: string;
  is_binary: boolean;
  created_at: string;
}

export interface ActiveConflict {
  id: string;
  project_id: string;
  relative_path: string;
  server_seq: number;
  device_a_id: string;
  device_b_id: string;
  base_hash: string | null;
  remote_hash: string;
  conflict_status: 'DETECTED' | 'UNDER_REVIEW' | 'RESOLVED_KEEP_LOCAL' | 'RESOLVED_ACCEPT_REMOTE' | 'RESOLVED_MERGED';
  resolution_payload: Record<string, unknown> | null;
  resolved_at: string | null;
  created_at: string;
}

export interface IntegrationContract {
  id: string;
  project_id: string;
  contract_type: string;
  identifier: string;
  owner_module: string;
  current_version: number;
  status: 'DRAFT' | 'ACTIVE' | 'DEPRECATED' | 'STALE';
  current_schema_hash: string;
  created_at: string;
  updated_at: string;
  consumers: Array<{
    consumer_module: string;
    last_verified_version: number;
    is_stale: boolean;
    stale_reason: string | null;
  }>;
}

export interface Task {
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

export interface ModuleIntent {
  id: string;
  project_id: string;
  device_id: string;
  user_id: string;
  module_name: string;
  intent_description: string;
  acquired_at: string;
  expires_at: string;
}

export interface Checkpoint {
  id: string;
  project_id: string;
  kind: 'WIP_SNAPSHOT' | 'VERIFIED_INTEGRATION';
  status: 'PENDING' | 'RUNNING_CHECKS' | 'PASSED' | 'FAILED' | 'PUBLISHED';
  sync_sequence_num: number;
  tree_sha256: string;
  file_count: number;
  manifest: Array<{ relative_path: string; content_hash: string; size_bytes: number }>;
  validation_report: {
    passed: boolean;
    issues: Array<{ severity: 'ERROR' | 'WARNING'; message: string; check_type: string; file_path?: string }>;
    typecheck_passed: boolean;
    contracts_conformance_passed: boolean;
    has_unresolved_conflicts: boolean;
  } | null;
  github_target_branch: string | null;
  github_commit_sha: string | null;
  commit_message: string | null;
  created_at: string;
  published_at: string | null;
}

export interface PublishingAuditRecord {
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

export interface Diagnostics {
  project_id: string;
  current_seq_num: number;
  connected_peers: number;
  verification: {
    ready_to_publish: boolean;
    active_conflicts_count: number;
    stale_consumers: Array<{ consumer_module: string; contract_id: string; stale_reason: string | null }>;
    latest_checkpoint: { kind: string; status: string; tree_sha256: string; github_commit_sha: string | null } | null;
    blocking_reasons: string[];
  };
  server_time: string;
  storage_type: string;
}

export interface ProjectMember {
  user_id: string;
  name: string;
  email: string;
  role: string;
  is_online?: boolean;
}

export interface ProvisionedDevice {
  device: {
    id: string;
    device_name: string;
    user_id: string;
  };
  deviceSecret: string;
}
