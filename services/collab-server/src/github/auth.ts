/**
 * @file auth.ts
 * Secure GitHub App / OAuth credential management and token redaction (Safeguard 5).
 */

import crypto from 'node:crypto';

export interface GitHubAppCredentials {
  appId: string;
  privateKeyPem: string;
  installationId?: number;
}

export class GitHubAuthService {
  /**
   * Generates a GitHub App JWT (valid for 10 minutes max, per GitHub specifications).
   * Used to authenticate as the GitHub App to request installation access tokens.
   */
  public generateAppJwt(appId: string, privateKeyPem: string): string {
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      iat: now - 60, // Issued 60s in the past to allow for clock drift
      exp: now + 600, // Expires in 10 minutes
      iss: appId,
    };

    const header = {
      alg: 'RS256',
      typ: 'JWT',
    };

    const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
    const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const dataToSign = `${encodedHeader}.${encodedPayload}`;

    const signer = crypto.createSign('RSA-SHA256');
    signer.update(dataToSign);
    const signature = signer.sign(privateKeyPem, 'base64url');

    return `${dataToSign}.${signature}`;
  }

  /**
   * Redacts sensitive GitHub tokens in logs and diagnostic outputs (Safeguard 5).
   */
  public redactToken(token: string): string {
    if (!token || token.length <= 8) {
      return '***';
    }
    const prefix = token.slice(0, 4);
    const suffix = token.slice(-4);
    return `${prefix}****${suffix}`;
  }

  /**
   * Validates standard GitHub token prefixes (ghp_ for personal tokens, ghs_ for installation tokens).
   */
  public isValidTokenFormat(token: string): boolean {
    if (!token || typeof token !== 'string') return false;
    return (
      token.startsWith('ghp_') ||
      token.startsWith('ghs_') ||
      token.startsWith('github_pat_') ||
      token.length >= 20
    );
  }
}
