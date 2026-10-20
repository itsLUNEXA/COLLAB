/**
 * @file sync-repository.interface.ts
 * Abstract repository interface for project, device, event, and lease persistence.
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

export interface ISyncRepository {
  // Project & Device queries
  getProject(projectId: string): Promise<DbProject | null>;
  createProject(project: {
    id?: string;
    team_id: string;
    name: string;
    github_repo_owner?: string | null;
    github_repo_name?: string | null;
    github_installation_id?: number | null;
    default_branch?: string;
    wip_branch?: string;
    integrated_branch?: string;
  }): Promise<DbProject>;
  listProjects(teamId?: string): Promise<DbProject[]>;
  getDevice(deviceId: string): Promise<DbDevice | null>;
  registerDevice(device: {
    id?: string;
    user_id: string;
    device_name: string;
    os_info?: string | null;
    device_token_hash: string;
  }): Promise<DbDevice>;
  getWorkspace(projectId: string, deviceId: string): Promise<DbWorkspace | null>;
  registerWorkspace(workspace: {
    project_id: string;
    device_id: string;
    local_path_hash: string;
  }): Promise<DbWorkspace>;
  addTeamMember(params: {
    teamId: string;
    name: string;
    email: string;
    role?: 'OWNER' | 'ADMIN' | 'MEMBER';
    userId?: string;
  }): Promise<{ user_id: string; name: string; email: string; role: string }>;
  listProjectMembers(projectId: string): Promise<Array<{ user_id: string; name: string; email: string; role: string }>>;

  // Monotonic sequence management (Task 5)
  getNextSequenceNum(projectId: string): Promise<number>;
  getCurrentSequenceNum(projectId: string): Promise<number>;

  // Event persistence & Idempotency (Tasks 5 & 6)
  getEventByClientOpId(projectId: string, clientOpId: string): Promise<DbSyncEvent | null>;
  saveSyncEvent(event: Omit<DbSyncEvent, 'id'>): Promise<DbSyncEvent>;
  getEventsRange(projectId: string, fromSeqExclusive: number, limit: number): Promise<DbSyncEvent[]>;

  // Editing Leases (Safeguard 1)
  getActiveLease(projectId: string, relativePath: string): Promise<DbEditingLease | null>;
  claimLease(lease: Omit<DbEditingLease, 'id' | 'created_at'>): Promise<DbEditingLease>;
  releaseLease(leaseId: string, deviceId?: string, projectId?: string): Promise<boolean>;

  // Conflict Tracking & Resolution (Phase 4)
  createConflict(conflict: Omit<DbActiveConflict, 'id' | 'created_at'>): Promise<DbActiveConflict>;
  getConflict(conflictId: string): Promise<DbActiveConflict | null>;
  listActiveConflicts(projectId: string): Promise<DbActiveConflict[]>;
  resolveConflict(
    conflictId: string,
    resolution: ConflictStatus,
    resolutionPayload?: Record<string, unknown>
  ): Promise<DbActiveConflict | null>;

  // Checkpoints & GitHub Publishing (Phase 5A)
  saveCheckpoint(checkpoint: DbCheckpoint): Promise<DbCheckpoint>;
  getCheckpoint(id: string): Promise<DbCheckpoint | null>;
  listCheckpoints(projectId: string, kind?: CheckpointKind): Promise<DbCheckpoint[]>;
  updateCheckpointStatus(
    id: string,
    status: CheckpointStatus,
    updates?: Partial<DbCheckpoint>
  ): Promise<DbCheckpoint | null>;

  // Publishing Audit Records (Phase 5A)
  savePublishingAuditRecord(
    record: Omit<DbPublishingAuditRecord, 'id' | 'created_at'>
  ): Promise<DbPublishingAuditRecord>;
  listPublishingAuditRecords(
    projectId: string,
    checkpointId?: string
  ): Promise<DbPublishingAuditRecord[]>;

  // --- Phase 5B: Shared AI Context & Antigravity MCP ---
  // Contracts & Versions (Safeguards 4 & 7)
  getContract(projectId: string, identifier: string): Promise<DbIntegrationContract | null>;
  listContracts(projectId: string): Promise<DbIntegrationContract[]>;
  saveContract(contract: DbIntegrationContract): Promise<DbIntegrationContract>;
  getContractVersion(contractId: string, version: number): Promise<DbContractVersion | null>;
  listContractVersions(contractId: string): Promise<DbContractVersion[]>;
  saveContractVersion(version: DbContractVersion): Promise<DbContractVersion>;

  // Module Dependencies & Stale Consumers
  getModuleDependencies(projectId: string, contractId?: string): Promise<DbModuleDependency[]>;
  saveModuleDependency(dep: DbModuleDependency): Promise<DbModuleDependency>;
  markConsumersStale(projectId: string, contractId: string, reason: string): Promise<number>;

  // Tasks & Decisions (Shared Memory)
  listTasks(projectId: string): Promise<DbTask[]>;
  saveTask(task: DbTask): Promise<DbTask>;
  listProjectDecisions(projectId: string): Promise<DbProjectDecision[]>;
  saveProjectDecision(decision: DbProjectDecision): Promise<DbProjectDecision>;

  // Module Ownership & Intent
  listModuleIntents(projectId: string): Promise<DbModuleIntent[]>;
  claimModuleIntent(intent: DbModuleIntent): Promise<DbModuleIntent>;
}


