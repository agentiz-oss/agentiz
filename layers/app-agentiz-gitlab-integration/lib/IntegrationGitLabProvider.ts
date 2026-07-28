import { GitLabProvider } from './GitLabProvider';
import type { NormalizedExternalTask } from '../../app-agentiz/lib/git';
import { parseTaskExternalId } from '../types/gitlab';

/**
 * GitLabProvider bound to one *linked* repository.
 *
 * Tasks coming from an integration carry a namespaced external id (`gl-<projectId>-<iid>`), because
 * one Agentiz project aggregates issues from many repositories. Everything the provider sends to
 * GitLab must use the bare issue iid again, which is the only thing this subclass does.
 */
export class IntegrationGitLabProvider extends GitLabProvider {
  private toIssueIid(externalId: string): string {
    return parseTaskExternalId(externalId)?.issueIid ?? externalId;
  }

  override async getTask(externalId: string): Promise<NormalizedExternalTask> {
    return super.getTask(this.toIssueIid(externalId));
  }

  override async updateTaskStatus(externalId: string, status: string): Promise<void> {
    return super.updateTaskStatus(this.toIssueIid(externalId), status);
  }

  override async commentOnTask(externalId: string, body: string): Promise<{ url: string }> {
    return super.commentOnTask(this.toIssueIid(externalId), body);
  }
}
