import { Op } from 'sequelize';
import { AgentProject } from '../../app-agentiz/models/AgentProject';
import { AgentRun } from '../../app-agentiz/models/AgentRun';
import { AgentRunDiff } from '../../app-agentiz/models/AgentRunDiff';
import { AgentTask } from '../../app-agentiz/models/AgentTask';
import { AgentWorkspaceProposal } from '../../app-agentiz/models/AgentWorkspaceProposal';
import { AgentWorkspaceProposalService, WorkspaceProposalError } from '../../app-agentiz/services/AgentWorkspaceProposalService';
import { MobileAuthError } from './MobileAuthService';

/**
 * Workspace proposals from the phone: the missing half of the review loop. The push says
 * "изменения ждут ревью" — these are the approve/reject that answer it without opening the panel.
 *
 * Ownership is resolved like everywhere else in this API: a proposal is reachable only through a
 * project the caller owns, anything else is a 404 that confirms nothing. The decisions themselves
 * go through `AgentWorkspaceProposalService`, which stays the single place that validates
 * revisions, statuses and queues the worker job — a stale revision or a wrong status comes back as
 * the 409 that service throws, passed to the client as-is so it can offer a refresh.
 */
export class MobileProposalService {
  private static async ownedProjectIds(ownerId: number | string): Promise<string[]> {
    const projects = await AgentProject.findAll({ where: { ownerId: ownerId as any }, attributes: ['id'] });
    return projects.map((project) => project.id);
  }

  private static row(
    proposal: AgentWorkspaceProposal,
    context: { task?: AgentTask | null; project?: AgentProject | null; diff?: AgentRunDiff | null; run?: AgentRun | null } = {},
  ) {
    return {
      id: proposal.id,
      status: proposal.status,
      revision: proposal.revision,
      projectId: proposal.projectId,
      projectName: context.project?.name ?? null,
      taskId: proposal.taskId,
      taskTitle: context.task?.title ?? null,
      runId: proposal.latestRunId,
      runStatus: context.run?.status ?? null,
      holding: proposal.reservationKey !== null,
      targetMode: proposal.targetMode,
      targetBranch: proposal.targetBranch,
      commitMessage: proposal.commitMessage,
      /** Whether approve is possible at all for this revision — see isApprovableDiff. */
      approvable: ['waiting_review', 'push_failed'].includes(proposal.status)
        && AgentWorkspaceProposalService.isApprovableDiff(context.diff ?? null),
      diff: context.diff
        ? {
            id: context.diff.id,
            operations: context.diff.ops?.length ?? 0,
            stats: context.diff.stats,
            truncated: context.diff.truncated,
          }
        : null,
      lastError: proposal.lastError,
      pushedCommitSha: proposal.pushedCommitSha,
      updatedAt: proposal.updatedAt,
      createdAt: proposal.createdAt,
    };
  }

  /**
   * Proposals of the caller's projects. Default: those a person has to look at (waiting_review /
   * push_failed / reset_failed); `holding=true` widens to everything still holding a directory,
   * which is the "почему воркспейс занят" question.
   */
  static async list(ownerId: number | string, options: { holding?: boolean } = {}) {
    const projectIds = await this.ownedProjectIds(ownerId);
    if (projectIds.length === 0) return [];
    const proposals = await AgentWorkspaceProposal.findAll({
      where: {
        projectId: { [Op.in]: projectIds },
        ...(options.holding === true
          ? { reservationKey: { [Op.ne]: null } }
          : { status: { [Op.in]: ['waiting_review', 'push_failed', 'reset_failed'] } }),
      },
      order: [['updatedAt', 'DESC']],
      limit: 100,
    });
    if (proposals.length === 0) return [];

    const [projects, tasks, diffs, runs] = await Promise.all([
      AgentProject.findAll({ where: { id: { [Op.in]: projectIds } } }),
      AgentTask.findAll({ where: { id: { [Op.in]: [...new Set(proposals.map((item) => item.taskId))] } } }),
      AgentRunDiff.findAll({ where: { id: { [Op.in]: proposals.map((item) => item.latestDiffId).filter(Boolean) as string[] } } }),
      AgentRun.findAll({ where: { id: { [Op.in]: [...new Set(proposals.map((item) => item.latestRunId))] } } }),
    ]);
    const projectById = new Map(projects.map((project) => [project.id, project]));
    const taskById = new Map(tasks.map((task) => [task.id, task]));
    const diffById = new Map(diffs.map((diff) => [diff.id, diff]));
    const runById = new Map(runs.map((run) => [run.id, run]));

    return proposals.map((proposal) => this.row(proposal, {
      project: projectById.get(proposal.projectId),
      task: taskById.get(proposal.taskId),
      diff: proposal.latestDiffId ? diffById.get(proposal.latestDiffId) : null,
      run: runById.get(proposal.latestRunId),
    }));
  }

  static async approve(
    proposalId: string,
    ownerId: number | string,
    input: { revision: number; targetBranch?: string; commitMessage?: string },
    actor: { id: number | null; name: string },
  ) {
    await this.requireOwned(proposalId, ownerId);
    const proposal = await this.rethrowing(() => AgentWorkspaceProposalService.approve(
      proposalId,
      input.revision,
      this.actorLabel(actor),
      { targetBranch: input.targetBranch, commitMessage: input.commitMessage },
    ));
    return this.detail(proposal);
  }

  static async reject(
    proposalId: string,
    ownerId: number | string,
    input: { revision: number },
    actor: { id: number | null; name: string },
  ) {
    await this.requireOwned(proposalId, ownerId);
    const proposal = await this.rethrowing(() => AgentWorkspaceProposalService.reject(
      proposalId,
      input.revision,
      this.actorLabel(actor),
    ));
    return this.detail(proposal);
  }

  /** Same convention as interaction answers: who decided, readable in `decisionActor`. */
  private static actorLabel(actor: { id: number | null; name: string }): string {
    return actor.id !== null ? `user:${actor.id} (${actor.name})` : actor.name;
  }

  private static async detail(proposal: AgentWorkspaceProposal) {
    const [project, task, diff, run] = await Promise.all([
      AgentProject.findByPk(proposal.projectId),
      AgentTask.findByPk(proposal.taskId),
      proposal.latestDiffId ? AgentRunDiff.findByPk(proposal.latestDiffId) : Promise.resolve(null),
      AgentRun.findByPk(proposal.latestRunId),
    ]);
    return this.row(proposal, { project, task, diff, run });
  }

  private static async requireOwned(proposalId: string, ownerId: number | string): Promise<AgentWorkspaceProposal> {
    const proposal = await AgentWorkspaceProposal.findByPk(proposalId);
    if (!proposal) throw new MobileAuthError(404, 'Proposal not found');
    const project = await AgentProject.findByPk(proposal.projectId);
    if (!project || String(project.ownerId ?? '') !== String(ownerId)) {
      throw new MobileAuthError(404, 'Proposal not found');
    }
    return proposal;
  }

  /**
   * The core service reports its status in `statusCode`, this router reads `status` — translate,
   * or every stale-revision 409 flattens into a 500 the client cannot act on.
   */
  private static async rethrowing<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (error instanceof WorkspaceProposalError) {
        throw new MobileAuthError(error.statusCode, error.message);
      }
      throw error;
    }
  }
}
