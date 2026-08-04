import { Op } from 'sequelize';
import { AgentProject } from '../models/AgentProject';
import { AgentRun } from '../models/AgentRun';
import { AgentRunLog } from '../models/AgentRunLog';
import { AgentStageExecution } from '../models/AgentStageExecution';
import { AgentTask } from '../models/AgentTask';
import { AgentTaskComment } from '../models/AgentTaskComment';
import { AgentTaskSource } from '../models/AgentTaskSource';
import {
  createTaskManager,
  getTaskManagerAdapter,
  isTaskSourceAvailable,
  LOCAL_TASK_SOURCE_TYPE,
  taskManagerTitle,
} from '../lib/taskManager';
import type { CommentResult, NormalizedExternalComment } from '../lib/taskManager';
import { createGitProviderForTask } from '../lib/git';
import { TaskSourceSyncService } from './TaskSourceSyncService';
import { AgentPipelineService } from './AgentPipelineService';
import type { AgentTaskCommentAuthorKind, AgentTaskPriority, AgentTaskStatus } from '../types/agentiz';

const TASK_STATUSES: AgentTaskStatus[] = [
  'new',
  'queued',
  'running',
  'waiting_review',
  'done',
  'failed',
  'cancelled',
  'ignored',
];

const TASK_PRIORITIES: AgentTaskPriority[] = ['low', 'normal', 'high', 'urgent'];

/** Statuses a run currently owns — changing them by hand would fight the pipeline. */
const PIPELINE_OWNED = new Set<AgentTaskStatus>(['queued', 'running']);

export interface TaskListFilters {
  projectId?: string;
  status?: string;
  priority?: string;
  sourceType?: string;
  assigneeId?: number | null;
  search?: string;
  tag?: string;
  limit?: number;
  offset?: number;
}

export class TaskServiceError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * The built-in task tracker: everything the Agentiz tasks UI needs that is not the sync itself.
 *
 * Tasks arrive here from several places (remote task managers via TaskSourceSyncService, the
 * project's own repository via GitSyncService, or created by hand), so this service deliberately
 * treats a task as a first-class local object: it can be filtered, re-prioritised, assigned,
 * commented on and closed without any upstream system being reachable.
 */
export class AgentTaskService {
  /** What the UI needs to render its filter controls. */
  static async filterOptions(): Promise<Record<string, unknown>> {
    const [projects, sources] = await Promise.all([
      AgentProject.findAll({ order: [['name', 'ASC']] }),
      AgentTaskSource.findAll({ order: [['name', 'ASC']] }),
    ]);
    // Types actually present in the data, so a filter never offers an empty option, plus the
    // types of every configured source even if nothing has been synced from them yet.
    const usedTypes = await AgentTask.findAll({
      attributes: ['sourceType'],
      group: ['sourceType'],
      raw: true,
    });
    const types = new Set<string>();
    for (const row of usedTypes as unknown as Array<{ sourceType: string | null }>) {
      if (row.sourceType) types.add(row.sourceType);
    }
    for (const source of sources) types.add(source.type);

    return {
      statuses: TASK_STATUSES,
      priorities: TASK_PRIORITIES,
      projects: projects.map((p) => ({ id: p.id, name: p.name, slug: p.slug })),
      sourceTypes: [...types].map((type) => ({
        type,
        title: taskManagerTitle(type),
        available: isTaskSourceAvailable(type),
      })),
    };
  }

  static async list(filters: TaskListFilters): Promise<{ items: unknown[]; total: number }> {
    const where: Record<string, unknown> = {};
    if (filters.projectId) where.projectId = filters.projectId;
    if (filters.status) where.status = filters.status;
    if (filters.priority) where.priority = filters.priority;
    if (filters.sourceType) where.sourceType = filters.sourceType;
    if (filters.assigneeId !== undefined) where.assigneeId = filters.assigneeId;
    if (filters.search) {
      const needle = `%${filters.search}%`;
      where[Op.or as unknown as string] = [
        { title: { [Op.like]: needle } },
        { description: { [Op.like]: needle } },
        { externalId: { [Op.like]: needle } },
      ];
    }

    const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
    const offset = Math.max(filters.offset ?? 0, 0);

    const { rows, count } = await AgentTask.findAndCountAll({
      where,
      order: [
        ['updatedAt', 'DESC'],
      ],
      limit,
      offset,
    });

    // Tag filtering happens here rather than in SQL: `tags` is a JSON column and the app must work
    // on both SQLite and Postgres, whose JSON operators do not overlap.
    const filtered = filters.tag
      ? rows.filter((task) => (task.tags ?? []).includes(filters.tag as string))
      : rows;

    const commentCounts = await this.commentCounts(filtered.map((t) => t.id));

    return {
      items: filtered.map((task) => ({
        ...task.toJSON(),
        sourceTitle: taskManagerTitle(task.sourceType),
        sourceAvailable: isTaskSourceAvailable(task.sourceType),
        // externalId is namespaced per source to avoid collisions between trackers; the UI shows
        // the number the remote system actually uses.
        remoteExternalId: TaskSourceSyncService.remoteExternalId(task),
        commentCount: commentCounts.get(task.id) ?? 0,
      })),
      total: filters.tag ? filtered.length : count,
    };
  }

  private static async commentCounts(taskIds: string[]): Promise<Map<string, number>> {
    if (taskIds.length === 0) return new Map();
    const rows = (await AgentTaskComment.findAll({
      attributes: ['taskId', [AgentTaskComment.sequelize!.fn('COUNT', '*'), 'count']],
      where: { taskId: { [Op.in]: taskIds } },
      group: ['taskId'],
      raw: true,
    })) as unknown as Array<{ taskId: string; count: number | string }>;
    return new Map(rows.map((row) => [row.taskId, Number(row.count)]));
  }

  /** When a comment was really written: upstream time for pulled ones, local time otherwise. */
  private static commentTime(comment: AgentTaskComment): number {
    return new Date(comment.externalCreatedAt ?? comment.createdAt).getTime();
  }

  /** Task + its runs, stages, logs and the full comment thread — one payload for the detail pane. */
  static async details(taskId: string): Promise<Record<string, unknown>> {
    const task = await AgentTask.findByPk(taskId);
    if (!task) throw new TaskServiceError(404, 'Task not found');

    const [project, runs, comments, source] = await Promise.all([
      AgentProject.findByPk(task.projectId),
      AgentRun.findAll({ where: { taskId }, order: [['createdAt', 'DESC']], limit: 50 }),
      AgentTaskComment.findAll({ where: { taskId } }),
      task.sourceId ? AgentTaskSource.findByPk(task.sourceId) : Promise.resolve(null),
    ]);

    const latestRun = runs[0] ?? null;
    const [stages, logs] = latestRun
      ? await Promise.all([
          AgentStageExecution.findAll({ where: { runId: latestRun.id }, order: [['stageIndex', 'ASC']] }),
          AgentRunLog.findAll({ where: { runId: latestRun.id }, order: [['createdAt', 'ASC']], limit: 300 }),
        ])
      : [[], []];

    return {
      task: {
        ...task.toJSON(),
        sourceTitle: taskManagerTitle(task.sourceType),
        sourceAvailable: isTaskSourceAvailable(task.sourceType),
        remoteExternalId: TaskSourceSyncService.remoteExternalId(task),
        canPullComments: this.canPullComments(task),
      },
      project: project ? { id: project.id, name: project.name, slug: project.slug } : null,
      source: source ? { id: source.id, name: source.name, type: source.type, isActive: source.isActive } : null,
      runs: runs.map((run) => run.toJSON()),
      latestRun: latestRun
        ? {
            run: latestRun.toJSON(),
            stages: stages.map((stage) => stage.toJSON()),
            logs: logs.map((log) => log.toJSON()),
          }
        : null,
      // Sorted here rather than in SQL: the key is "upstream time, falling back to local time",
      // and COALESCE over quoted identifiers is a portability trap between SQLite and Postgres.
      // A single task's thread is small enough that this costs nothing.
      comments: [...comments]
        .sort((a, b) => this.commentTime(a) - this.commentTime(b))
        .map((comment) => comment.toJSON()),
    };
  }

  /**
   * Manual edits from the tracker UI. Status changes are refused while a run owns the task —
   * flipping it to `done` mid-run would make the pipeline's own final write look like a
   * regression, and the run would overwrite the edit anyway.
   */
  static async update(
    taskId: string,
    patch: {
      status?: string;
      priority?: string;
      assigneeId?: number | null;
      title?: string;
      description?: string;
      tags?: string[];
    },
    actor: { id: number | null; name: string },
  ): Promise<Record<string, unknown>> {
    const task = await AgentTask.findByPk(taskId);
    if (!task) throw new TaskServiceError(404, 'Task not found');

    const changes: string[] = [];
    const update: Record<string, unknown> = {};

    if (patch.status !== undefined && patch.status !== task.status) {
      if (!TASK_STATUSES.includes(patch.status as AgentTaskStatus)) {
        throw new TaskServiceError(400, `Unknown status "${patch.status}"`);
      }
      if (PIPELINE_OWNED.has(task.status)) {
        throw new TaskServiceError(
          409,
          `Task is ${task.status}: cancel the run before changing the status by hand`,
        );
      }
      update.status = patch.status;
      changes.push(`статус: ${task.status} → ${patch.status}`);
    }

    if (patch.priority !== undefined && patch.priority !== task.priority) {
      if (!TASK_PRIORITIES.includes(patch.priority as AgentTaskPriority)) {
        throw new TaskServiceError(400, `Unknown priority "${patch.priority}"`);
      }
      update.priority = patch.priority;
      changes.push(`приоритет: ${task.priority} → ${patch.priority}`);
    }

    if (patch.assigneeId !== undefined && patch.assigneeId !== task.assigneeId) {
      update.assigneeId = patch.assigneeId;
      changes.push(patch.assigneeId ? `исполнитель: #${patch.assigneeId}` : 'исполнитель снят');
    }

    if (patch.title !== undefined && patch.title !== task.title) {
      if (!patch.title.trim()) throw new TaskServiceError(400, 'Title cannot be empty');
      update.title = patch.title;
      changes.push('изменён заголовок');
    }

    if (patch.description !== undefined && patch.description !== task.description) {
      update.description = patch.description;
      changes.push('изменено описание');
    }

    if (patch.tags !== undefined) {
      update.tags = patch.tags;
      changes.push(`теги: ${patch.tags.join(', ') || '—'}`);
    }

    if (Object.keys(update).length === 0) {
      return task.toJSON();
    }

    await task.update(update);
    // Every manual change leaves a trace in the thread: without it a status that moved on its own
    // is indistinguishable from one a person changed.
    await this.addComment(taskId, {
      authorKind: 'system',
      authorName: actor.name,
      authorId: actor.id,
      body: changes.join('\n'),
      meta: { kind: 'task.updated', changes },
    });

    return task.toJSON();
  }

  static async create(
    input: { projectId: string; title: string; description?: string; tags?: string[]; priority?: string },
    actor: { id: number | null; name: string },
  ): Promise<Record<string, unknown>> {
    if (!input.projectId) throw new TaskServiceError(400, 'projectId is required');
    if (!input.title?.trim()) throw new TaskServiceError(400, 'title is required');
    const project = await AgentProject.findByPk(input.projectId);
    if (!project) throw new TaskServiceError(404, 'Project not found');

    const task = await AgentTask.create({
      projectId: input.projectId,
      // Locally created tasks still need a unique externalId; `local:` marks the origin clearly.
      externalId: `local:${Date.now().toString(36)}`,
      externalUrl: null,
      title: input.title.trim(),
      description: input.description ?? null,
      tags: input.tags ?? [],
      externalStatus: null,
      status: 'new',
      priority: (input.priority as AgentTaskPriority) ?? 'normal',
      sourceId: null,
      sourceType: LOCAL_TASK_SOURCE_TYPE,
      sourceName: 'Agentiz',
      raw: null,
      lastSyncedAt: null,
    });

    await this.addComment(task.id, {
      authorKind: 'system',
      authorName: actor.name,
      authorId: actor.id,
      body: 'Задача создана вручную в Agentiz',
      meta: { kind: 'task.created' },
    });

    return task.toJSON();
  }

  /**
   * Appends to the thread. `agent` comments come from pipeline runs (see AgentPipelineService),
   * `human` from the UI, `system` from lifecycle events.
   */
  static async addComment(
    taskId: string,
    input: {
      authorKind: AgentTaskCommentAuthorKind;
      authorName?: string | null;
      authorId?: number | null;
      runId?: string | null;
      body: string;
      meta?: Record<string, unknown> | null;
    },
  ): Promise<Record<string, unknown>> {
    if (!input.body?.trim()) throw new TaskServiceError(400, 'Comment body is required');
    const task = await AgentTask.findByPk(taskId);
    if (!task) throw new TaskServiceError(404, 'Task not found');

    const comment = await AgentTaskComment.create({
      taskId,
      authorKind: input.authorKind,
      authorName: input.authorName ?? (input.authorKind === 'system' ? 'system' : null),
      authorId: input.authorId ?? null,
      runId: input.runId ?? null,
      body: input.body,
      origin: 'local',
      externalId: null,
      externalUrl: null,
      externalCreatedAt: null,
      meta: input.meta ?? null,
    });
    const run = input.authorKind === 'human'
      ? await AgentPipelineService.runForHumanComment(taskId, comment.id)
      : null;
    return { ...comment.toJSON(), triggeredRunId: run?.id ?? null };
  }

  static async deleteComment(commentId: string): Promise<void> {
    const comment = await AgentTaskComment.findByPk(commentId);
    if (!comment) throw new TaskServiceError(404, 'Comment not found');
    await comment.destroy();
  }

  /**
   * The two comment-capable connectors — a generic task manager and a git provider — expose the
   * same two methods, so callers that only comment do not care which one they got.
   */
  private static async commentConnectorFor(task: AgentTask): Promise<{
    commentOnTask(externalId: string, body: string): Promise<CommentResult>;
    listComments(externalId: string): Promise<NormalizedExternalComment[]>;
  }> {
    if (task.sourceId) {
      const source = await AgentTaskSource.findByPk(task.sourceId);
      if (!source) throw new TaskServiceError(404, 'Task source not found');
      return createTaskManager(source.type, source.config ?? {}, source.secrets ?? {});
    }
    // Tasks mirrored by GitSyncService or an integration layer still route through the git side.
    const project = await AgentProject.findByPk(task.projectId);
    if (!project) throw new TaskServiceError(404, 'Project not found');
    return createGitProviderForTask(task, project);
  }

  /** A task created in Agentiz has no upstream thread to talk to. */
  private static assertHasUpstream(task: AgentTask): void {
    if (!task.sourceType || task.sourceType === LOCAL_TASK_SOURCE_TYPE) {
      throw new TaskServiceError(400, 'Задача создана в Agentiz, у неё нет внешнего трекера');
    }
  }

  /**
   * Mirrors a local comment to the system the task came from.
   *
   * Deliberately explicit rather than automatic on every comment: an internal note about a
   * customer is not something to push to a public issue tracker by accident.
   */
  static async pushCommentUpstream(commentId: string): Promise<Record<string, unknown>> {
    const comment = await AgentTaskComment.findByPk(commentId);
    if (!comment) throw new TaskServiceError(404, 'Comment not found');
    if (comment.externalUrl) throw new TaskServiceError(409, 'Comment has already been published upstream');
    if (comment.origin === 'remote') {
      throw new TaskServiceError(409, 'Comment came from the tracker, there is nothing to push back');
    }

    const task = await AgentTask.findByPk(comment.taskId);
    if (!task) throw new TaskServiceError(404, 'Task not found');
    this.assertHasUpstream(task);

    const connector = await this.commentConnectorFor(task);
    const result = await connector.commentOnTask(TaskSourceSyncService.remoteExternalId(task), comment.body);

    // externalId is the platform's own comment id, not the url: the next pull matches on it to
    // recognise this comment as one we already have. Storing the url here (as an earlier version
    // did) meant our own comment came back as a duplicate.
    await comment.update({ externalId: result.id, externalUrl: result.url });
    return comment.toJSON();
  }

  /**
   * Pulls the task's discussion from its tracker into the local thread.
   *
   * Idempotent by design — it is called on demand from the UI and after every sync that touched
   * the task, so it must converge rather than accumulate. Matching is on
   * `(taskId, externalId)`, which also covers comments Agentiz posted upstream itself: those
   * already carry the remote id, so they are updated in place instead of duplicated.
   */
  static async pullComments(taskId: string): Promise<{ fetched: number; created: number; updated: number }> {
    const task = await AgentTask.findByPk(taskId);
    if (!task) throw new TaskServiceError(404, 'Task not found');
    this.assertHasUpstream(task);

    const connector = await this.commentConnectorFor(task);
    const remote = await connector.listComments(TaskSourceSyncService.remoteExternalId(task));

    let created = 0;
    let updated = 0;

    for (const item of remote) {
      const existing = await AgentTaskComment.findOne({
        where: { taskId, externalId: item.externalId },
      });

      const externalCreatedAt = item.createdAt ? new Date(item.createdAt) : null;

      if (!existing) {
        const comment = await AgentTaskComment.create({
          taskId,
          // Whoever wrote it upstream is a person as far as we can tell; the tracker does not
          // tell us whether it was a bot, and guessing from the name would be worse than not.
          authorKind: 'human',
          authorName: item.authorName,
          authorId: null,
          runId: null,
          body: item.body,
          origin: 'remote',
          externalId: item.externalId,
          externalUrl: item.externalUrl,
          externalCreatedAt,
          meta: { kind: 'comment.pulled', sourceType: task.sourceType },
        });
        await AgentPipelineService.runForHumanComment(taskId, comment.id);
        created += 1;
        continue;
      }

      // An edit upstream should show through; a comment of ours coming back only gains its url
      // and timestamp. `origin` is never downgraded from local to remote — we did write it.
      const patch: Record<string, unknown> = {};
      if (existing.origin === 'remote' && existing.body !== item.body) patch.body = item.body;
      if (!existing.externalUrl && item.externalUrl) patch.externalUrl = item.externalUrl;
      if (!existing.externalCreatedAt && externalCreatedAt) patch.externalCreatedAt = externalCreatedAt;
      if (existing.origin === 'remote' && item.authorName && existing.authorName !== item.authorName) {
        patch.authorName = item.authorName;
      }
      if (Object.keys(patch).length > 0) {
        await existing.update(patch);
        updated += 1;
      }
    }

    return { fetched: remote.length, created, updated };
  }

  /** True when the task's origin can hand us its discussion. Drives the UI button. */
  static canPullComments(task: AgentTask): boolean {
    if (!task.sourceType || task.sourceType === LOCAL_TASK_SOURCE_TYPE) return false;
    const adapter = getTaskManagerAdapter(task.sourceType);
    // No adapter means the task came from the project's own repo or an integration layer, which
    // both go through a GitProvider — and both shipped providers can read comments.
    return adapter ? Boolean(adapter.supportsComments) : true;
  }
}
