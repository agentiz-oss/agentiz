import { AgentProject } from '../models/AgentProject';
import { AgentTask } from '../models/AgentTask';
import { createGitProvider } from '../lib/git';
import type { NormalizedExternalTask } from '../lib/git';

export interface SyncResult {
  projectId: string;
  fetched: number;
  created: number;
  updated: number;
  errors: string[];
}

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
  static async syncProject(projectId: string): Promise<SyncResult> {
    const project = await AgentProject.findByPk(projectId);
    if (!project) throw new Error(`AgentProject ${projectId} not found`);

    const result: SyncResult = { projectId, fetched: 0, created: 0, updated: 0, errors: [] };
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

    await project.update({ lastSyncedAt: new Date() });
    console.log(
      `[AppAgentiz] synced project ${project.slug}: fetched=${result.fetched} created=${result.created} updated=${result.updated} errors=${result.errors.length}`,
    );
    return result;
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

    const provider = createGitProvider(project);
    await provider.updateTaskStatus(task.externalId, task.status);
  }
}
