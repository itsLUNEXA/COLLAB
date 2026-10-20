/**
 * @file publisher.ts
 * Serialized GitHub Checkpoint Publisher (Requirements 2-10).
 * Enforces branch validation, fast-forward protection, immutable snapshot publishing,
 * transient retry policies, and durable audit records.
 */

import {
  DbCheckpoint,
  DbPublishingAuditRecord,
  DbProject,
} from '@collab/db';
import { CheckpointStatus, CheckpointKind, ErrorCode } from '@collab/protocol';
import { IGitHubClient, GitTreeItem } from './github-client.interface.js';
import { ISyncRepository } from '../storage/sync-repository.interface.js';

export interface PublishRequest {
  project: DbProject;
  checkpoint: DbCheckpoint;
  files: Map<string, string>; // relative_path -> content
  targetBranch: string;
  commitMessage: string;
  expectedBaseSha?: string | null;
}

export interface PublishResult {
  success: boolean;
  commitSha: string | null;
  targetBranch: string;
  auditRecord: DbPublishingAuditRecord;
  error?: string;
  errorCode?: string;
}

export class GitHubPublisher {
  // Requirement 5: Serialize publishing operations per project
  private projectLocks = new Map<string, Promise<unknown>>();

  constructor(
    private githubClient: IGitHubClient,
    private repository: ISyncRepository,
    private maxRetries = 3,
    private retryDelayMs = 10
  ) {}

  /**
   * Publishes a checkpoint with queue serialization per project.
   */
  public async publish(req: PublishRequest): Promise<PublishResult> {
    const projectId = req.project.id;
    const prevLock = this.projectLocks.get(projectId) ?? Promise.resolve();

    let releaseLock: () => void;
    const currentLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    this.projectLocks.set(projectId, currentLock);

    try {
      await prevLock;
      return await this.executeWithRetry(req);
    } finally {
      releaseLock!();
      if (this.projectLocks.get(projectId) === currentLock) {
        this.projectLocks.delete(projectId);
      }
    }
  }

  private async executeWithRetry(req: PublishRequest): Promise<PublishResult> {
    let attempt = 0;
    let lastError: Error | null = null;

    // Requirement 7: For VERIFIED_INTEGRATION, publish only if checks passed
    if (req.checkpoint.kind === CheckpointKind.VERIFIED_INTEGRATION) {
      if (req.checkpoint.status !== CheckpointStatus.PASSED) {
        const errorMsg = `Cannot publish unverified checkpoint: status is ${req.checkpoint.status}`;
        const audit = await this.repository.savePublishingAuditRecord({
          project_id: req.project.id,
          checkpoint_id: req.checkpoint.id,
          target_branch: req.targetBranch,
          base_sha: null,
          commit_sha: null,
          status: 'FAILED',
          attempt: 1,
          error_message: errorMsg,
        });
        return {
          success: false,
          commitSha: null,
          targetBranch: req.targetBranch,
          auditRecord: audit,
          error: errorMsg,
          errorCode: ErrorCode.CHECKPOINT_VALIDATION_FAILED,
        };
      }
    }

    const owner = req.project.github_repo_owner;
    const repo = req.project.github_repo_name;

    if (!owner || !repo) {
      const errorMsg = 'Project is missing github_repo_owner or github_repo_name';
      const audit = await this.repository.savePublishingAuditRecord({
        project_id: req.project.id,
        checkpoint_id: req.checkpoint.id,
        target_branch: req.targetBranch,
        base_sha: null,
        commit_sha: null,
        status: 'FAILED',
        attempt: 1,
        error_message: errorMsg,
      });
      return {
        success: false,
        commitSha: null,
        targetBranch: req.targetBranch,
        auditRecord: audit,
        error: errorMsg,
      };
    }

    while (attempt < this.maxRetries) {
      attempt++;
      try {
        // 1. Fetch remote ref SHA
        let remoteRef = await this.githubClient.getRef(owner, repo, req.targetBranch);
        let remoteSha = remoteRef ? remoteRef.sha : null;

        // If the repository is completely empty and createInitialCommit is supported:
        if (remoteSha === null && typeof this.githubClient.createInitialCommit === 'function' && req.files.size > 0) {
          const entries = Array.from(req.files.entries());
          if (entries.length === 1) {
            const [firstPath, firstContent] = entries[0];
            const commit = await this.githubClient.createInitialCommit(
              owner,
              repo,
              firstPath,
              firstContent,
              req.targetBranch,
              req.commitMessage
            );

            // Update Checkpoint Status to PUBLISHED
            await this.repository.updateCheckpointStatus(req.checkpoint.id, CheckpointStatus.PUBLISHED, {
              github_commit_sha: commit.sha,
              published_at: new Date().toISOString(),
            });

            // Audit Record
            const audit = await this.repository.savePublishingAuditRecord({
              project_id: req.project.id,
              checkpoint_id: req.checkpoint.id,
              target_branch: req.targetBranch,
              base_sha: null,
              commit_sha: commit.sha,
              status: 'SUCCESS',
              attempt,
              error_message: null,
            });

            return {
              success: true,
              commitSha: commit.sha,
              targetBranch: req.targetBranch,
              auditRecord: audit,
            };
          } else {
            const [firstPath, firstContent] = entries[0];
            const initCommit = await this.githubClient.createInitialCommit(
              owner,
              repo,
              firstPath,
              firstContent,
              req.targetBranch,
              `chore: initialize ${req.targetBranch}`
            );
            remoteRef = { ref: req.targetBranch, sha: initCommit.sha };
            remoteSha = initCommit.sha;
          }
        }

        // Requirement 5 & 10: Validate expected base SHA against remote SHA if provided
        if (req.expectedBaseSha && remoteSha && req.expectedBaseSha !== remoteSha) {
          const divergenceMsg = `Remote branch has diverged: expected base ${req.expectedBaseSha}, found ${remoteSha}`;
          const audit = await this.repository.savePublishingAuditRecord({
            project_id: req.project.id,
            checkpoint_id: req.checkpoint.id,
            target_branch: req.targetBranch,
            base_sha: remoteSha,
            commit_sha: null,
            status: 'FAILED',
            attempt,
            error_message: divergenceMsg,
          });
          return {
            success: false,
            commitSha: null,
            targetBranch: req.targetBranch,
            auditRecord: audit,
            error: divergenceMsg,
            errorCode: ErrorCode.BRANCH_DIVERGENCE,
          };
        }

        // 2. Create Blobs for exact snapshot files
        const treeItems: GitTreeItem[] = [];
        for (const [relativePath, content] of req.files.entries()) {
          const blob = await this.githubClient.createBlob(owner, repo, content, 'utf-8');
          treeItems.push({
            path: relativePath,
            mode: '100644',
            type: 'blob',
            sha: blob.sha,
          });
        }

        // 3. Create Tree
        const tree = await this.githubClient.createTree(owner, repo, treeItems);

        // 4. Create Commit
        const parentShas = remoteSha ? [remoteSha] : [];
        const commit = await this.githubClient.createCommit(
          owner,
          repo,
          req.commitMessage,
          tree.sha,
          parentShas
        );

        // 5. Update Ref with force: false (Requirement 10: Never force-push)
        if (remoteRef) {
          await this.githubClient.updateRef(owner, repo, req.targetBranch, commit.sha, false);
        } else {
          await this.githubClient.createRef(owner, repo, req.targetBranch, commit.sha);
        }

        // 6. Update Checkpoint Status to PUBLISHED
        await this.repository.updateCheckpointStatus(req.checkpoint.id, CheckpointStatus.PUBLISHED, {
          github_commit_sha: commit.sha,
          published_at: new Date().toISOString(),
        });

        // 7. Audit Record
        const audit = await this.repository.savePublishingAuditRecord({
          project_id: req.project.id,
          checkpoint_id: req.checkpoint.id,
          target_branch: req.targetBranch,
          base_sha: remoteSha,
          commit_sha: commit.sha,
          status: 'SUCCESS',
          attempt,
          error_message: null,
        });

        return {
          success: true,
          commitSha: commit.sha,
          targetBranch: req.targetBranch,
          auditRecord: audit,
        };
      } catch (err: unknown) {
        lastError = err instanceof Error ? err : new Error(String(err));

        // If non-fast-forward push rejection: deterministic failure, do NOT retry
        if (lastError.message.includes('Non-fast-forward') || lastError.message.includes('Divergence')) {
          const audit = await this.repository.savePublishingAuditRecord({
            project_id: req.project.id,
            checkpoint_id: req.checkpoint.id,
            target_branch: req.targetBranch,
            base_sha: null,
            commit_sha: null,
            status: 'FAILED',
            attempt,
            error_message: lastError.message,
          });
          return {
            success: false,
            commitSha: null,
            targetBranch: req.targetBranch,
            auditRecord: audit,
            error: lastError.message,
            errorCode: ErrorCode.BRANCH_DIVERGENCE,
          };
        }

        // Record retry attempt audit
        if (attempt < this.maxRetries) {
          await this.repository.savePublishingAuditRecord({
            project_id: req.project.id,
            checkpoint_id: req.checkpoint.id,
            target_branch: req.targetBranch,
            base_sha: null,
            commit_sha: null,
            status: 'RETRYING',
            attempt,
            error_message: lastError.message,
          });
          await new Promise((r) => setTimeout(r, this.retryDelayMs));
        }
      }
    }

    // Exhausted retries (Requirement 8: Preserve work on failure)
    const finalAudit = await this.repository.savePublishingAuditRecord({
      project_id: req.project.id,
      checkpoint_id: req.checkpoint.id,
      target_branch: req.targetBranch,
      base_sha: null,
      commit_sha: null,
      status: 'FAILED',
      attempt,
      error_message: lastError ? lastError.message : 'Unknown error',
    });

    return {
      success: false,
      commitSha: null,
      targetBranch: req.targetBranch,
      auditRecord: finalAudit,
      error: lastError ? lastError.message : 'Publishing failed after retries',
    };
  }
}
