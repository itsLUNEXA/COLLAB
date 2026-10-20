/**
 * @file token.ts
 * Cryptographic token generation and verification using native Node.js crypto.
 * Enforces Safeguard 5: Scoped device and session authentication.
 */

import * as crypto from 'node:crypto';
import { CollabError, ErrorCode } from '@collab/protocol';

export interface TokenPayload {
  user_id: string;
  device_id: string;
  project_id?: string;
  role?: string;
  iat?: number;
  exp?: number;
}

function base64UrlEncode(str: string): string {
  return Buffer.from(str)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function base64UrlDecode(str: string): string {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4 !== 0) {
    base64 += '=';
  }
  return Buffer.from(base64, 'base64').toString('utf-8');
}

/**
 * Creates an HMAC-SHA256 signed JWT token.
 */
export function createSessionToken(
  payload: TokenPayload,
  secret: string,
  expiresInSeconds = 3600
): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const fullPayload: TokenPayload = {
    ...payload,
    iat: now,
    exp: now + expiresInSeconds,
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(fullPayload));
  const data = `${encodedHeader}.${encodedPayload}`;

  const signature = crypto
    .createHmac('sha256', secret)
    .update(data)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

  return `${data}.${signature}`;
}

/**
 * Verifies and decodes an HMAC-SHA256 signed JWT token.
 */
export function verifySessionToken(token: string, secret: string): TokenPayload {
  if (!token || typeof token !== 'string') {
    throw new CollabError(ErrorCode.UNAUTHORIZED, 'Token is missing or invalid');
  }

  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new CollabError(ErrorCode.UNAUTHORIZED, 'Malformed JWT token structure');
  }

  const [encodedHeader, encodedPayload, signature] = parts;
  const data = `${encodedHeader}.${encodedPayload}`;

  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(data)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

  const sigBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);

  if (
    sigBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(sigBuffer, expectedBuffer)
  ) {
    throw new CollabError(ErrorCode.UNAUTHORIZED, 'Invalid token signature');
  }

  try {
    const payload = JSON.parse(base64UrlDecode(encodedPayload)) as TokenPayload;
    const now = Math.floor(Date.now() / 1000);

    if (payload.exp && payload.exp < now) {
      throw new CollabError(ErrorCode.UNAUTHORIZED, 'Token has expired');
    }

    return payload;
  } catch (err) {
    if (err instanceof CollabError) throw err;
    throw new CollabError(ErrorCode.UNAUTHORIZED, 'Failed to decode token payload');
  }
}

/**
 * Computes a secure SHA-256 hash of a raw device secret.
 */
export function hashDeviceSecret(rawSecret: string): string {
  return crypto.createHash('sha256').update(rawSecret).digest('hex');
}
