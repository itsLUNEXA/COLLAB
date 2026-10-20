/**
 * @file mock-github-client.ts
 * In-memory simulated GitHub Git Data API client for zero-dependency fast testing (Low RAM policy).
 * Strictly enforces fast-forward rules, branch divergence detection, and ref immutability.
 */

import crypto from 'node:crypto';
import {
  IGitHubClient,
  GitRefResponse,
  GitBlobResponse,
  GitTreeItem,
  GitTreeResponse,
  GitCommitResponse,
} from './github-client.interface.js';

interface StoredCommit {
  sha: string;
  message: string;
  treeSha: string;
  parents: string[];
}

export class MockGitHubClient implements IGitHubClient {
  private refs = new Map<string, string>(); // `${owner}/${repo}/${ref}` -> sha
  private commits = new Map<string, StoredCommit>(); // sha -> StoredCommit
  private trees = new Map<string, GitTreeItem[]>(); // sha -> GitTreeItem[]
  private blobs = new Map<string, string>(); // sha -> content

  // Diagnostic / Simulation hooks for testing
  public networkFailureCount = 0;
  public wasForcePushAttempted = false;

  private makeRefKey(owner: string, repo: string, ref: string): string {
    const normalizedRef = ref.startsWith('refs/') ? ref : `refs/heads/${ref}`;
    return `${owner}/${repo}/${normalizedRef}`;
  }

  public async getRef(owner: string, repo: string, ref: string): Promise<GitRefResponse | null> {
    if (this.networkFailureCount > 0) {
      this.networkFailureCount--;
      throw new Error('ETIMEDOUT: Connection to api.github.com timed out');
    }

    const key = this.makeRefKey(owner, repo, ref);
    const sha = this.refs.get(key);
    if (!sha) return null;
    return { ref, sha };
  }

  public async createBlob(
    _owner: string,
    _repo: string,
    content: string,
    _encoding?: 'utf-8' | 'base64'
  ): Promise<GitBlobResponse> {
    const sha = crypto.createHash('sha1').update(`blob ${content.length}\0${content}`).digest('hex');
    this.blobs.set(sha, content);
    return { sha };
  }

  public async createTree(
    _owner: string,
    _repo: string,
    tree: GitTreeItem[],
    _baseTreeSha?: string
  ): Promise<GitTreeResponse> {
    const sorted = [...tree].sort((a, b) => a.path.localeCompare(b.path));
    const treePayload = sorted.map((item) => `${item.mode} ${item.type} ${item.sha}\t${item.path}`).join('\n');
    const sha = crypto.createHash('sha1').update(`tree ${treePayload.length}\0${treePayload}`).digest('hex');
    this.trees.set(sha, sorted);
    return { sha, tree: sorted };
  }

  public async createCommit(
    _owner: string,
    _repo: string,
    message: string,
    treeSha: string,
    parentShas: string[]
  ): Promise<GitCommitResponse> {
    const commitPayload = `tree ${treeSha}\n${parentShas.map((p) => `parent ${p}\n`).join('')}\n${message}`;
    const sha = crypto.createHash('sha1').update(`commit ${commitPayload.length}\0${commitPayload}`).digest('hex');
    const commitRecord: StoredCommit = {
      sha,
      message,
      treeSha,
      parents: [...parentShas],
    };
    this.commits.set(sha, commitRecord);

    return {
      sha,
      message,
      tree: { sha: treeSha },
      parents: parentShas.map((p) => ({ sha: p })),
    };
  }

  public async updateRef(
    owner: string,
    repo: string,
    ref: string,
    sha: string,
    force = false
  ): Promise<GitRefResponse> {
    if (force) {
      this.wasForcePushAttempted = true;
    }

    const key = this.makeRefKey(owner, repo, ref);
    const currentSha = this.refs.get(key);

    if (currentSha && !force) {
      // Non-fast-forward check (Requirement 10: Never force-push or silently overwrite remote work)
      const targetCommit = this.commits.get(sha);
      if (!targetCommit || !targetCommit.parents.includes(currentSha)) {
        throw new Error(`Update rejected: Non-fast-forward push is forbidden (remote sha=${currentSha})`);
      }
    }

    this.refs.set(key, sha);
    return { ref, sha };
  }

  public async createRef(
    owner: string,
    repo: string,
    ref: string,
    sha: string
  ): Promise<GitRefResponse> {
    const key = this.makeRefKey(owner, repo, ref);
    if (this.refs.has(key)) {
      throw new Error(`Reference already exists: ${ref}`);
    }
    this.refs.set(key, sha);
    return { ref, sha };
  }

  public async createInitialCommit(
    owner: string,
    repo: string,
    filePath: string,
    content: string,
    branch: string,
    message: string
  ): Promise<GitCommitResponse> {
    const blob = await this.createBlob(owner, repo, content);
    const tree = await this.createTree(owner, repo, [{ path: filePath, mode: '100644', type: 'blob', sha: blob.sha }]);
    const commit = await this.createCommit(owner, repo, message, tree.sha, []);
    await this.createRef(owner, repo, branch, commit.sha);
    return commit;
  }

  // --- Test Helpers ---
  public seedBranch(owner: string, repo: string, branch: string, commitSha: string): void {
    const key = this.makeRefKey(owner, repo, branch);
    this.refs.set(key, commitSha);
  }

  public getCommit(sha: string): StoredCommit | null {
    return this.commits.get(sha) ?? null;
  }

  public getTree(sha: string): GitTreeItem[] | null {
    return this.trees.get(sha) ?? null;
  }
}
