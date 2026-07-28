import { AgentProject } from '../models/AgentProject';
import { AgentTask } from '../models/AgentTask';
import { createGitProvider, createGitProviderForTask } from '../lib/git';
import type { NormalizedExternalTask } from '../lib/git';

export interface SyncResult {
  projectId: string;
  fetched: number;
  created: number;
  updated: number;
  errors: string[];
}

/**
 * Extra task sources attached to a project by another layer (e.g. the GitLab integrations layer,
 * which mirrors issues from every repository linked to the project). Their counters are merged
 * into the SyncResult so one "sync" action covers everything wired to the project.
 */
export type ProjectSyncContributor = (project: AgentProject) => Promise<Omit<SyncResult, 'projectId'>>;

const syncContributors = new Map<string, ProjectSyncContributor>();

/** Once our pipeline owns a task, the tracker's own state must not overwrite our lifecycle. */
const LOCALLY_OWNED_STATUSES = new Set(['queued', 'running', 'waiting_review']);

/**
 * "После того, как мы получаем задачу в какой-то внешней среде, мы её синхроним, затягиваем себе"
 * — mirrors tracker issues into AgentTask rows and refreshes them on later syncs.
 *
 * Only `externalStatus` and the descriptive fields are refreshed from the tracker; the internal
 * `status` (our pipeline lifecycle) is left alone while a run owns the task, and a task closed
 * upstream is marked `ignored` so it stops being picked up.
 */
export class GitSyncService {
  static registerSyncContributor(appId: string, contributor: ProjectSyncContributor): void {
    syncContributors.set(appId, contributor);
  }

  static unregisterSyncContributor(appId: string): void {
    syncContributors.delete(appId);
  }

  /** True when the project carries its own repo credentials; false when it only has integrations. */
  private static hasOwnRepo(project: AgentProject): boolean {
    return Boolean(project.secrets?.token && project.repoConfig?.owner && project.repoConfig?.repo);
  }

  static async syncProject(projectId: string): Promise<SyncResult> {
    const project = await AgentProject.findByPk(projectId);
    if (!project) throw new Error(`AgentProject ${projectId} not found`);

    const result: SyncResult = { projectId, fetched: 0, created: 0, updated: 0, errors: [] };

    // A project may own no repository at all and get every task from linked integrations.
    if (!this.hasOwnRepo(project)) {
      await this.runContributors(project, result);
      await project.update({ lastSyncedAt: new Date() });
      return result;
    }

    const provider = createGitProvider(project);

    let external: NormalizedExternalTask[];
    try {
      external = await provider.listTasks({
        updatedSince: project.lastSyncedAt ?? undefined,
        query: project.trackerConfig?.query,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(message);
      console.error(`[AppAgentiz] sync failed for project ${project.slug}: ${message}`);
      await this.runContributors(project, result);
      return result;
    }

    result.fetched = external.length;

    for (const item of external) {
      try {
        const existing = await AgentTask.findOne({
          where: { projectId: project.id, externalId: item.externalId },
        });

        if (!existing) {
          await AgentTask.create({
            projectId: project.id,
            externalId: item.externalId,
            externalUrl: item.externalUrl,
            title: item.title,
            description: item.description,
            tags: item.tags,
            externalStatus: item.externalStatus,
            status: 'new',
            raw: item.raw as Record<string, unknown>,
            lastSyncedAt: new Date(),
          });
          result.created += 1;
          continue;
        }

        const isClosedUpstream = ['closed', 'merged'].includes(item.externalStatus.toLowerCase());
        const keepLocalStatus = LOCALLY_OWNED_STATUSES.has(existing.status);
        const nextStatus =
          isClosedUpstream && !keepLocalStatus && existing.status === 'new' ? 'ignored' : existing.status;

        await existing.update({
          externalUrl: item.externalUrl,
          title: item.title,
          description: item.description,
          tags: item.tags,
          externalStatus: item.externalStatus,
          status: nextStatus,
          raw: item.raw as Record<string, unknown>,
          lastSyncedAt: new Date(),
        });
        result.updated += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(`${item.externalId}: ${message}`);
      }
    }

    await this.runContributors(project, result);

    await project.update({ lastSyncedAt: new Date() });
    console.log(
      `[AppAgentiz] synced project ${project.slug}: fetched=${result.fetched} created=${result.created} updated=${result.updated} errors=${result.errors.length}`,
    );
    return result;
  }

  private static async runContributors(project: AgentProject, result: SyncResult): Promise<void> {
    for (const [appId, contributor] of syncContributors) {
      try {
        const partial = await contributor(project);
        result.fetched += partial.fetched;
        result.created += partial.created;
        result.updated += partial.updated;
        result.errors.push(...partial.errors);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(`${appId}: ${message}`);
      }
    }
  }

  static async syncAllActiveProjects(): Promise<SyncResult[]> {
    const projects = await AgentProject.findAll({ where: { isActive: true } });
    const results: SyncResult[] = [];
    for (const project of projects) {
      try {
        results.push(await this.syncProject(project.id));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        results.push({ projectId: project.id, fetched: 0, created: 0, updated: 0, errors: [message] });
      }
    }
    return results;
  }

  /**
   * Pushes our lifecycle back to the tracker. Called after a run finishes when the project wants
   * the upstream issue closed/reopened — "время от времени мы должны обновлять статус этой задачи".
   */
  static async pushTaskStatus(taskId: string): Promise<void> {
    const task = await AgentTask.findByPk(taskId);
    if (!task) throw new Error(`AgentTask ${taskId} not found`);
    const project = await AgentProject.findByPk(task.projectId);
    if (!project) throw new Error(`AgentProject ${task.projectId} not found`);

    const provider = await createGitProviderForTask(task, project);
    await provider.updateTaskStatus(task.externalId, task.status);
  }
}
