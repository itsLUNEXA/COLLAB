/**
 * @file client.ts
 * Type-safe API client for Collaborative Dashboard.
 * Handles Authorization headers, offline detection, and uniform error reporting.
 */

import {
  Project,
  DeviceSession,
  SyncEventItem,
  ActiveConflict,
  IntegrationContract,
  Task,
  ModuleIntent,
  Checkpoint,
  PublishingAuditRecord,
  Diagnostics,
  ProjectMember,
  ProvisionedDevice,
} from '../types/api';

export interface ApiError {
  message: string;
  statusCode?: number;
  isOffline?: boolean;
}

export class DashboardApiClient {
  private baseUrl: string;
  private getToken: () => string;
  private onUnauthorized?: () => Promise<string | null | undefined>;

  constructor(
    baseUrl = '',
    getToken: () => string = () => '',
    onUnauthorized?: () => Promise<string | null | undefined>
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.getToken = getToken;
    this.onUnauthorized = onUnauthorized;
  }

  public setToken(token: string): void {
    this.getToken = () => token;
  }

  private async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      throw {
        message: 'You are currently offline. Check your network connection.',
        isOffline: true,
      } as ApiError;
    }

    let token = this.getToken();
    if (!token && this.onUnauthorized) {
      try {
        const fresh = await this.onUnauthorized();
        if (fresh) {
          token = fresh;
        }
      } catch {}
    }

    const headers = new Headers(options.headers || {});
    if (token && !headers.has('Authorization')) {
      headers.set('Authorization', `Bearer ${token}`);
    }
    if (!headers.has('Content-Type') && options.body && typeof options.body === 'string') {
      headers.set('Content-Type', 'application/json');
    }

    const url = `${this.baseUrl}${endpoint}`;

    try {
      let response = await fetch(url, {
        ...options,
        headers,
      });

      if (response.status === 401 && this.onUnauthorized) {
        try {
          const refreshedToken = await this.onUnauthorized();
          if (refreshedToken) {
            headers.set('Authorization', `Bearer ${refreshedToken}`);
            response = await fetch(url, { ...options, headers });
          }
        } catch {
          // Fall through to standard error handling
        }
      }

      if (!response.ok) {
        let errorMsg = `HTTP Error ${response.status}: ${response.statusText}`;
        try {
          const body = await response.json();
          if (body?.error) {
            errorMsg = body.error;
          } else if (body?.message) {
            errorMsg = body.message;
          }
        } catch {
          // Response body was not JSON
        }
        throw {
          message: errorMsg,
          statusCode: response.status,
          isOffline: false,
        } as ApiError;
      }

      return (await response.json()) as T;
    } catch (err: unknown) {
      if ((err as ApiError)?.isOffline !== undefined) {
        throw err;
      }
      const isOffline = typeof navigator !== 'undefined' && navigator.onLine === false;
      throw {
        message: isOffline
          ? 'You are currently offline. Check your network connection.'
          : 'Network request failed. Server might be unreachable.',
        isOffline,
      } as ApiError;
    }
  }

  // 1. Projects & Team
  async getProject(projectId: string): Promise<{ project: Project }> {
    return this.request<{ project: Project }>(`/api/v1/projects/${projectId}`);
  }

  async listProjects(): Promise<{ projects: Project[] }> {
    return this.request<{ projects: Project[] }>('/api/v1/projects');
  }

  async createProject(params: {
    name: string;
    githubRepoOwner?: string;
    githubRepoName?: string;
    defaultBranch?: string;
    teamId?: string;
  }): Promise<{ project: Project; token?: string; owner?: ProjectMember }> {
    return this.request<{ project: Project; token?: string; owner?: ProjectMember }>('/api/v1/projects', {
      method: 'POST',
      body: JSON.stringify(params),
    });
  }

  async getProjectMembers(projectId: string): Promise<{ project_id: string; members: ProjectMember[] }> {
    return this.request<{ project_id: string; members: ProjectMember[] }>(`/api/v1/projects/${projectId}/members`);
  }

  async addProjectMember(
    projectId: string,
    member: { name: string; email: string; role?: 'OWNER' | 'ADMIN' | 'MEMBER' }
  ): Promise<{ member: ProjectMember }> {
    return this.request<{ member: ProjectMember }>(`/api/v1/projects/${projectId}/members`, {
      method: 'POST',
      body: JSON.stringify(member),
    });
  }

  async registerDevice(
    projectId: string,
    params: { userId: string; deviceName: string; osInfo?: string; workspacePath?: string }
  ): Promise<ProvisionedDevice> {
    return this.request<ProvisionedDevice>(`/api/v1/projects/${projectId}/devices`, {
      method: 'POST',
      body: JSON.stringify(params),
    });
  }

  // 2. Connected Devices
  async getDevices(projectId: string): Promise<{
    project_id: string;
    current_seq_num: number;
    connected_count: number;
    devices: DeviceSession[];
  }> {
    return this.request(`/api/v1/projects/${projectId}/devices`);
  }

  // 3. File Events & Activity
  async getEvents(
    projectId: string,
    fromSeq = 0,
    limit = 50
  ): Promise<{
    project_id: string;
    from_seq: number;
    count: number;
    events: SyncEventItem[];
  }> {
    return this.request(`/api/v1/projects/${projectId}/events?from_seq=${fromSeq}&limit=${limit}`);
  }

  // 4. Conflicts
  async getConflicts(projectId: string): Promise<{
    project_id: string;
    count: number;
    conflicts: ActiveConflict[];
  }> {
    return this.request(`/api/v1/projects/${projectId}/conflicts`);
  }

  async resolveConflict(
    projectId: string,
    conflictId: string,
    resolution: string,
    resolvedContent?: string
  ): Promise<{
    success: boolean;
    conflict: ActiveConflict;
    assigned_seq?: number;
  }> {
    return this.request(`/api/v1/projects/${projectId}/conflicts/${conflictId}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ resolution, resolvedContent }),
    });
  }

  // 5. Contracts & AI Context
  async getContracts(projectId: string): Promise<{
    project_id: string;
    contracts: IntegrationContract[];
  }> {
    return this.request(`/api/v1/projects/${projectId}/contracts`);
  }

  // 6. Tasks & Module Ownership
  async getTasks(projectId: string): Promise<{
    project_id: string;
    tasks: Task[];
    intents: ModuleIntent[];
  }> {
    return this.request(`/api/v1/projects/${projectId}/tasks`);
  }

  // 7. Checkpoints & Validation
  async getCheckpoints(
    projectId: string,
    kind?: string
  ): Promise<{
    project_id: string;
    count: number;
    checkpoints: Checkpoint[];
  }> {
    const q = kind ? `?kind=${kind}` : '';
    return this.request(`/api/v1/projects/${projectId}/checkpoints${q}`);
  }

  async getCheckpointAudit(
    projectId: string,
    checkpointId: string
  ): Promise<{
    project_id: string;
    checkpoint_id: string;
    audit_records: PublishingAuditRecord[];
    records: PublishingAuditRecord[];
  }> {
    return this.request(`/api/v1/projects/${projectId}/checkpoints/${checkpointId}/audit`);
  }

  // 8. Diagnostics
  async getDiagnostics(projectId: string): Promise<Diagnostics> {
    return this.request(`/api/v1/projects/${projectId}/diagnostics`);
  }
}
