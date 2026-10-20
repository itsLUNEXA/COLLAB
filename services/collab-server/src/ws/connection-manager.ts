/**
 * @file connection-manager.ts
 * Manages active WebSocket connections grouped by project.
 * Enforces peer broadcast isolation and originating device exclusion (Task 7).
 */

import { WebSocket } from 'ws';
import { SyncEnvelope } from '@collab/protocol';

export interface ClientSession {
  socket: WebSocket;
  deviceId: string;
  userId: string;
  projectId: string;
  connectedAt: Date;
  lastHeartbeat: Date;
}

export class ConnectionManager {
  // Map of socket -> ClientSession
  private socketToSession = new Map<WebSocket, ClientSession>();

  // Map of projectId -> Set<ClientSession>
  private projectSessions = new Map<string, Set<ClientSession>>();

  /**
   * Registers a newly authenticated client connection.
   */
  public register(
    socket: WebSocket,
    deviceId: string,
    userId: string,
    projectId: string
  ): ClientSession {
    const session: ClientSession = {
      socket,
      deviceId,
      userId,
      projectId,
      connectedAt: new Date(),
      lastHeartbeat: new Date(),
    };

    this.socketToSession.set(socket, session);

    let sessions = this.projectSessions.get(projectId);
    if (!sessions) {
      sessions = new Set();
      this.projectSessions.set(projectId, sessions);
    }
    sessions.add(session);

    return session;
  }

  /**
   * Removes a disconnected client socket.
   */
  public unregister(socket: WebSocket): ClientSession | null {
    const session = this.socketToSession.get(socket);
    if (!session) return null;

    this.socketToSession.delete(socket);

    const sessions = this.projectSessions.get(session.projectId);
    if (sessions) {
      sessions.delete(session);
      if (sessions.size === 0) {
        this.projectSessions.delete(session.projectId);
      }
    }

    return session;
  }

  /**
   * Retrieves active session for a given socket.
   */
  public getSession(socket: WebSocket): ClientSession | null {
    return this.socketToSession.get(socket) ?? null;
  }

  /**
   * Updates last heartbeat timestamp.
   */
  public updateHeartbeat(socket: WebSocket): void {
    const session = this.socketToSession.get(socket);
    if (session) {
      session.lastHeartbeat = new Date();
    }
  }

  /**
   * Broadcasts a message to all active peers in the project,
   * STRICTLY EXCLUDING the originating device (Task 7, Acceptance Criteria 3).
   *
   * @param projectId - Target project identifier.
   * @param envelope - The protocol sync envelope to transmit.
   * @param excludeDeviceId - Device ID of the originator to be excluded from broadcast.
   */
  public broadcastToProject(
    projectId: string,
    envelope: SyncEnvelope,
    excludeDeviceId?: string
  ): number {
    const sessions = this.projectSessions.get(projectId);
    if (!sessions || sessions.size === 0) {
      return 0;
    }

    const payloadString = JSON.stringify(envelope);
    let deliveredCount = 0;

    for (const session of sessions) {
      // Echo suppression: strictly omit originator
      if (excludeDeviceId && session.deviceId === excludeDeviceId) {
        continue;
      }

      if (session.socket.readyState === WebSocket.OPEN) {
        try {
          session.socket.send(payloadString);
          deliveredCount++;
        } catch {
          // Socket write failed, will be pruned on close
        }
      }
    }

    return deliveredCount;
  }

  /**
   * Sends an envelope directly to a specific socket.
   */
  public send(socket: WebSocket, envelope: unknown): boolean {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(envelope));
      return true;
    }
    return false;
  }

  /**
   * Returns active connection count for a project.
   */
  public getProjectPeerCount(projectId: string): number {
    return this.projectSessions.get(projectId)?.size ?? 0;
  }

  /**
   * Returns active sessions for a given project.
   */
  public getConnectedSessions(projectId: string): ClientSession[] {
    const sessions = this.projectSessions.get(projectId);
    return sessions ? Array.from(sessions) : [];
  }
}

