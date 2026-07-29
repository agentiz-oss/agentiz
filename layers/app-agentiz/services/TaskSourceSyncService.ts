import { AgentProject } from '../models/AgentProject';
import { AgentTask } from '../models/AgentTask';
import { AgentTaskSource } from '../models/AgentTaskSource';
import { createTaskManager, getTaskManagerAdapter } from '../lib/taskManager';
import type { NormalizedExternalTask } from '../lib/taskManager';

export interface TaskSourceSyncResult {
  sourceId: string;
  sourceName: string;
  type: string;
  fetched: number;
  created: number;
  updated: number;
  /** Comments pulled from the tracker; only non-zero when the source has syncComments enabled. */
  commentsPulled: number;
  errors: string[];
}

/** Once our pipeline owns a task, the tracker's own state must not overwrite our lifecycle. */
const LOCALLY_OWNED_STATUSES = new Set(['queued', 'running', 'waiting_review']);

/**
 * Mirrors tasks from every remote task manager configured on a project.
 *
 * This is the generic counterpart of GitSyncService: instead of one repository per project it
 * walks `AgentTaskSource` rows, each pointing at an adapter registered in the `taskManagers`
 * collection. A project can therefore aggregate GitHub Issues, Jira and anything a future layer
 * contributes, and each mirrored AgentTask records which source it came from.
 *
 * External ids are namespaced per source (`<sourceId>:<externalId>`) because two trackers will
 * happily both call an issue "42"; without the namespace they would collide on the
 * (projectId, externalId) lookup and silently overwrite each other.
 */
export class TaskSourceSyncService {
  /** The stored externalId for a task from `source`. */
  static namespacedExternalId(sourceId: string, externalId: string): string {
    return `${sourceId}:${externalId}`;
  }

  /** Inverse of namespacedExternalId — what the remote system calls this task. */
  static remoteExternalId(task: AgentTask): string {
    if (!task.sourceId) return task.externalId;
    const prefix = `${task.sourceId}:`;
    return task.externalId.startsWith(prefix) ? task.externalId.slice(prefix.length) : task.externalId;
  }

  /** Label stored on each task, e.g. "GitHub Issues · Основной репозиторий". */
  private static sourceLabel(source: AgentTaskSource): string {
    const adapter = getTaskManagerAdapter(source.type);
    return adapter ? `${adapter.title} · ${source.name}` : `${source.type} · ${source.name}`;
  }

  static async syncSource(sourceId: string): Promise<TaskSourceSyncResult> {
    const source = await AgentTaskSource.findByPk(sourceId);
    if (!source) throw new Error(`AgentTaskSource ${sourceId} not found`);
    return this.syncOne(source);
  }

  /** Every active source of one project. Errors are collected per source, never thrown. */
  static async syncProject(projectId: string): Promise<TaskSourceSyncResult[]> {
    const sources = await AgentTaskSource.findAll({ where: { projectId, isActive: true } });
    const results: TaskSourceSyncResult[] = [];
    for (const source of sources) {
      results.push(await this.syncOne(source));
    }
    return results;
  }

  static async syncAllActiveProjects(): Promise<TaskSourceSyncResult[]> {
    const projects = await AgentProject.findAll({ where: { isActive: true } });
    const results: TaskSourceSyncResult[] = [];
    for (const project of projects) {
      results.push(...(await this.syncProject(project.id)));
    }
    return results;
  }

  private static async syncOne(source: AgentTaskSource): Promise<TaskSourceSyncResult> {
    const result: TaskSourceSyncResult = {
      sourceId: source.id,
      sourceName: source.name,
      type: source.type,
      fetched: 0,
      created: 0,
      updated: 0,
      commentsPulled: 0,
      errors: [],
    };

    let external: NormalizedExternalTask[];
    try {
      const provider = createTaskManager(source.type, source.config ?? {}, source.secrets ?? {});
      external = await provider.listTasks({
        updatedSince: source.lastSyncedAt ?? undefined,
        query: (source.config?.query as Record<string, unknown>) ?? undefined,
      });
    } catch (error) {
      // A missing adapter (its layer is not mounted) reads exactly like a network failure here,
      // and both belong on the source row so the UI can show why it stopped updating.
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(message);
      await source.update({ lastError: message });
      console.error(`[app-agentiz] task source ${source.name} (${source.type}) failed: ${message}`);
      return result;
    }

    result.fetched = external.length;
    const label = this.sourceLabel(source);
    /** Tasks this run created or refreshed — the only ones whose discussion can have changed. */
    const touched: string[] = [];

    for (const item of external) {
      try {
        const externalId = this.namespacedExternalId(source.id, item.externalId);
        const existing = await AgentTask.findOne({
          where: { projectId: source.projectId, externalId },
        });

        if (!existing) {
          const fresh = await AgentTask.create({
            projectId: source.projectId,
            externalId,
            externalUrl: item.externalUrl,
            title: item.title,
            description: item.description,
            tags: item.tags,
            externalStatus: item.externalStatus,
            status: 'new',
            sourceId: source.id,
            sourceType: source.type,
            sourceName: label,
            raw: item.raw as Record<string, unknown>,
            lastSyncedAt: new Date(),
          });
          touched.push(fresh.id);
          result.created += 1;
          continue;
        }

        const isClosedUpstream = ['closed', 'merged', 'done', 'resolved'].includes(
          item.externalStatus.toLowerCase(),
        );
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
          sourceId: source.id,
          sourceType: source.type,
          sourceName: label,
          raw: item.raw as Record<string, unknown>,
          lastSyncedAt: new Date(),
        });
        touched.push(existing.id);
        result.updated += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(`${item.externalId}: ${message}`);
      }
    }

    if (source.syncComments && touched.length > 0) {
      result.commentsPulled = await this.pullCommentsFor(touched, result);
    }

    await source.update({
      lastSyncedAt: new Date(),
      lastError: result.errors.length ? result.errors.join('; ').slice(0, 1000) : null,
    });
    console.log(
      `[app-agentiz] synced source ${source.name} (${source.type}): fetched=${result.fetched} created=${result.created} updated=${result.updated} comments=${result.commentsPulled} errors=${result.errors.length}`,
    );
    return result;
  }

  /**
   * Mirrors the discussion of every task the sync just touched.
   *
   * Imported lazily to keep the dependency one-way at module load: AgentTaskService already
   * imports this service for `remoteExternalId`, and a static import here would close the cycle.
   * Per-task failures are collected, never thrown — a thread we cannot read must not invalidate
   * the tasks we did sync.
   */
  private static async pullCommentsFor(taskIds: string[], result: TaskSourceSyncResult): Promise<number> {
    const { AgentTaskService } = await import('./AgentTaskService');
    let pulled = 0;
    for (const taskId of taskIds) {
      try {
        const counts = await AgentTaskService.pullComments(taskId);
        pulled += counts.created;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(`comments ${taskId}: ${message}`);
      }
    }
    return pulled;
  }

  /** Cheap credential check behind the UI's "проверить" button. */
  static async testSource(sourceId: string): Promise<boolean> {
    const source = await AgentTaskSource.findByPk(sourceId);
    if (!source) throw new Error(`AgentTaskSource ${sourceId} not found`);
    const provider = createTaskManager(source.type, source.config ?? {}, source.secrets ?? {});
    return provider.testConnection();
  }
}
