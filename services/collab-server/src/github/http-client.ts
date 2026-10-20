/**
 * @file http-client.ts
 * Production-ready concrete GitHub HTTP client implementing IGitHubClient.
 * Authenticates via GitHub App installation access tokens (JWT -> Installation Token).
 * Uses native fetch with automatic token caching, refresh, and token redaction.
 */

import {
  IGitHubClient,
  GitRefResponse,
  GitBlobResponse,
  GitTreeItem,
  GitTreeResponse,
  GitCommitResponse,
} from './github-client.interface.js';
import { GitHubAuthService } from './auth.js';

export interface GitHubHttpClientOptions {
  appId: string;
  installationId: number;
  privateKeyPem: string;
  apiUrl?: string;
  authService?: GitHubAuthService;
  fetchFn?: typeof fetch;
}

interface GitHubInstallationTokenResponse {
  token: string;
  expires_at: string;
  permissions?: Record<string, string>;
  repository_selection?: string;
}

interface GitHubRefApiResponse {
  ref: string;
  node_id: string;
  url: string;
  object: {
    sha: string;
    type: string;
    url: string;
  };
}

interface GitHubBlobApiResponse {
  sha: string;
  url: string;
}

interface GitHubTreeApiResponse {
  sha: string;
  url: string;
  tree: GitTreeItem[];
  truncated: boolean;
}

interface GitHubCommitApiResponse {
  sha: string;
  node_id: string;
  url: string;
  message: string;
  tree: { sha: string; url: string };
  parents: Array<{ sha: string; url: string }>;
}

export class GitHubHttpClient implements IGitHubClient {
  private readonly appId: string;
  private readonly installationId: number;
  private readonly privateKeyPem: string;
  private readonly apiUrl: string;
  private readonly authService: GitHubAuthService;
  private readonly fetchFn: typeof fetch;

  // Cached installation token and expiration
  private cachedToken: string | null = null;
  private tokenExpiresAtMs = 0;

  constructor(options: GitHubHttpClientOptions) {
    if (!options.appId) throw new Error('GitHub App ID is required');
    if (!options.installationId) throw new Error('GitHub Installation ID is required');
    if (!options.privateKeyPem) throw new Error('GitHub App private key (PEM) is required');

    this.appId = options.appId;
    this.installationId = options.installationId;
    this.privateKeyPem = options.privateKeyPem;
    this.apiUrl = (options.apiUrl || 'https://api.github.com').replace(/\/+$/, '');
    this.authService = options.authService || new GitHubAuthService();
    this.fetchFn = options.fetchFn || globalThis.fetch.bind(globalThis);
  }

  /**
   * Retrieves a valid installation access token, exchanging JWT if expired or not yet cached.
   * Token refresh occurs automatically 2 minutes prior to expiration.
   */
  public async getInstallationToken(): Promise<string> {
    const now = Date.now();
    const safetyBufferMs = 120_000; // 2 minutes

    if (this.cachedToken && now < this.tokenExpiresAtMs - safetyBufferMs) {
      return this.cachedToken;
    }

    // 1. Generate App JWT (valid for 10 minutes)
    const jwt = this.authService.generateAppJwt(this.appId, this.privateKeyPem);

    // 2. Exchange JWT for installation access token
    const tokenUrl = `${this.apiUrl}/app/installations/${this.installationId}/access_tokens`;
    const res = await this.fetchFn(tokenUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'Collab-Platform-App',
      },
    });

    if (!res.ok) {
      const errorBody = await res.text().catch(() => '');
      const redacted = this.redactSensitiveData(errorBody);
      throw new Error(
        `Failed to authenticate as GitHub App Installation #${this.installationId} (HTTP ${res.status}): ${redacted}`
      );
    }

    const data = (await res.json()) as GitHubInstallationTokenResponse;
    if (!data.token) {
      throw new Error('GitHub installation token response missing access token');
    }

    this.cachedToken = data.token;
    this.tokenExpiresAtMs = new Date(data.expires_at).getTime();
    return this.cachedToken;
  }

  /**
   * Clears the cached installation token (e.g. if 401 Unauthorized is encountered).
   */
  public invalidateToken(): void {
    this.cachedToken = null;
    this.tokenExpiresAtMs = 0;
  }

  /**
   * Core request dispatcher with authenticated Bearer token and error redaction.
   */
  private async request<T>(
    endpointPath: string,
    options: {
      method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
      body?: unknown;
      allowNotFound?: boolean;
    }
  ): Promise<T | null> {
    const token = await this.getInstallationToken();
    const url = `${this.apiUrl}${endpointPath}`;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'Collab-Platform-App',
    };

    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    const res = await this.fetchFn(url, {
      method: options.method,
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });

    // 404 handling or 409 empty repo handling
    if (res.status === 404 && options.allowNotFound) {
      return null;
    }

    if (res.status === 409 && options.allowNotFound) {
      const errText = await res.text().catch(() => '');
      if (errText.includes('Git Repository is empty')) {
        return null;
      }
    }

    // 401 Unauthorized handling -> invalidate token cache
    if (res.status === 401) {
      this.invalidateToken();
      throw new Error(`GitHub API returned 401 Unauthorized for ${endpointPath}. Installation token invalidated.`);
    }

    // Rate limit detection
    const rateLimitRemaining = res.headers.get('x-ratelimit-remaining');
    if (rateLimitRemaining === '0') {
      const resetEpoch = res.headers.get('x-ratelimit-reset');
      const resetTime = resetEpoch ? new Date(Number(resetEpoch) * 1000).toISOString() : 'soon';
      throw new Error(`GitHub API rate limit exceeded. Quota resets at ${resetTime}.`);
    }

    if (!res.ok) {
      const errorText = await res.text().catch(() => '');
      const redacted = this.redactSensitiveData(errorText);

      // Distinguish non-fast-forward divergence for GitHubPublisher
      if (res.status === 422 && (redacted.includes('fast forward') || redacted.includes('Update is not a fast forward'))) {
        throw new Error(`Update rejected: Non-fast-forward push is forbidden (${redacted})`);
      }

      throw new Error(
        `GitHub API error [HTTP ${res.status} ${res.statusText}] at ${endpointPath}: ${redacted}`
      );
    }

    return (await res.json()) as T;
  }

  // --- IGitHubClient Implementation ---

  /**
   * Fetches the SHA and ref of a remote branch. Returns null if ref does not exist (404).
   */
  public async getRef(owner: string, repo: string, ref: string): Promise<GitRefResponse | null> {
    const subRef = this.normalizeToApiSubRef(ref);
    const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/ref/${subRef}`;

    const data = await this.request<GitHubRefApiResponse>(path, {
      method: 'GET',
      allowNotFound: true,
    });

    if (!data) return null;

    return {
      ref: data.ref,
      sha: data.object?.sha || (data as unknown as { sha: string }).sha,
    };
  }

  /**
   * Creates a Git Blob from file content.
   */
  public async createBlob(
    owner: string,
    repo: string,
    content: string,
    encoding: 'utf-8' | 'base64' = 'utf-8'
  ): Promise<GitBlobResponse> {
    const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/blobs`;

    const data = await this.request<GitHubBlobApiResponse>(path, {
      method: 'POST',
      body: { content, encoding },
    });

    if (!data) throw new Error('GitHub API returned empty response for createBlob');
    return { sha: data.sha };
  }

  /**
   * Creates a Git Tree from a list of tree items.
   */
  public async createTree(
    owner: string,
    repo: string,
    tree: GitTreeItem[],
    baseTreeSha?: string
  ): Promise<GitTreeResponse> {
    const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees`;

    const body: Record<string, unknown> = {
      tree: tree.map((item) => ({
        path: item.path,
        mode: item.mode,
        type: item.type,
        sha: item.sha,
      })),
    };

    if (baseTreeSha) {
      body.base_tree = baseTreeSha;
    }

    const data = await this.request<GitHubTreeApiResponse>(path, {
      method: 'POST',
      body,
    });

    if (!data) throw new Error('GitHub API returned empty response for createTree');
    return {
      sha: data.sha,
      tree: data.tree,
    };
  }

  /**
   * Creates a Git Commit pointing to a tree and optional parent commits.
   */
  public async createCommit(
    owner: string,
    repo: string,
    message: string,
    treeSha: string,
    parentShas: string[]
  ): Promise<GitCommitResponse> {
    const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/commits`;

    const data = await this.request<GitHubCommitApiResponse>(path, {
      method: 'POST',
      body: {
        message,
        tree: treeSha,
        parents: parentShas,
      },
    });

    if (!data) throw new Error('GitHub API returned empty response for createCommit');
    return {
      sha: data.sha,
      message: data.message,
      tree: { sha: data.tree.sha },
      parents: data.parents.map((p) => ({ sha: p.sha })),
    };
  }

  /**
   * Updates an existing Git Ref. Force-push is disabled by default (Requirement 10).
   */
  public async updateRef(
    owner: string,
    repo: string,
    ref: string,
    sha: string,
    force = false
  ): Promise<GitRefResponse> {
    const subRef = this.normalizeToApiSubRef(ref);
    const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/refs/${subRef}`;

    const data = await this.request<GitHubRefApiResponse>(path, {
      method: 'PATCH',
      body: { sha, force },
    });

    if (!data) throw new Error(`Failed to update ref ${ref}: empty response`);
    return {
      ref: data.ref,
      sha: data.object?.sha || (data as unknown as { sha: string }).sha,
    };
  }

  /**
   * Creates a new Git Ref (branch or tag).
   */
  public async createRef(
    owner: string,
    repo: string,
    ref: string,
    sha: string
  ): Promise<GitRefResponse> {
    const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/refs`;
    const fullRef = this.normalizeToFullRef(ref);

    const data = await this.request<GitHubRefApiResponse>(path, {
      method: 'POST',
      body: { ref: fullRef, sha },
    });

    if (!data) throw new Error(`Failed to create ref ${ref}: empty response`);
    return {
      ref: data.ref,
      sha: data.object?.sha || (data as unknown as { sha: string }).sha,
    };
  }

  /**
   * Initializes a brand-new empty repository by creating the initial commit and branch
   * via GitHub Contents API (PUT /repos/:owner/:repo/contents/:path).
   */
  public async createInitialCommit(
    owner: string,
    repo: string,
    filePath: string,
    content: string,
    branch: string,
    message: string
  ): Promise<GitCommitResponse> {
    const cleanBranch = branch.replace(/^refs\/heads\//, '').replace(/^heads\//, '');
    const cleanPath = filePath.replace(/^\/+/, '');
    const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${cleanPath}`;
    const base64Content = Buffer.from(content, 'utf-8').toString('base64');

    const res = await this.request<{
      content: { sha: string };
      commit: { sha: string; message: string; tree: { sha: string }; parents: Array<{ sha: string }> };
    }>(path, {
      method: 'PUT',
      body: {
        message,
        content: base64Content,
        branch: cleanBranch,
      },
    });

    if (!res || !res.commit) {
      throw new Error(`Failed to create initial commit on empty repository: ${path}`);
    }

    return {
      sha: res.commit.sha,
      message: res.commit.message,
      tree: { sha: res.commit.tree?.sha || res.commit.sha },
      parents: (res.commit.parents || []).map((p) => ({ sha: p.sha })),
    };
  }

  // --- Helpers ---

  /**
   * Normalizes a branch string into GitHub's sub-ref format for GET/PATCH endpoints.
   * e.g. "collab/wip" -> "heads/collab/wip"
   * e.g. "refs/heads/collab/wip" -> "heads/collab/wip"
   */
  private normalizeToApiSubRef(ref: string): string {
    const clean = ref.replace(/^refs\//, '');
    if (clean.startsWith('heads/') || clean.startsWith('tags/')) {
      return clean;
    }
    return `heads/${clean}`;
  }

  /**
   * Normalizes a branch string into GitHub's full ref format for POST git/refs endpoint.
   * e.g. "collab/wip" -> "refs/heads/collab/wip"
   */
  private normalizeToFullRef(ref: string): string {
    if (ref.startsWith('refs/')) return ref;
    return `refs/heads/${ref}`;
  }

  /**
   * Redacts sensitive strings (tokens, authorization headers, private keys) from error text.
   */
  private redactSensitiveData(text: string): string {
    if (!text) return '';
    return text
      .replace(/(gh[a-z]_[a-zA-Z0-9_]{10,}|github_pat_[a-zA-Z0-9_]{10,})/g, (m) => this.authService.redactToken(m))
      .replace(/(Bearer\s+)[^\s",]+/gi, '$1***')
      .replace(/("token":\s*")[^"]+(")/gi, '$1***$2')
      .replace(/("access_token":\s*")[^"]+(")/gi, '$1***$2');
  }
}
