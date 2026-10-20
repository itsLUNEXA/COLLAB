/**
 * @file memory-sync-repository.ts
 * High-performance, in-memory repository implementing ISyncRepository.
 * Used for fast unit testing and zero-dependency local development (Low RAM policy).
 */

import * as crypto from 'node:crypto';
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
import { LeaseStatus, ConflictStatus, CheckpointKind, CheckpointStatus } from '@collab/protocol';
import { ISyncRepository } from './sync-repository.interface.js';

export class MemorySyncRepository implements ISyncRepository {
  private projects = new Map<string, DbProject>();
  private devices = new Map<string, DbDevice>();
  private workspaces = new Map<string, DbWorkspace>(); // key: `${projectId}:${deviceId}`
  private members = new Map<string, Array<{ user_id: string; name: string; email: string; role: string }>>();

  private events = new Map<string, DbSyncEvent[]>(); // key: projectId
  private eventsByClientOpId = new Map<string, DbSyncEvent>(); // key: `${projectId}:${clientOpId}`
  private nextEventId = 1;

  private leases = new Map<string, DbEditingLease>(); // key: leaseId

  // --- Seed Helpers for Testing & Development ---
  public seedProject(project: DbProject): void {
    this.projects.set(project.id, { ...project });
    if (!this.events.has(project.id)) {
      this.events.set(project.id, []);
    }
  }

  public seedDevice(device: DbDevice): void {
    this.devices.set(device.id, { ...device });
  }

  public seedWorkspace(workspace: DbWorkspace): void {
    this.workspaces.set(`${workspace.project_id}:${workspace.device_id}`, { ...workspace });
  }

  // --- ISyncRepository Implementation ---

  public async getProject(projectId: string): Promise<DbProject | null> {
    return this.projects.get(projectId) ?? null;
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
    const p: DbProject = {
      id: project.id || crypto.randomUUID(),
      team_id: project.team_id,
      name: project.name,
      github_repo_owner: project.github_repo_owner || null,
      github_repo_name: project.github_repo_name || null,
      github_installation_id: project.github_installation_id || null,
      default_branch: project.default_branch || 'main',
      wip_branch: project.wip_branch || 'collab/wip',
      integrated_branch: project.integrated_branch || 'collab/integrated',
      current_seq_num: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.projects.set(p.id, p);
    this.events.set(p.id, []);
    return p;
  }

  public async listProjects(teamId?: string): Promise<DbProject[]> {
    const list = Array.from(this.projects.values());
    if (teamId) return list.filter((p) => p.team_id === teamId);
    return list;
  }

  public async getDevice(deviceId: string): Promise<DbDevice | null> {
    return this.devices.get(deviceId) ?? null;
  }

  public async registerDevice(device: {
    id?: string;
    user_id: string;
    device_name: string;
    os_info?: string | null;
    device_token_hash: string;
  }): Promise<DbDevice> {
    const d: DbDevice = {
      id: device.id || crypto.randomUUID(),
      user_id: device.user_id,
      device_name: device.device_name,
      os_info: device.os_info || null,
      device_token_hash: device.device_token_hash,
      is_revoked: false,
      last_active_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    };
    this.devices.set(d.id, d);
    return d;
  }

  public async getWorkspace(projectId: string, deviceId: string): Promise<DbWorkspace | null> {
    return this.workspaces.get(`${projectId}:${deviceId}`) ?? null;
  }

  public async registerWorkspace(workspace: {
    project_id: string;
    device_id: string;
    local_path_hash: string;
  }): Promise<DbWorkspace> {
    const w: DbWorkspace = {
      id: crypto.randomUUID(),
      project_id: workspace.project_id,
      device_id: workspace.device_id,
      local_path_hash: workspace.local_path_hash,
      is_active: true,
      last_synced_seq: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.workspaces.set(`${workspace.project_id}:${workspace.device_id}`, w);
    return w;
  }

  public async addTeamMember(params: {
    teamId: string;
    name: string;
    email: string;
    role?: 'OWNER' | 'ADMIN' | 'MEMBER';
    userId?: string;
  }): Promise<{ user_id: string; name: string; email: string; role: string }> {
    const member = {
      user_id: params.userId || crypto.randomUUID(),
      name: params.name,
      email: params.email,
      role: params.role || 'MEMBER',
    };
    const list = this.members.get(params.teamId) || [];
    const existingIdx = list.findIndex((m) => m.user_id === member.user_id || m.email.toLowerCase() === member.email.toLowerCase());
    if (existingIdx >= 0) {
      list[existingIdx] = member;
    } else {
      list.push(member);
    }
    this.members.set(params.teamId, list);
    return member;
  }

  public async listProjectMembers(projectId: string): Promise<Array<{ user_id: string; name: string; email: string; role: string }>> {
    const project = this.projects.get(projectId);
    if (!project) return [];
    return this.members.get(project.team_id) || [];
  }

  public async getNextSequenceNum(projectId: string): Promise<number> {
    const project = this.projects.get(projectId);
    if (!project) {
      throw new Error(`Project ${projectId} not found`);
    }
    project.current_seq_num += 1;
    return project.current_seq_num;
  }

  public async getCurrentSequenceNum(projectId: string): Promise<number> {
    const project = this.projects.get(projectId);
    return project ? project.current_seq_num : 0;
  }

  public async getEventByClientOpId(
    projectId: string,
    clientOpId: string
  ): Promise<DbSyncEvent | null> {
    return this.eventsByClientOpId.get(`${projectId}:${clientOpId}`) ?? null;
  }

  public async saveSyncEvent(event: Omit<DbSyncEvent, 'id'>): Promise<DbSyncEvent> {
    const savedEvent: DbSyncEvent = {
      ...event,
      id: this.nextEventId++,
    };

    const projectEvents = this.events.get(event.project_id) ?? [];
    projectEvents.push(savedEvent);
    this.events.set(event.project_id, projectEvents);

    this.eventsByClientOpId.set(`${event.project_id}:${event.client_op_id}`, savedEvent);

    return savedEvent;
  }

  public async getEventsRange(
    projectId: string,
    fromSeqExclusive: number,
    limit: number
  ): Promise<DbSyncEvent[]> {
    const projectEvents = this.events.get(projectId) ?? [];
    return projectEvents
      .filter((e) => e.seq_num > fromSeqExclusive)
      .slice(0, limit);
  }

  public async getActiveLease(
    projectId: string,
    relativePath: string
  ): Promise<DbEditingLease | null> {
    const now = new Date().toISOString();
    for (const lease of this.leases.values()) {
      if (
        lease.project_id === projectId &&
        lease.relative_path === relativePath &&
        lease.lease_status === 'ACTIVE' &&
        lease.expires_at > now
      ) {
        return lease;
      }
    }
    return null;
  }

  public async claimLease(
    lease: Omit<DbEditingLease, 'id' | 'created_at'>
  ): Promise<DbEditingLease> {
    const id = `lease-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const savedLease: DbEditingLease = {
      ...lease,
      id,
      created_at: new Date().toISOString(),
    };
    this.leases.set(id, savedLease);
    return savedLease;
  }

  public async releaseLease(
    leaseId: string,
    deviceId?: string,
    projectId?: string
  ): Promise<boolean> {
    const lease = this.leases.get(leaseId);
    if (!lease) return false;
    if (lease.lease_status !== LeaseStatus.ACTIVE) return false;
    if (deviceId && lease.device_id !== deviceId) return false;
    if (projectId && lease.project_id !== projectId) return false;
    lease.lease_status = LeaseStatus.EXPIRED;
    return true;
  }

  // --- Conflict Tracking Implementation (Phase 4) ---
  private conflicts = new Map<string, DbActiveConflict>();

  public async createConflict(
    conflict: Omit<DbActiveConflict, 'id' | 'created_at'>
  ): Promise<DbActiveConflict> {
    const id = `conflict-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const saved: DbActiveConflict = {
      ...conflict,
      id,
      created_at: new Date().toISOString(),
    };
    this.conflicts.set(id, saved);
    return saved;
  }

  public async getConflict(conflictId: string): Promise<DbActiveConflict | null> {
    return this.conflicts.get(conflictId) ?? null;
  }

  public async listActiveConflicts(projectId: string): Promise<DbActiveConflict[]> {
    const list: DbActiveConflict[] = [];
    for (const c of this.conflicts.values()) {
      if (
        c.project_id === projectId &&
        c.conflict_status !== ConflictStatus.RESOLVED_KEEP_LOCAL &&
        c.conflict_status !== ConflictStatus.RESOLVED_ACCEPT_REMOTE &&
        c.conflict_status !== ConflictStatus.RESOLVED_MERGED
      ) {
        list.push(c);
      }
    }
    return list;
  }

  public async resolveConflict(
    conflictId: string,
    resolution: ConflictStatus,
    resolutionPayload?: Record<string, unknown>
  ): Promise<DbActiveConflict | null> {
    const c = this.conflicts.get(conflictId);
    if (!c) return null;

    c.conflict_status = resolution;
    c.resolution_payload = resolutionPayload ?? null;
    c.resolved_at = new Date().toISOString();
    return c;
  }

  // --- Checkpoint Tracking (Phase 5A) ---
  private checkpoints = new Map<string, DbCheckpoint>();
  private auditRecords: DbPublishingAuditRecord[] = [];
  private nextAuditId = 1;

  public async saveCheckpoint(checkpoint: DbCheckpoint): Promise<DbCheckpoint> {
    this.checkpoints.set(checkpoint.id, { ...checkpoint });
    return { ...checkpoint };
  }

  public async getCheckpoint(id: string): Promise<DbCheckpoint | null> {
    return this.checkpoints.get(id) ? { ...this.checkpoints.get(id)! } : null;
  }

  public async listCheckpoints(projectId: string, kind?: CheckpointKind): Promise<DbCheckpoint[]> {
    const list: DbCheckpoint[] = [];
    for (const cp of this.checkpoints.values()) {
      if (cp.project_id === projectId) {
        if (!kind || cp.kind === kind) {
          list.push({ ...cp });
        }
      }
    }
    return list.sort((a, b) => b.sync_sequence_num - a.sync_sequence_num);
  }

  public async updateCheckpointStatus(
    id: string,
    status: CheckpointStatus,
    updates?: Partial<DbCheckpoint>
  ): Promise<DbCheckpoint | null> {
    const cp = this.checkpoints.get(id);
    if (!cp) return null;

    cp.status = status;
    if (updates) {
      Object.assign(cp, updates);
    }
    return { ...cp };
  }

  public async savePublishingAuditRecord(
    record: Omit<DbPublishingAuditRecord, 'id' | 'created_at'>
  ): Promise<DbPublishingAuditRecord> {
    const saved: DbPublishingAuditRecord = {
      ...record,
      id: `audit-${this.nextAuditId++}`,
      created_at: new Date().toISOString(),
    };
    this.auditRecords.push(saved);
    return saved;
  }

  public async listPublishingAuditRecords(
    projectId: string,
    checkpointId?: string
  ): Promise<DbPublishingAuditRecord[]> {
    return this.auditRecords.filter((r) => {
      if (r.project_id !== projectId) return false;
      if (checkpointId && r.checkpoint_id !== checkpointId) return false;
      return true;
    });
  }

  // --- Phase 5B: Contracts, Shared Memory & Module Ownership ---
  private contracts = new Map<string, DbIntegrationContract>(); // key: `${projectId}:${identifier}`
  private contractVersions = new Map<string, DbContractVersion[]>(); // key: contractId
  private moduleDependencies = new Map<string, DbModuleDependency>(); // key: `${projectId}:${consumerModule}:${contractId}`
  private tasks = new Map<string, DbTask>(); // key: taskId
  private decisions: DbProjectDecision[] = [];
  private moduleIntents = new Map<string, DbModuleIntent>(); // key: `${projectId}:${moduleName}`

  public async getContract(projectId: string, identifier: string): Promise<DbIntegrationContract | null> {
    const key = `${projectId}:${identifier}`;
    return this.contracts.get(key) ? { ...this.contracts.get(key)! } : null;
  }

  public async listContracts(projectId: string): Promise<DbIntegrationContract[]> {
    const list: DbIntegrationContract[] = [];
    for (const c of this.contracts.values()) {
      if (c.project_id === projectId) {
        list.push({ ...c });
      }
    }
    return list;
  }

  public async saveContract(contract: DbIntegrationContract): Promise<DbIntegrationContract> {
    const key = `${contract.project_id}:${contract.identifier}`;
    this.contracts.set(key, { ...contract });
    return { ...contract };
  }

  public async getContractVersion(contractId: string, version: number): Promise<DbContractVersion | null> {
    const versions = this.contractVersions.get(contractId) || [];
    const v = versions.find((ver) => ver.version === version);
    return v ? { ...v } : null;
  }

  public async listContractVersions(contractId: string): Promise<DbContractVersion[]> {
    const versions = this.contractVersions.get(contractId) || [];
    return versions.map((v) => ({ ...v })).sort((a, b) => b.version - a.version);
  }

  public async saveContractVersion(version: DbContractVersion): Promise<DbContractVersion> {
    const versions = this.contractVersions.get(version.contract_id) || [];
    const idx = versions.findIndex((v) => v.version === version.version);
    if (idx >= 0) {
      versions[idx] = { ...version };
    } else {
      versions.push({ ...version });
    }
    this.contractVersions.set(version.contract_id, versions);
    return { ...version };
  }

  public async getModuleDependencies(projectId: string, contractId?: string): Promise<DbModuleDependency[]> {
    const list: DbModuleDependency[] = [];
    for (const dep of this.moduleDependencies.values()) {
      if (dep.project_id === projectId) {
        if (!contractId || dep.contract_id === contractId) {
          list.push({ ...dep });
        }
      }
    }
    return list;
  }

  public async saveModuleDependency(dep: DbModuleDependency): Promise<DbModuleDependency> {
    const key = `${dep.project_id}:${dep.consumer_module}:${dep.contract_id}`;
    this.moduleDependencies.set(key, { ...dep });
    return { ...dep };
  }

  public async markConsumersStale(projectId: string, contractId: string, reason: string): Promise<number> {
    let count = 0;
    for (const dep of this.moduleDependencies.values()) {
      if (dep.project_id === projectId && dep.contract_id === contractId) {
        dep.is_stale = true;
        dep.stale_reason = reason;
        dep.updated_at = new Date().toISOString();
        count++;
      }
    }
    return count;
  }

  public async listTasks(projectId: string): Promise<DbTask[]> {
    const list: DbTask[] = [];
    for (const t of this.tasks.values()) {
      if (t.project_id === projectId) {
        list.push({ ...t });
      }
    }
    return list;
  }

  public async saveTask(task: DbTask): Promise<DbTask> {
    this.tasks.set(task.id, { ...task });
    return { ...task };
  }

  public async listProjectDecisions(projectId: string): Promise<DbProjectDecision[]> {
    return this.decisions.filter((d) => d.project_id === projectId).map((d) => ({ ...d }));
  }

  public async saveProjectDecision(decision: DbProjectDecision): Promise<DbProjectDecision> {
    this.decisions.push({ ...decision });
    return { ...decision };
  }

  public async listModuleIntents(projectId: string): Promise<DbModuleIntent[]> {
    const list: DbModuleIntent[] = [];
    const now = new Date().toISOString();
    for (const intent of this.moduleIntents.values()) {
      if (intent.project_id === projectId && intent.expires_at > now) {
        list.push({ ...intent });
      }
    }
    return list;
  }

  public async claimModuleIntent(intent: DbModuleIntent): Promise<DbModuleIntent> {
    const key = `${intent.project_id}:${intent.module_name}:${intent.device_id}`;
    this.moduleIntents.set(key, { ...intent });
    return { ...intent };
  }
}
