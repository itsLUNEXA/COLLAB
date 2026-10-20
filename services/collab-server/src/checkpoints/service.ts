/**
 * @file service.ts
 * Checkpoint Service coordinating WIP checkpoints, Verified Integration Gates, and GitHub Publishing.
 */

import crypto from 'node:crypto';
import {
  DbCheckpoint,
  DbProject,
} from '@collab/db';
import {
  CheckpointKind,
  CheckpointStatus,
  computeSnapshotIdentity,
  SnapshotIdentity,
} from '@collab/protocol';
import { ISyncRepository } from '../storage/sync-repository.interface.js';
import { CheckpointValidationGate } from './validation-gate.js';
import { GitHubPublisher, PublishResult } from '../github/publisher.js';
import { IGitHubClient } from '../github/github-client.interface.js';

export interface CreateCheckpointInput {
  projectId: string;
  userId: string;
  files: Array<{ relative_path: string; content: string }>;
  label?: string;
  commitMessage?: string;
  publishImmediately?: boolean;
}

export class CheckpointService {
  private validationGate = new CheckpointValidationGate();
  private publisher: GitHubPublisher;

  constructor(
    private repository: ISyncRepository,
    private githubClient: IGitHubClient
  ) {
    this.publisher = new GitHubPublisher(this.githubClient, this.repository);
  }

  /**
   * Creates a Work-in-Progress (WIP) checkpoint snapshot (Safeguard 2).
   * Captured without requiring full verification checks; never discarded.
   */
  public async createWipCheckpoint(input: CreateCheckpointInput): Promise<{
    checkpoint: DbCheckpoint;
    snapshot: SnapshotIdentity;
    publishResult?: PublishResult;
  }> {
    const project = await this.getProjectOrThrow(input.projectId);
    const seq = await this.repository.getCurrentSequenceNum(project.id);

    const snapshot = computeSnapshotIdentity(input.files);
    const checkpointId = crypto.randomUUID();

    const commitMessage = input.commitMessage || input.label || `wip: sync checkpoint at seq ${seq}`;

    const checkpoint: DbCheckpoint = {
      id: checkpointId,
      project_id: project.id,
      kind: CheckpointKind.WIP_SNAPSHOT,
      status: CheckpointStatus.PASSED, // WIP milestones are unconditionally accepted
      sync_sequence_num: seq,
      tree_sha256: snapshot.tree_sha256,
      file_count: snapshot.file_count,
      manifest: snapshot.manifest,
      validation_report: null,
      github_target_branch: project.wip_branch,
      github_commit_sha: null,
      commit_message: commitMessage,
      created_by_user_id: input.userId,
      created_at: new Date().toISOString(),
      published_at: null,
    };

    const saved = await this.repository.saveCheckpoint(checkpoint);

    let publishResult: PublishResult | undefined;
    if (input.publishImmediately) {
      const fileMap = new Map(input.files.map((f) => [f.relative_path, f.content]));
      publishResult = await this.publisher.publish({
        project,
        checkpoint: saved,
        files: fileMap,
        targetBranch: project.wip_branch,
        commitMessage,
      });
    }

    return { checkpoint: saved, snapshot, publishResult };
  }

  /**
   * Creates a Verified Integration Checkpoint through the Validation Gate (Safeguard 3).
   * Only transitions to PASSED if all checks succeed.
   */
  public async createIntegrationCheckpoint(input: CreateCheckpointInput): Promise<{
    checkpoint: DbCheckpoint;
    snapshot: SnapshotIdentity;
    publishResult?: PublishResult;
  }> {
    const project = await this.getProjectOrThrow(input.projectId);
    const seq = await this.repository.getCurrentSequenceNum(project.id);

    const snapshot = computeSnapshotIdentity(input.files);
    const fileMap = new Map(input.files.map((f) => [f.relative_path, f.content]));

    // Run automated validation gate
    const validationReport = await this.validationGate.validate(
      project.id,
      { snapshot, files: fileMap },
      this.repository
    );

    const status = validationReport.passed ? CheckpointStatus.PASSED : CheckpointStatus.FAILED;
    const checkpointId = crypto.randomUUID();
    const commitMessage = input.commitMessage || `feat: verified integration checkpoint at seq ${seq}`;

    const checkpoint: DbCheckpoint = {
      id: checkpointId,
      project_id: project.id,
      kind: CheckpointKind.VERIFIED_INTEGRATION,
      status,
      sync_sequence_num: seq,
      tree_sha256: snapshot.tree_sha256,
      file_count: snapshot.file_count,
      manifest: snapshot.manifest,
      validation_report: validationReport as unknown as Record<string, unknown>,
      github_target_branch: project.integrated_branch,
      github_commit_sha: null,
      commit_message: commitMessage,
      created_by_user_id: input.userId,
      created_at: new Date().toISOString(),
      published_at: null,
    };

    const saved = await this.repository.saveCheckpoint(checkpoint);

    let publishResult: PublishResult | undefined;
    // Auto-publish only if validation passed and requested
    if (input.publishImmediately && validationReport.passed) {
      publishResult = await this.publisher.publish({
        project,
        checkpoint: saved,
        files: fileMap,
        targetBranch: project.integrated_branch,
        commitMessage,
      });
    }

    return { checkpoint: saved, snapshot, publishResult };
  }

  /**
   * Publishes an existing checkpoint to GitHub with remote branch SHA verification.
   */
  public async publishCheckpoint(
    checkpointId: string,
    files: Map<string, string>,
    expectedBaseSha?: string | null
  ): Promise<PublishResult> {
    const checkpoint = await this.repository.getCheckpoint(checkpointId);
    if (!checkpoint) {
      throw new Error(`Checkpoint ${checkpointId} not found`);
    }

    const project = await this.getProjectOrThrow(checkpoint.project_id);
    const targetBranch = checkpoint.github_target_branch || project.integrated_branch;

    return this.publisher.publish({
      project,
      checkpoint,
      files,
      targetBranch,
      commitMessage: checkpoint.commit_message || `publish checkpoint ${checkpoint.id}`,
      expectedBaseSha,
    });
  }

  private async getProjectOrThrow(projectId: string): Promise<DbProject> {
    const project = await this.repository.getProject(projectId);
    if (!project) {
      throw new Error(`Project ${projectId} not found`);
    }
    return project;
  }
}
