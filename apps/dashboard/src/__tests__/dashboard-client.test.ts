import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DashboardApiClient, ApiError } from '../api/client';

describe('DashboardApiClient (Targeted Unit Tests)', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('injects Authorization Bearer token into request headers', async () => {
    let capturedHeaders: Headers | undefined;
    globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      capturedHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({ project: { id: 'p1', name: 'Test' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const client = new DashboardApiClient('http://localhost:4000', () => 'my-jwt-secret-token');
    const res = await client.getProject('p1');

    expect(capturedHeaders?.get('Authorization')).toBe('Bearer my-jwt-secret-token');
    expect(res.project.id).toBe('p1');
  });

  it('correctly maps and rejects with structured ApiError on 401 Unauthorized when no refresh handler is set', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'Invalid session token' }), {
        status: 401,
        statusText: 'Unauthorized',
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const client = new DashboardApiClient('http://localhost:4000', () => 'bad-token');

    await expect(client.getProject('p1')).rejects.toMatchObject({
      message: 'Invalid session token',
      statusCode: 401,
      isOffline: false,
    });
  });

  it('intercepts 401 Unauthorized, transparently refreshes token via onUnauthorized, and retries successfully', async () => {
    let callCount = 0;
    const authHeaders: string[] = [];

    globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      callCount++;
      const headers = new Headers(init?.headers);
      authHeaders.push(headers.get('Authorization') || '');

      if (callCount === 1) {
        return new Response(JSON.stringify({ error: 'Invalid session token' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response(JSON.stringify({ project: { id: 'p1', name: 'Refreshed Project' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const onUnauthorized = vi.fn().mockResolvedValue('new-server-signed-jwt');
    const client = new DashboardApiClient('http://localhost:4000', () => 'initial-stale-token', onUnauthorized);

    const res = await client.getProject('p1');

    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(callCount).toBe(2);
    expect(authHeaders[0]).toBe('Bearer initial-stale-token');
    expect(authHeaders[1]).toBe('Bearer new-server-signed-jwt');
    expect(res.project.name).toBe('Refreshed Project');
  });

  it('propagates 401 error if onUnauthorized is called but retry still returns 401', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'Invalid session token' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const onUnauthorized = vi.fn().mockResolvedValue('still-invalid-token');
    const client = new DashboardApiClient('http://localhost:4000', () => 'bad-token', onUnauthorized);

    await expect(client.getProject('p1')).rejects.toMatchObject({
      message: 'Invalid session token',
      statusCode: 401,
      isOffline: false,
    });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('detects offline state when fetch encounters network failure and navigator is offline', async () => {
    // Simulate navigator.onLine = false
    Object.defineProperty(globalThis, 'navigator', {
      value: { onLine: false },
      configurable: true,
      writable: true,
    });

    const client = new DashboardApiClient('http://localhost:4000', () => 'token');

    await expect(client.getProject('p1')).rejects.toMatchObject({
      message: expect.stringContaining('offline'),
      isOffline: true,
    });

    // Reset navigator
    Object.defineProperty(globalThis, 'navigator', {
      value: { onLine: true },
      configurable: true,
      writable: true,
    });
  });

  it('queries all 8 dashboard endpoints with correct HTTP methods and paths', async () => {
    const calls: Array<{ url: string; method?: string }> = [];

    globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method || 'GET' });
      return new Response(JSON.stringify({ success: true, count: 0, events: [], conflicts: [], contracts: [], tasks: [], intents: [], checkpoints: [], verification: { ready_to_publish: true, blocking_reasons: [] } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const client = new DashboardApiClient('http://localhost:4000', () => 'valid-token');
    const projId = '11111111-1111-4111-8111-111111111111';

    // 1. Projects
    await client.getProject(projId);
    expect(calls[0]).toEqual({ url: `http://localhost:4000/api/v1/projects/${projId}`, method: 'GET' });

    // 2. Devices
    await client.getDevices(projId);
    expect(calls[1]).toEqual({ url: `http://localhost:4000/api/v1/projects/${projId}/devices`, method: 'GET' });

    // 3. Events
    await client.getEvents(projId, 0, 50);
    expect(calls[2]).toEqual({ url: `http://localhost:4000/api/v1/projects/${projId}/events?from_seq=0&limit=50`, method: 'GET' });

    // 4. Conflicts & Resolve
    await client.getConflicts(projId);
    expect(calls[3]).toEqual({ url: `http://localhost:4000/api/v1/projects/${projId}/conflicts`, method: 'GET' });

    await client.resolveConflict(projId, 'c1', 'RESOLVED_KEEP_LOCAL');
    expect(calls[4]).toEqual({ url: `http://localhost:4000/api/v1/projects/${projId}/conflicts/c1/resolve`, method: 'POST' });

    // 5. Contracts
    await client.getContracts(projId);
    expect(calls[5]).toEqual({ url: `http://localhost:4000/api/v1/projects/${projId}/contracts`, method: 'GET' });

    // 6. Tasks
    await client.getTasks(projId);
    expect(calls[6]).toEqual({ url: `http://localhost:4000/api/v1/projects/${projId}/tasks`, method: 'GET' });

    // 7. Checkpoints
    await client.getCheckpoints(projId, 'WIP_SNAPSHOT');
    expect(calls[7]).toEqual({ url: `http://localhost:4000/api/v1/projects/${projId}/checkpoints?kind=WIP_SNAPSHOT`, method: 'GET' });

    // 8. Diagnostics
    await client.getDiagnostics(projId);
    expect(calls[8]).toEqual({ url: `http://localhost:4000/api/v1/projects/${projId}/diagnostics`, method: 'GET' });

    expect(calls.length).toBe(9);
  });

  it('proactively calls onUnauthorized when getToken() returns empty string and attaches retrieved token', async () => {
    let capturedHeader: string | null = null;
    globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      capturedHeader = headers.get('Authorization');
      return new Response(JSON.stringify({ project_id: 'p1', current_seq_num: 1, connected_count: 0, devices: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const onUnauthorized = vi.fn().mockResolvedValue('proactively-acquired-jwt');
    const client = new DashboardApiClient('http://localhost:4000', () => '', onUnauthorized);

    const res = await client.getDevices('p1');
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(capturedHeader).toBe('Bearer proactively-acquired-jwt');
    expect(res.project_id).toBe('p1');
  });

  it('allows updating token via setToken method', async () => {
    let capturedHeader: string | null = null;
    globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      capturedHeader = headers.get('Authorization');
      return new Response(JSON.stringify({ project_id: 'p1', current_seq_num: 1, connected_count: 0, devices: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const client = new DashboardApiClient('http://localhost:4000', () => 'old-token');
    client.setToken('updated-fresh-jwt');

    await client.getDevices('p1');
    expect(capturedHeader).toBe('Bearer updated-fresh-jwt');
  });
});
