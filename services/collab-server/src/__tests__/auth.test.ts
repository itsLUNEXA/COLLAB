import { describe, it, expect } from 'vitest';
import { createSessionToken, verifySessionToken, hashDeviceSecret } from '../auth/token.js';
import { CollabError, ErrorCode } from '@collab/protocol';

describe('auth/token.ts - Authentication & Token Security', () => {
  const secret = 'test-jwt-secret-key-that-is-at-least-32-chars-long';

  it('should generate and verify a valid session token', () => {
    const payload = {
      user_id: '11111111-1111-4111-8111-111111111111',
      device_id: '22222222-2222-4222-8222-222222222222',
      project_id: '33333333-3333-4333-8333-333333333333',
    };

    const token = createSessionToken(payload, secret, 300);
    expect(typeof token).toBe('string');

    const decoded = verifySessionToken(token, secret);
    expect(decoded.user_id).toBe(payload.user_id);
    expect(decoded.device_id).toBe(payload.device_id);
    expect(decoded.project_id).toBe(payload.project_id);
    expect(decoded.exp).toBeDefined();
  });

  it('should reject a token signed with a different secret', () => {
    const token = createSessionToken(
      {
        user_id: '11111111-1111-4111-8111-111111111111',
        device_id: '22222222-2222-4222-8222-222222222222',
      },
      secret
    );

    expect(() => verifySessionToken(token, 'wrong-secret-key-32-characters-long!')).toThrowError(
      CollabError
    );
    try {
      verifySessionToken(token, 'wrong-secret-key-32-characters-long!');
    } catch (err) {
      expect((err as CollabError).code).toBe(ErrorCode.UNAUTHORIZED);
    }
  });

  it('should reject an expired token', () => {
    const token = createSessionToken(
      {
        user_id: '11111111-1111-4111-8111-111111111111',
        device_id: '22222222-2222-4222-8222-222222222222',
      },
      secret,
      -10 // Expired 10s ago
    );

    expect(() => verifySessionToken(token, secret)).toThrowError(CollabError);
  });

  it('should deterministically hash device secrets (Safeguard 5)', () => {
    const hash1 = hashDeviceSecret('my-device-raw-secret');
    const hash2 = hashDeviceSecret('my-device-raw-secret');
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64);
  });

  it('issues valid session tokens via POST /api/v1/auth/token endpoint', async () => {
    const { buildApp } = await import('../app.js');
    const { MemorySyncRepository } = await import('../storage/memory-sync-repository.js');

    const app = buildApp({
      config: {
        PORT: 0,
        HOST: '127.0.0.1',
        NODE_ENV: 'test',
        MAX_PAYLOAD_BYTES: 1024 * 1024,
        RATE_LIMIT_MAX: 1000,
        JWT_SECRET: secret,
      },
      repository: new MemorySyncRepository(),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/token',
      payload: {
        userId: '11111111-1111-4111-8111-111111111111',
        deviceId: '22222222-2222-4222-8222-222222222222',
        projectId: '33333333-3333-4333-8333-333333333333',
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.token).toBeDefined();
    expect(body.expires_in).toBe(86400 * 7);

    const decoded = verifySessionToken(body.token, secret);
    expect(decoded.user_id).toBe('11111111-1111-4111-8111-111111111111');
    expect(decoded.device_id).toBe('22222222-2222-4222-8222-222222222222');
    expect(decoded.project_id).toBe('33333333-3333-4333-8333-333333333333');
    expect(decoded.role).toBe('developer');
  });

  it('rejects cross-project access with 403 Forbidden when token is scoped to a different project', async () => {
    const { buildApp } = await import('../app.js');
    const { MemorySyncRepository } = await import('../storage/memory-sync-repository.js');

    const app = buildApp({
      config: {
        PORT: 0,
        HOST: '127.0.0.1',
        NODE_ENV: 'test',
        MAX_PAYLOAD_BYTES: 1024 * 1024,
        RATE_LIMIT_MAX: 1000,
        JWT_SECRET: secret,
      },
      repository: new MemorySyncRepository(),
    });

    const tokenForProjectA = createSessionToken(
      {
        user_id: '11111111-1111-4111-8111-111111111111',
        device_id: '22222222-2222-4222-8222-222222222222',
        project_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      },
      secret
    );

    // Call Project B endpoint using token scoped to Project A
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb/devices',
      headers: {
        authorization: `Bearer ${tokenForProjectA}`,
      },
    });

    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.error).toContain('Forbidden');
  });

  it('prevents arbitrary role elevation to admin for unauthenticated callers', async () => {
    const { buildApp } = await import('../app.js');
    const { MemorySyncRepository } = await import('../storage/memory-sync-repository.js');

    const app = buildApp({
      config: {
        PORT: 0,
        HOST: '127.0.0.1',
        NODE_ENV: 'test',
        MAX_PAYLOAD_BYTES: 1024 * 1024,
        RATE_LIMIT_MAX: 1000,
        JWT_SECRET: secret,
      },
      repository: new MemorySyncRepository(),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/token',
      payload: {
        userId: '11111111-1111-4111-8111-111111111111',
        deviceId: '22222222-2222-4222-8222-222222222222',
        projectId: '33333333-3333-4333-8333-333333333333',
        role: 'admin',
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    // Role must be forced to 'developer' since caller is not authenticated as admin
    expect(body.role).toBe('developer');
    const decoded = verifySessionToken(body.token, secret);
    expect(decoded.role).toBe('developer');
  });

  it('rejects unauthenticated token issuance in production mode', async () => {
    const { buildApp } = await import('../app.js');
    const { MemorySyncRepository } = await import('../storage/memory-sync-repository.js');

    const app = buildApp({
      config: {
        PORT: 0,
        HOST: '127.0.0.1',
        NODE_ENV: 'production',
        MAX_PAYLOAD_BYTES: 1024 * 1024,
        RATE_LIMIT_MAX: 1000,
        JWT_SECRET: secret,
      },
      repository: new MemorySyncRepository(),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/token',
      payload: {
        projectId: '33333333-3333-4333-8333-333333333333',
      },
    });

    expect(response.statusCode).toBe(401);
  });

  it('allows token issuance in production mode when valid device credentials are provided', async () => {
    const { buildApp } = await import('../app.js');
    const { MemorySyncRepository } = await import('../storage/memory-sync-repository.js');

    const repo = new MemorySyncRepository();
    const testDeviceId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const testUserId = 'uuuuuuuu-uuuu-4uuu-8uuu-uuuuuuuuuuuu';
    const rawSecret = 'legitimate-device-secret-123';

    repo.seedDevice({
      id: testDeviceId,
      user_id: testUserId,
      device_name: 'Prod Registered Companion',
      os_info: 'Windows',
      device_token_hash: hashDeviceSecret(rawSecret),
      is_revoked: false,
      last_active_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    });

    const app = buildApp({
      config: {
        PORT: 0,
        HOST: '127.0.0.1',
        NODE_ENV: 'production',
        MAX_PAYLOAD_BYTES: 1024 * 1024,
        RATE_LIMIT_MAX: 1000,
        JWT_SECRET: secret,
      },
      repository: repo,
    });

    // 1. Valid device credentials
    const successRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/token',
      payload: {
        deviceId: testDeviceId,
        deviceSecret: rawSecret,
        projectId: '33333333-3333-4333-8333-333333333333',
      },
    });

    expect(successRes.statusCode).toBe(200);
    const body = JSON.parse(successRes.body);
    expect(body.token).toBeDefined();
    expect(body.user_id).toBe(testUserId);

    // 2. Invalid device secret
    const failRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/token',
      payload: {
        deviceId: testDeviceId,
        deviceSecret: 'wrong-secret',
        projectId: '33333333-3333-4333-8333-333333333333',
      },
    });

    expect(failRes.statusCode).toBe(401);
  });
});
