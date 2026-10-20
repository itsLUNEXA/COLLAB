/**
 * @file postgres-sync-repository.ts
 * PostgreSQL implementation of ISyncRepository matching 0001_initial_schema.sql.
 * Used when a live PostgreSQL instance is configured in DATABASE_URL.
 */

import {
  DbProject,
  DbDevice,
  DbWorkspace,
  DbSyncEvent,
  DbEditingLease,
  DbActiveConflict,
  DbCheckpoint,
  DbPublishingAuditRecord,
  DbIntegrationContract,
  DbContractVersion,
  DbModuleDependency,
  DbTask,
  DbProjectDecision,
  DbModuleIntent,
} from '@collab/db';
import { ConflictStatus, CheckpointKind, CheckpointStatus } from '@collab/protocol';
import { ISyncRepository } from './sync-repository.interface.js';

export interface DatabaseClient {
  query<T = unknown>(text: string, params?: unknown[]): Promise<{ rows: T[]; rowCount?: number | null }>;
}

export class PostgresSyncRepository implements ISyncRepository {
  constructor(private db: DatabaseClient) {}

  private mapSyncEvent(row: DbSyncEvent): DbSyncEvent {
    return {
      ...row,
      id: parseInt(String(row.id), 10),
      seq_num: parseInt(String(row.seq_num), 10),
      file_size_bytes: parseInt(String(row.file_size_bytes || 0), 10),
    };
  }

  public async getProject(projectId: string): Promise<DbProject | null> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projectId)) {
      return null;
    }
    const res = await this.db.query<DbProject>(
      'SELECT * FROM projects WHERE id = $1',
      [projectId]
    );
    if (!res.rows[0]) return null;
    return {
      ...res.rows[0],
      current_seq_num: parseInt(String(res.rows[0].current_seq_num), 10),
      github_installation_id: res.rows[0].github_installation_id
        ? parseInt(String(res.rows[0].github_installation_id), 10)
        : null,
    };
  }

  public async createProject(project: {
    id?: string;
    team_id: string;
    name: string;
    github_repo_owner?: string | null;
    github_repo_name?: string | null;
    github_installation_id?: number | null;
    default_branch?: string;
    wip_branch?: string;
    integrated_branch?: string;
  }): Promise<DbProject> {
    const res = await this.db.query<DbProject>(
      `INSERT INTO projects (
        id, team_id, name, github_repo_owner, github_repo_name, github_installation_id,
        default_branch, wip_branch, integrated_branch, current_seq_num
      ) VALUES (
        COALESCE($1, gen_random_uuid()), $2, $3, $4, $5, $6,
        COALESCE($7, 'main'), COALESCE($8, 'collab/wip'), COALESCE($9, 'collab/integrated'), 0
      )
      RETURNING *`,
      [
        project.id || null,
        project.team_id,
        project.name,
        project.github_repo_owner || null,
        project.github_repo_name || null,
        project.github_installation_id || null,
        project.default_branch || 'main',
        project.wip_branch || 'collab/wip',
        project.integrated_branch || 'collab/integrated',
      ]
    );
    const row = res.rows[0];
    return {
      ...row,
      current_seq_num: parseInt(String(row.current_seq_num), 10),
      github_installation_id: row.github_installation_id ? parseInt(String(row.github_installation_id), 10) : null,
    };
  }

  public async listProjects(teamId?: string): Promise<DbProject[]> {
    const query = teamId
      ? 'SELECT * FROM projects WHERE team_id = $1 ORDER BY created_at DESC'
      : 'SELECT * FROM projects ORDER BY created_at DESC';
    const params = teamId ? [teamId] : [];
    const res = await this.db.query<DbProject>(query, params);
    return res.rows.map((row) => ({
      ...row,
      current_seq_num: parseInt(String(row.current_seq_num), 10),
      github_installation_id: row.github_installation_id ? parseInt(String(row.github_installation_id), 10) : null,
    }));
  }

  public async getDevice(deviceId: string): Promise<DbDevice | null> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(deviceId)) {
      return null;
    }
    const res = await this.db.query<DbDevice>(
      'SELECT * FROM devices WHERE id = $1 AND is_revoked = FALSE',
      [deviceId]
    );
    return res.rows[0] ?? null;
  }

  public async registerDevice(device: {
    id?: string;
    user_id: string;
    device_name: string;
    os_info?: string | null;
    device_token_hash: string;
  }): Promise<DbDevice> {
    const res = await this.db.query<DbDevice>(
      `INSERT INTO devices (id, user_id, device_name, os_info, device_token_hash)
       VALUES (COALESCE($1, gen_random_uuid()), $2, $3, $4, $5)
       ON CONFLICT (id) DO UPDATE SET
         device_name = EXCLUDED.device_name,
         device_token_hash = EXCLUDED.device_token_hash,
         os_info = EXCLUDED.os_info,
         last_active_at = NOW()
       RETURNING *`,
      [device.id || null, device.user_id, device.device_name, device.os_info || null, device.device_token_hash]
    );
    return res.rows[0];
  }

  public async getWorkspace(projectId: string, deviceId: string): Promise<DbWorkspace | null> {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projectId) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(deviceId)
    ) {
      return null;
    }
    const res = await this.db.query<DbWorkspace>(
      'SELECT * FROM workspaces WHERE project_id = $1 AND device_id = $2 AND is_active = TRUE',
      [projectId, deviceId]
    );
    return res.rows[0] ?? null;
  }

  public async registerWorkspace(workspace: {
    project_id: string;
    device_id: string;
    local_path_hash: string;
  }): Promise<DbWorkspace> {
    const res = await this.db.query<DbWorkspace>(
      `INSERT INTO workspaces (project_id, device_id, local_path_hash, is_active)
       VALUES ($1, $2, $3, TRUE)
       ON CONFLICT (project_id, device_id) DO UPDATE SET
         local_path_hash = EXCLUDED.local_path_hash,
         is_active = TRUE,
         updated_at = NOW()
       RETURNING *`,
      [workspace.project_id, workspace.device_id, workspace.local_path_hash]
    );
    return res.rows[0];
  }

  public async addTeamMember(params: {
    teamId: string;
    name: string;
    email: string;
    role?: 'OWNER' | 'ADMIN' | 'MEMBER';
    userId?: string;
  }): Promise<{ user_id: string; name: string; email: string; role: string }> {
    const userRes = await this.db.query<{ id: string }>(
      `INSERT INTO users (id, email, name)
       VALUES (COALESCE($3, gen_random_uuid()), $1, $2)
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [params.email.toLowerCase().trim(), params.name.trim(), params.userId || null]
    );
    const userId = userRes.rows[0].id;
    const role = params.role || 'MEMBER';

    await this.db.query(
      `INSERT INTO team_members (team_id, user_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (team_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
      [params.teamId, userId, role]
    );

    return {
      user_id: userId,
      name: params.name,
      email: params.email,
      role,
    };
  }

  public async listProjectMembers(projectId: string): Promise<Array<{ user_id: string; name: string; email: string; role: string }>> {
    const res = await this.db.query<{ user_id: string; name: string; email: string; role: string }>(
      `SELECT u.id as user_id, u.name, u.email, tm.role
       FROM projects p
       JOIN team_members tm ON tm.team_id = p.team_id
       JOIN users u ON u.id = tm.user_id
       WHERE p.id = $1
       ORDER BY tm.joined_at ASC`,
      [projectId]
    );
    return res.rows;
  }

  public async getNextSequenceNum(projectId: string): Promise<number> {
    const res = await this.db.query<{ current_seq_num: string }>(
      'UPDATE projects SET current_seq_num = current_seq_num + 1, updated_at = NOW() WHERE id = $1 RETURNING current_seq_num',
      [projectId]
    );
    if (res.rows.length === 0) {
      throw new Error(`Project ${projectId} not found`);
    }
    return parseInt(res.rows[0].current_seq_num, 10);
  }

  public async getCurrentSequenceNum(projectId: string): Promise<number> {
    const res = await this.db.query<{ current_seq_num: string }>(
      'SELECT current_seq_num FROM projects WHERE id = $1',
      [projectId]
    );
    return res.rows[0] ? parseInt(res.rows[0].current_seq_num, 10) : 0;
  }

  public async getEventByClientOpId(
    projectId: string,
    clientOpId: string
  ): Promise<DbSyncEvent | null> {
    const res = await this.db.query<DbSyncEvent>(
      'SELECT * FROM sync_events WHERE project_id = $1 AND client_op_id = $2',
      [projectId, clientOpId]
    );
    return res.rows[0] ? this.mapSyncEvent(res.rows[0]) : null;
  }

  public async saveSyncEvent(event: Omit<DbSyncEvent, 'id'>): Promise<DbSyncEvent> {
    const res = await this.db.query<DbSyncEvent>(
      `INSERT INTO sync_events (
        project_id, device_id, seq_num, client_op_id, relative_path, op_type,
        base_hash, target_hash, file_size_bytes, is_binary, content_blob, blob_storage_url
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING *`,
      [
        event.project_id,
        event.device_id,
        event.seq_num,
        event.client_op_id,
        event.relative_path,
        event.op_type,
        event.base_hash,
        event.target_hash,
        event.file_size_bytes,
        event.is_binary,
        event.content_blob,
        event.blob_storage_url,
      ]
    );
    return this.mapSyncEvent(res.rows[0]);
  }

  public async getEventsRange(
    projectId: string,
    fromSeqExclusive: number,
    limit: number
  ): Promise<DbSyncEvent[]> {
    const res = await this.db.query<DbSyncEvent>(
      `SELECT * FROM sync_events 
       WHERE project_id = $1 AND seq_num > $2 
       ORDER BY seq_num ASC 
       LIMIT $3`,
      [projectId, fromSeqExclusive, limit]
    );
    return res.rows.map((r) => this.mapSyncEvent(r));
  }

  public async getActiveLease(
    projectId: string,
    relativePath: string
  ): Promise<DbEditingLease | null> {
    const res = await this.db.query<DbEditingLease>(
      `SELECT * FROM editing_leases 
       WHERE project_id = $1 AND relative_path = $2 AND lease_status = 'ACTIVE' AND expires_at > NOW()`,
      [projectId, relativePath]
    );
    return res.rows[0] ?? null;
  }

  public async claimLease(
    lease: Omit<DbEditingLease, 'id' | 'created_at'>
  ): Promise<DbEditingLease> {
    const res = await this.db.query<DbEditingLease>(
      `INSERT INTO editing_leases (
        project_id, device_id, user_id, relative_path, lease_status, handling_policy, reason, acquired_at, expires_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *`,
      [
        lease.project_id,
        lease.device_id,
        lease.user_id,
        lease.relative_path,
        lease.lease_status,
        lease.handling_policy,
        lease.reason,
        lease.acquired_at,
        lease.expires_at,
      ]
    );
    return res.rows[0];
  }

  public async releaseLease(
    leaseId: string,
    deviceId?: string,
    projectId?: string
  ): Promise<boolean> {
    const conditions = ['id = $1', "lease_status = 'ACTIVE'"];
    const params: unknown[] = [leaseId];

    if (deviceId) {
      params.push(deviceId);
      conditions.push(`device_id = $${params.length}`);
    }

    if (projectId) {
      params.push(projectId);
      conditions.push(`project_id = $${params.length}`);
    }

    const query = `UPDATE editing_leases SET lease_status = 'EXPIRED' WHERE ${conditions.join(' AND ')} RETURNING id`;
    const res = await this.db.query<{ id: string }>(query, params);
    const updatedCount = res.rowCount ?? (res.rows ? res.rows.length : 0);
    return updatedCount > 0;
  }

  // --- Conflict Queries (Phase 4) ---
  public async createConflict(
    conflict: Omit<DbActiveConflict, 'id' | 'created_at'>
  ): Promise<DbActiveConflict> {
    const res = await this.db.query<DbActiveConflict>(
      `INSERT INTO active_conflicts (
        project_id, relative_path, server_seq, device_a_id, device_b_id,
        base_hash, remote_hash, conflict_status, resolution_payload
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *`,
      [
        conflict.project_id,
        conflict.relative_path,
        conflict.server_seq,
        conflict.device_a_id,
        conflict.device_b_id,
        conflict.base_hash,
        conflict.remote_hash,
        conflict.conflict_status,
        conflict.resolution_payload ? JSON.stringify(conflict.resolution_payload) : null,
      ]
    );
    return res.rows[0];
  }

  public async getConflict(conflictId: string): Promise<DbActiveConflict | null> {
    const res = await this.db.query<DbActiveConflict>(
      'SELECT * FROM active_conflicts WHERE id = $1',
      [conflictId]
    );
    return res.rows[0] ?? null;
  }

  public async listActiveConflicts(projectId: string): Promise<DbActiveConflict[]> {
    const res = await this.db.query<DbActiveConflict>(
      `SELECT * FROM active_conflicts 
       WHERE project_id = $1 AND conflict_status NOT IN ('RESOLVED_KEEP_LOCAL', 'RESOLVED_ACCEPT_REMOTE', 'RESOLVED_MERGED')
       ORDER BY created_at DESC`,
      [projectId]
    );
    return res.rows;
  }

  public async resolveConflict(
    conflictId: string,
    resolution: ConflictStatus,
    resolutionPayload?: Record<string, unknown>
  ): Promise<DbActiveConflict | null> {
    const res = await this.db.query<DbActiveConflict>(
      `UPDATE active_conflicts 
       SET conflict_status = $1, resolution_payload = $2, resolved_at = NOW() 
       WHERE id = $3 
       RETURNING *`,
      [resolution, resolutionPayload ? JSON.stringify(resolutionPayload) : null, conflictId]
    );
    return res.rows[0] ?? null;
  }

  // --- Checkpoint Tracking (Phase 5A) ---

  public async saveCheckpoint(checkpoint: DbCheckpoint): Promise<DbCheckpoint> {
    const res = await this.db.query<DbCheckpoint>(
      `INSERT INTO checkpoints (
        id, project_id, kind, status, sync_sequence_num, tree_sha256,
        file_count, manifest, validation_report, github_target_branch,
        github_commit_sha, commit_message, created_by_user_id, created_at, published_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      RETURNING *`,
      [
        checkpoint.id,
        checkpoint.project_id,
        checkpoint.kind,
        checkpoint.status,
        checkpoint.sync_sequence_num,
        checkpoint.tree_sha256,
        checkpoint.file_count,
        JSON.stringify(checkpoint.manifest),
        checkpoint.validation_report ? JSON.stringify(checkpoint.validation_report) : null,
        checkpoint.github_target_branch,
        checkpoint.github_commit_sha,
        checkpoint.commit_message,
        checkpoint.created_by_user_id,
        checkpoint.created_at,
        checkpoint.published_at,
      ]
    );
    return res.rows[0];
  }

  public async getCheckpoint(id: string): Promise<DbCheckpoint | null> {
    const res = await this.db.query<DbCheckpoint>(
      `SELECT * FROM checkpoints WHERE id = $1`,
      [id]
    );
    return res.rows[0] ?? null;
  }

  public async listCheckpoints(projectId: string, kind?: CheckpointKind): Promise<DbCheckpoint[]> {
    if (kind) {
      const res = await this.db.query<DbCheckpoint>(
        `SELECT * FROM checkpoints WHERE project_id = $1 AND kind = $2 ORDER BY sync_sequence_num DESC`,
        [projectId, kind]
      );
      return res.rows;
    }
    const res = await this.db.query<DbCheckpoint>(
      `SELECT * FROM checkpoints WHERE project_id = $1 ORDER BY sync_sequence_num DESC`,
      [projectId]
    );
    return res.rows;
  }

  public async updateCheckpointStatus(
    id: string,
    status: CheckpointStatus,
    updates?: Partial<DbCheckpoint>
  ): Promise<DbCheckpoint | null> {
    const res = await this.db.query<DbCheckpoint>(
      `UPDATE checkpoints 
       SET status = $1, 
           github_commit_sha = COALESCE($2, github_commit_sha),
           published_at = COALESCE($3, published_at),
           validation_report = COALESCE($4, validation_report)
       WHERE id = $5 
       RETURNING *`,
      [
        status,
        updates?.github_commit_sha ?? null,
        updates?.published_at ?? null,
        updates?.validation_report ? JSON.stringify(updates.validation_report) : null,
        id,
      ]
    );
    return res.rows[0] ?? null;
  }

  // --- Publishing Audit Records (Phase 5A) ---
  public async savePublishingAuditRecord(
    record: Omit<DbPublishingAuditRecord, 'id' | 'created_at'>
  ): Promise<DbPublishingAuditRecord> {
    const res = await this.db.query<DbPublishingAuditRecord>(
      `INSERT INTO publishing_audit_records (
        project_id, checkpoint_id, target_branch, base_sha, commit_sha, status, attempt, error_message
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *`,
      [
        record.project_id,
        record.checkpoint_id,
        record.target_branch,
        record.base_sha,
        record.commit_sha,
        record.status,
        record.attempt,
        record.error_message,
      ]
    );
    return res.rows[0];
  }

  public async listPublishingAuditRecords(
    projectId: string,
    checkpointId?: string
  ): Promise<DbPublishingAuditRecord[]> {
    if (checkpointId) {
      const res = await this.db.query<DbPublishingAuditRecord>(
        `SELECT * FROM publishing_audit_records 
         WHERE project_id = $1 AND checkpoint_id = $2 
         ORDER BY created_at ASC, attempt ASC`,
        [projectId, checkpointId]
      );
      return res.rows;
    }
    const res = await this.db.query<DbPublishingAuditRecord>(
      `SELECT * FROM publishing_audit_records 
       WHERE project_id = $1 
       ORDER BY created_at ASC, attempt ASC`,
      [projectId]
    );
    return res.rows;
  }

  // --- Phase 5B: Contracts, Shared Memory & Module Ownership ---

  public async getContract(projectId: string, identifier: string): Promise<DbIntegrationContract | null> {
    const res = await this.db.query<DbIntegrationContract>(
      `SELECT * FROM integration_contracts WHERE project_id = $1 AND identifier = $2`,
      [projectId, identifier]
    );
    return res.rows[0] ?? null;
  }

  public async listContracts(projectId: string): Promise<DbIntegrationContract[]> {
    const res = await this.db.query<DbIntegrationContract>(
      `SELECT * FROM integration_contracts WHERE project_id = $1 ORDER BY identifier ASC`,
      [projectId]
    );
    return res.rows;
  }

  public async saveContract(contract: DbIntegrationContract): Promise<DbIntegrationContract> {
    const res = await this.db.query<DbIntegrationContract>(
      `INSERT INTO integration_contracts (
        id, project_id, contract_type, identifier, owner_module,
        current_version, status, current_schema_hash, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (project_id, identifier) DO UPDATE SET
        current_version = EXCLUDED.current_version,
        status = EXCLUDED.status,
        current_schema_hash = EXCLUDED.current_schema_hash,
        updated_at = NOW()
      RETURNING *`,
      [
        contract.id,
        contract.project_id,
        contract.contract_type,
        contract.identifier,
        contract.owner_module,
        contract.current_version,
        contract.status,
        contract.current_schema_hash,
        contract.created_at,
        contract.updated_at,
      ]
    );
    return res.rows[0];
  }

  public async getContractVersion(contractId: string, version: number): Promise<DbContractVersion | null> {
    const res = await this.db.query<DbContractVersion>(
      `SELECT * FROM contract_versions WHERE contract_id = $1 AND version = $2`,
      [contractId, version]
    );
    return res.rows[0] ?? null;
  }

  public async listContractVersions(contractId: string): Promise<DbContractVersion[]> {
    const res = await this.db.query<DbContractVersion>(
      `SELECT * FROM contract_versions WHERE contract_id = $1 ORDER BY version DESC`,
      [contractId]
    );
    return res.rows;
  }

  public async saveContractVersion(version: DbContractVersion): Promise<DbContractVersion> {
    const res = await this.db.query<DbContractVersion>(
      `INSERT INTO contract_versions (
        id, contract_id, version, identifier, contract_type, owner_module,
        schema_definition, schema_hash, confidence, supported_language_framework,
        breaking_changes, created_by_device_id, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      RETURNING *`,
      [
        version.id,
        version.contract_id,
        version.version,
        version.identifier,
        version.contract_type,
        version.owner_module,
        JSON.stringify(version.schema_definition),
        version.schema_hash,
        version.confidence,
        version.supported_language_framework,
        JSON.stringify(version.breaking_changes),
        version.created_by_device_id,
        version.created_at,
      ]
    );
    return res.rows[0];
  }

  public async getModuleDependencies(projectId: string, contractId?: string): Promise<DbModuleDependency[]> {
    if (contractId) {
      const res = await this.db.query<DbModuleDependency>(
        `SELECT * FROM module_dependencies WHERE project_id = $1 AND contract_id = $2`,
        [projectId, contractId]
      );
      return res.rows;
    }
    const res = await this.db.query<DbModuleDependency>(
      `SELECT * FROM module_dependencies WHERE project_id = $1`,
      [projectId]
    );
    return res.rows;
  }

  public async saveModuleDependency(dep: DbModuleDependency): Promise<DbModuleDependency> {
    const res = await this.db.query<DbModuleDependency>(
      `INSERT INTO module_dependencies (
        id, project_id, consumer_module, contract_id, last_verified_version, is_stale, stale_reason, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (project_id, consumer_module, contract_id) DO UPDATE SET
        last_verified_version = EXCLUDED.last_verified_version,
        is_stale = EXCLUDED.is_stale,
        stale_reason = EXCLUDED.stale_reason,
        updated_at = NOW()
      RETURNING *`,
      [
        dep.id,
        dep.project_id,
        dep.consumer_module,
        dep.contract_id,
        dep.last_verified_version,
        dep.is_stale,
        dep.stale_reason,
        dep.updated_at,
      ]
    );
    return res.rows[0];
  }

  public async markConsumersStale(projectId: string, contractId: string, reason: string): Promise<number> {
    const res = await this.db.query(
      `UPDATE module_dependencies 
       SET is_stale = true, stale_reason = $1, updated_at = NOW()
       WHERE project_id = $2 AND contract_id = $3`,
      [reason, projectId, contractId]
    );
    return (res as unknown as { rowCount?: number }).rowCount ?? 0;
  }

  public async listTasks(projectId: string): Promise<DbTask[]> {
    const res = await this.db.query<DbTask>(
      `SELECT * FROM tasks WHERE project_id = $1 ORDER BY created_at DESC`,
      [projectId]
    );
    return res.rows;
  }

  public async saveTask(task: DbTask): Promise<DbTask> {
    const res = await this.db.query<DbTask>(
      `INSERT INTO tasks (
        id, project_id, title, description, assigned_to_user_id, target_module, status, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *`,
      [
        task.id,
        task.project_id,
        task.title,
        task.description,
        task.assigned_to_user_id,
        task.target_module,
        task.status,
        task.created_at,
        task.updated_at,
      ]
    );
    return res.rows[0];
  }

  public async listProjectDecisions(projectId: string): Promise<DbProjectDecision[]> {
    const res = await this.db.query<DbProjectDecision>(
      `SELECT * FROM project_decisions WHERE project_id = $1 ORDER BY created_at DESC`,
      [projectId]
    );
    return res.rows;
  }

  public async saveProjectDecision(decision: DbProjectDecision): Promise<DbProjectDecision> {
    const res = await this.db.query<DbProjectDecision>(
      `INSERT INTO project_decisions (
        id, project_id, title, rationale, tags, decided_by_user_id, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *`,
      [
        decision.id,
        decision.project_id,
        decision.title,
        decision.rationale,
        decision.tags,
        decision.decided_by_user_id,
        decision.created_at,
      ]
    );
    return res.rows[0];
  }

  // --- Module Ownership & Intent (Phase 5B Shared AI Memory) ---
  public async listModuleIntents(projectId: string): Promise<DbModuleIntent[]> {
    const res = await this.db.query<DbModuleIntent>(
      `SELECT * FROM module_intents 
       WHERE project_id = $1 AND expires_at > NOW() 
       ORDER BY acquired_at DESC`,
      [projectId]
    );
    return res.rows;
  }

  public async claimModuleIntent(intent: DbModuleIntent): Promise<DbModuleIntent> {
    const res = await this.db.query<DbModuleIntent>(
      `INSERT INTO module_intents (
        id, project_id, device_id, user_id, module_name, intent_description, acquired_at, expires_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (project_id, module_name, device_id) DO UPDATE SET
        user_id = EXCLUDED.user_id,
        intent_description = EXCLUDED.intent_description,
        acquired_at = EXCLUDED.acquired_at,
        expires_at = EXCLUDED.expires_at
      RETURNING *`,
      [
        intent.id,
        intent.project_id,
        intent.device_id,
        intent.user_id,
        intent.module_name,
        intent.intent_description,
        intent.acquired_at,
        intent.expires_at,
      ]
    );
    return res.rows[0];
  }
}

