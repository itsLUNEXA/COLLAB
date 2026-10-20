import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebSocket } from 'ws';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { MemorySyncRepository } from '../storage/memory-sync-repository.js';
import { createSessionToken } from '../auth/token.js';
import {
  ProtocolVersion,
  MessageType,
  SyncOpType,
  SyncEnvelope,
  ErrorCode,
} from '@collab/protocol';

describe('Phase 2 - Real-Time Sync Hub & WebSocket Gateway', () => {
  let app: FastifyInstance;
  let serverPort: number;
  let repository: MemorySyncRepository;

  const jwtSecret = 'test-secret-key-that-is-at-least-32-chars-long';
  const projectId = '33333333-3333-4333-8333-333333333333';
  const deviceAId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const deviceBId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const userAId = '11111111-1111-4111-8111-111111111111';
  const userBId = '22222222-2222-4222-8222-222222222222';

  let tokenA: string;
  let tokenB: string;

  beforeAll(async () => {
    repository = new MemorySyncRepository();
    repository.seedProject({
      id: projectId,
      team_id: 'team-1',
      name: 'Hackathon App',
      github_repo_owner: 'org',
      github_repo_name: 'hackathon-app',
      github_installation_id: null,
      default_branch: 'main',
      wip_branch: 'collab/wip',
      integrated_branch: 'collab/integrated',
      current_seq_num: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const config = {
      PORT: 0, // Random port
      HOST: '127.0.0.1',
      NODE_ENV: 'test' as const,
      MAX_PAYLOAD_BYTES: 1024 * 1024,
      RATE_LIMIT_MAX: 10000,
      JWT_SECRET: jwtSecret,
    };

    app = buildApp({ config, repository });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addrInfo = app.server.address();
    serverPort = typeof addrInfo === 'object' && addrInfo ? addrInfo.port : 4000;

    tokenA = createSessionToken({ user_id: userAId, device_id: deviceAId, project_id: projectId }, jwtSecret);
    tokenB = createSessionToken({ user_id: userBId, device_id: deviceBId, project_id: projectId }, jwtSecret);
  });

  afterAll(async () => {
    await app.close();
  });

  function connectClient(token: string): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${serverPort}/ws?token=${token}`);
      ws.on('open', () => resolve(ws));
      ws.on('error', (err) => reject(err));
    });
  }

  function waitForNextMessage(ws: WebSocket): Promise<SyncEnvelope> {
    return new Promise((resolve) => {
      ws.once('message', (data) => {
        const parsed = JSON.parse(data.toString('utf-8')) as SyncEnvelope;
        resolve(parsed);
      });
    });
  }

  it('Criteria 1 & 6: Rejects unauthorized connection without token', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${serverPort}/ws`);
    const closePromise = new Promise<{ code: number; reason: string }>((resolve) => {
      ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
    });

    const { code } = await closePromise;
    expect(code).toBe(1008);
  });

  it('Criteria 1, 2, 3, 4, 5: Two clients connect, event is sequenced, ACKed, and broadcast with echo exclusion', async () => {
    const wsA = await connectClient(tokenA);
    const wsB = await connectClient(tokenB);

    const clientOpId1 = '44444444-4444-4444-8444-444444444444';
    const baseHash = '1'.repeat(64);
    const targetHash = '2'.repeat(64);

    const clientEventEnvelope: SyncEnvelope = {
      protocol_version: ProtocolVersion,
      project_id: projectId,
      device_id: deviceAId,
      message_type: MessageType.CLIENT_EVENT,
      client_op_id: clientOpId1,
      timestamp_utc: new Date().toISOString(),
      payload: {
        op_type: SyncOpType.FILE_UPDATE,
        relative_path: 'backend/src/auth.ts',
        base_hash: baseHash,
        target_hash: targetHash,
        encoding: 'utf-8',
        content: 'export const auth = true;',
        file_size_bytes: 25,
        is_binary: false,
      },
    };

    // Prepare message listeners
    const ackPromise = waitForNextMessage(wsA);
    const broadcastPromise = waitForNextMessage(wsB);

    // Track if wsA mistakenly receives its own broadcast (Echo prevention check)
    let wsAReceivedBroadcast = false;
    const wsAListener = (data: Buffer) => {
      const msg = JSON.parse(data.toString()) as SyncEnvelope;
      if (msg.message_type === MessageType.SERVER_BROADCAST) {
        wsAReceivedBroadcast = true;
      }
    };
    wsA.on('message', wsAListener);

    // Send event from Device A
    wsA.send(JSON.stringify(clientEventEnvelope));

    // 1. Verify Client A receives ACK
    const ackMsg = await ackPromise;
    expect(ackMsg.message_type).toBe(MessageType.EVENT_ACK);
    expect(ackMsg.sequence_num).toBe(1);
    expect(ackMsg.payload.status).toBe('ACCEPTED');
    expect(ackMsg.payload.client_op_id).toBe(clientOpId1);

    // 2. Verify Client B receives Broadcast
    const broadcastMsg = await broadcastPromise;
    expect(broadcastMsg.message_type).toBe(MessageType.SERVER_BROADCAST);
    expect(broadcastMsg.sequence_num).toBe(1);
    expect(broadcastMsg.client_op_id).toBe(clientOpId1);
    expect((broadcastMsg.payload as { relative_path: string }).relative_path).toBe('backend/src/auth.ts');

    // 3. Verify Client A NEVER received the broadcast (Originator exclusion / Echo suppression)
    expect(wsAReceivedBroadcast).toBe(false);
    wsA.off('message', wsAListener);

    // 4. Verify Idempotency (Criteria 4): Device A re-sends the exact same client_op_id
    const duplicateAckPromise = waitForNextMessage(wsA);
    wsA.send(JSON.stringify(clientEventEnvelope));

    const duplicateAck = await duplicateAckPromise;
    expect(duplicateAck.message_type).toBe(MessageType.EVENT_ACK);
    expect(duplicateAck.payload.status).toBe('DUPLICATE');
    expect(duplicateAck.sequence_num).toBe(1); // Still seq 1, not incremented!

    // Verify current sequence in repo is still 1
    const currentSeq = await repository.getCurrentSequenceNum(projectId);
    expect(currentSeq).toBe(1);

    wsA.close();
    wsB.close();
  });

  it('Criteria 7: Reconnecting client can retrieve missed events', async () => {
    // Device A connects and sends event seq 2
    const wsA = await connectClient(tokenA);

    const clientOpId2 = '55555555-5555-4555-8555-555555555555';
    const event2Envelope: SyncEnvelope = {
      protocol_version: ProtocolVersion,
      project_id: projectId,
      device_id: deviceAId,
      message_type: MessageType.CLIENT_EVENT,
      client_op_id: clientOpId2,
      timestamp_utc: new Date().toISOString(),
      payload: {
        op_type: SyncOpType.FILE_CREATE,
        relative_path: 'frontend/src/Login.tsx',
        base_hash: null,
        target_hash: '3'.repeat(64),
        encoding: 'utf-8',
        content: 'export default function Login() {}',
        file_size_bytes: 34,
        is_binary: false,
      },
    };

    const ackPromise = waitForNextMessage(wsA);
    wsA.send(JSON.stringify(event2Envelope));
    await ackPromise;
    wsA.close();

    // Now Device B reconnects and asks for missed events from seq 1
    const wsB = await connectClient(tokenB);
    const catchUpRequestEnvelope: SyncEnvelope = {
      protocol_version: ProtocolVersion,
      project_id: projectId,
      device_id: deviceBId,
      message_type: MessageType.REQUEST_MISSING_EVENTS,
      client_op_id: '66666666-6666-4666-8666-666666666666',
      timestamp_utc: new Date().toISOString(),
      payload: {
        from_seq_exclusive: 1, // Only wants events > 1
        max_batch_size: 100,
      },
    };

    const responsePromise = waitForNextMessage(wsB);
    wsB.send(JSON.stringify(catchUpRequestEnvelope));

    const responseMsg = await responsePromise;
    expect(responseMsg.message_type).toBe(MessageType.MISSING_EVENTS_RESPONSE);
    const events = (responseMsg.payload as { events: Array<{ seq_num: number; relative_path: string }> }).events;
    expect(events).toHaveLength(1);
    expect(events[0].seq_num).toBe(2);
    expect(events[0].relative_path).toBe('frontend/src/Login.tsx');

    wsB.close();
  });

  it('Criteria 6: Path traversal attempt is rejected with ERROR_ALERT', async () => {
    const wsA = await connectClient(tokenA);

    const badEnvelope: SyncEnvelope = {
      protocol_version: ProtocolVersion,
      project_id: projectId,
      device_id: deviceAId,
      message_type: MessageType.CLIENT_EVENT,
      client_op_id: '77777777-7777-4777-8777-777777777777',
      timestamp_utc: new Date().toISOString(),
      payload: {
        op_type: SyncOpType.FILE_UPDATE,
        relative_path: '../../etc/passwd',
        base_hash: '1'.repeat(64),
        target_hash: '2'.repeat(64),
        encoding: 'utf-8',
        content: 'hacked',
        file_size_bytes: 6,
        is_binary: false,
      },
    };

    const errorPromise = waitForNextMessage(wsA);
    wsA.send(JSON.stringify(badEnvelope));

    const errorMsg = await errorPromise;
    expect(errorMsg.message_type).toBe(MessageType.ERROR_ALERT);
    expect((errorMsg.payload as { code: string }).code).toBe(ErrorCode.PATH_TRAVERSAL_DETECTED);

    wsA.close();
  });

  it('Requirement 4: Project-level authorization rejects cross-project envelope spoofing', async () => {
    // wsA has token scoped to projectId
    const wsA = await connectClient(tokenA);

    const crossProjectEnvelope: SyncEnvelope = {
      protocol_version: ProtocolVersion,
      project_id: '99999999-9999-4999-8999-999999999999', // Different project!
      device_id: deviceAId,
      message_type: MessageType.CLIENT_EVENT,
      client_op_id: '88888888-8888-4888-8888-888888888888',
      timestamp_utc: new Date().toISOString(),
      payload: {
        op_type: SyncOpType.FILE_CREATE,
        relative_path: 'secret.txt',
        base_hash: null,
        target_hash: '5'.repeat(64),
        encoding: 'utf-8',
        content: 'unauthorized cross project attempt',
        file_size_bytes: 34,
        is_binary: false,
      },
    };

    const errorPromise = waitForNextMessage(wsA);
    wsA.send(JSON.stringify(crossProjectEnvelope));

    const errorMsg = await errorPromise;
    expect(errorMsg.message_type).toBe(MessageType.ERROR_ALERT);
    expect((errorMsg.payload as { code: string }).code).toBe(ErrorCode.UNAUTHORIZED);

    wsA.close();
  });
});

