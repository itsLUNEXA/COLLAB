/**
 * @file github-client.interface.ts
 * Strongly-typed interface for GitHub Git Data API operations.
 */

export interface GitRefResponse {
  ref: string;
  sha: string;
}

export interface GitBlobResponse {
  sha: string;
}

export interface GitTreeItem {
  path: string;
  mode: '100644' | '100755' | '040000' | '160000' | '120000';
  type: 'blob' | 'tree' | 'commit';
  sha: string;
}

export interface GitTreeResponse {
  sha: string;
  tree: GitTreeItem[];
}

export interface GitCommitResponse {
  sha: string;
  message: string;
  tree: { sha: string };
  parents: Array<{ sha: string }>;
}

export interface IGitHubClient {
  getRef(owner: string, repo: string, ref: string): Promise<GitRefResponse | null>;
  createBlob(
    owner: string,
    repo: string,
    content: string,
    encoding?: 'utf-8' | 'base64'
  ): Promise<GitBlobResponse>;
  createTree(
    owner: string,
    repo: string,
    tree: GitTreeItem[],
    baseTreeSha?: string
  ): Promise<GitTreeResponse>;
  createCommit(
    owner: string,
    repo: string,
    message: string,
    treeSha: string,
    parentShas: string[]
  ): Promise<GitCommitResponse>;
  updateRef(
    owner: string,
    repo: string,
    ref: string,
    sha: string,
    force?: boolean
  ): Promise<GitRefResponse>;
  createRef(
    owner: string,
    repo: string,
    ref: string,
    sha: string
  ): Promise<GitRefResponse>;
  createInitialCommit?(
    owner: string,
    repo: string,
    path: string,
    content: string,
    branch: string,
    message: string
  ): Promise<GitCommitResponse>;
}
