import { Op } from 'sequelize';
import { AgentProject } from '../../app-agentiz/models/AgentProject';
import { AgentRun } from '../../app-agentiz/models/AgentRun';
import { AgentRunJob } from '../../app-agentiz/models/AgentRunJob';
import { AgentRunLog } from '../../app-agentiz/models/AgentRunLog';
import { AgentStageExecution } from '../../app-agentiz/models/AgentStageExecution';
import { AgentTask } from '../../app-agentiz/models/AgentTask';
import { AgentTaskComment } from '../../app-agentiz/models/AgentTaskComment';
import { AgentPipelineService } from '../../app-agentiz/services/AgentPipelineService';
import { AgentTaskService } from '../../app-agentiz/services/AgentTaskService';
import { MobileAuthError } from './MobileAuthService';

/**
 * A `(time, id)` pair opaquely encoded as `"<ISO timestamp>_<id>"`. Comments and log lines are
 * both effectively append-only streams a poll loop re-reads every couple of seconds; a cursor
 * lets the caller ask for what was written after the last row it already has instead of the
 * whole stream every time. Time alone is not a safe cursor — two rows can share a millisecond —
 * so the id breaks the tie the same way the matching `ORDER BY` does.
 */
interface StreamCursor {
  time: Date;
  id: string;
}

function encodeCursor(time: Date, id: string): string {
  return `${time.toISOString()}_${id}`;
}

function decodeCursor(raw: string | undefined): StreamCursor | null {
  if (!raw) return null;
  const separatorIndex = raw.indexOf('_');
  if (separatorIndex < 0) return null;
  const time = new Date(raw.slice(0, separatorIndex));
  const id = raw.slice(separatorIndex + 1);
  if (Number.isNaN(time.getTime()) || !id) return null;
  return { time, id };
}

/** Sequelize `WHERE` fragment for "rows strictly after this cursor", given the row's time column. */
function afterCursor(cursor: StreamCursor, timeField: string) {
  return {
    [Op.or]: [
      { [timeField]: { [Op.gt]: cursor.time } },
      { [timeField]: cursor.time, id: { [Op.gt]: cursor.id } },
    ],
  };
}

/**
 * Task access for the mobile client: the built-in tracker reduced to what a phone-sized screen
 * needs — a task list per project, one task with the outcome of its latest run, and the comment
 * thread.
 *
 * Every method takes the caller's `ownerId` and resolves the task through its project, mirroring
 * the ownership rule `MobileProjectService` applies. A task belonging to someone else's project is
 * reported as "not found" rather than "forbidden", so the API never confirms that an id exists.
 *
 * The admin panel's `AgentTaskService` stays the single writer: this service shapes payloads and
 * enforces scope, but creating tasks and appending comments goes through the same code path the
 * dashboard uses, so both surfaces produce identical rows.
 */
export class MobileTaskService {
  /** Resolves a task the caller is allowed to see, or throws 404. */
  private static async ownedTask(taskId: string, ownerId: number | string): Promise<AgentTask> {
    const task = await AgentTask.findByPk(taskId);
    if (!task) throw new MobileAuthError(404, 'Task not found');
    const project = await AgentProject.findByPk(task.projectId);
    if (!project || String(project.ownerId ?? '') !== String(ownerId)) {
      throw new MobileAuthError(404, 'Task not found');
    }
    return task;
  }

  private static async ownedProject(projectId: string, ownerId: number | string): Promise<AgentProject> {
    const project = await AgentProject.findByPk(projectId);
    if (!project || String(project.ownerId ?? '') !== String(ownerId)) {
      throw new MobileAuthError(404, 'Project not found');
    }
    return project;
  }

  /** List rows are deliberately thin — the detail call carries runs, stages and the thread. */
  private static listRow(task: AgentTask) {
    return {
      id: task.id,
      title: task.title,
      status: task.status,
      priority: task.priority,
      tags: task.tags ?? [],
      externalId: task.externalId,
      createdAt: task.createdAt,
    };
  }

  /** A history row is deliberately compact; traces are loaded only after the user opens a run. */
  private static runRow(run: AgentRun) {
    return {
      id: run.id,
      status: run.status,
      trigger: run.trigger,
      resultSummary: run.resultSummary,
      errorMessage: run.errorMessage,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
    };
  }

  /**
   * `logsAfter` is an opaque cursor from a previous response's `logsCursor`: pass it back to get
   * only the lines written since, instead of the whole trace again on every poll tick. Status,
   * stages and the worker result are small and always returned in full so the caller can still
   * tell a run finished even if it fetches logs incrementally.
   */
  private static async runDetail(run: AgentRun, options: { logsAfter?: string } = {}) {
    const cursor = decodeCursor(options.logsAfter);
    const [stages, logs, job] = await Promise.all([
      AgentStageExecution.findAll({ where: { runId: run.id }, order: [['stageIndex', 'ASC']] }),
      AgentRunLog.findAll({
        where: {
          runId: run.id,
          ...(cursor ? afterCursor(cursor, 'createdAt') : {}),
        },
        order: [['createdAt', 'ASC'], ['id', 'ASC']],
        // Only the first page needs a cap; a delta fetch on a 2s poll is never this large.
        limit: cursor ? undefined : 500,
      }),
      // A run has one durable queue job. Its `result` is the exact terminal payload accepted
      // from the worker; AgentRun intentionally keeps only the small human summary.
      AgentRunJob.findOne({ where: { runId: run.id }, order: [['createdAt', 'DESC']] }),
    ]);
    const stageRoleByExecutionId = new Map(stages.map((stage) => [stage.id, stage.role]));
    const lastLog = logs[logs.length - 1];
    return {
      ...this.runRow(run),
      stages: stages.map((stage) => ({
        role: stage.role,
        status: stage.status,
        summary: (stage.output as any)?.summary ?? null,
        // Do not collapse the worker response to a summary. The app uses agentResponse as the
        // readable conclusion and retains the rest as inspectable structured diagnostics.
        output: stage.output ?? null,
        errorMessage: stage.errorMessage,
      })),
      logs: logs.map((log) => ({
        level: log.level,
        message: log.message,
        stageRole: log.stageExecutionId ? stageRoleByExecutionId.get(log.stageExecutionId) ?? null : null,
        createdAt: log.createdAt,
      })),
      // Pass this back as `logsAfter` on the next call to fetch only what was written since.
      // Unset when nothing new came back, so a caller polling with a cursor keeps reusing its own.
      logsCursor: lastLog ? encodeCursor(lastLog.createdAt as unknown as Date, lastLog.id) : options.logsAfter ?? null,
      workerResult: job?.result ?? null,
    };
  }

  static async listForProject(projectId: string, ownerId: number | string) {
    await this.ownedProject(projectId, ownerId);
    const tasks = await AgentTask.findAll({
      where: { projectId },
      order: [['createdAt', 'DESC']],
      limit: 200,
    });
    return tasks.map((task) => this.listRow(task));
  }

  static async create(
    projectId: string,
    ownerId: number | string,
    input: { title: string; description?: string | null; tags?: string[] },
    actor: { id: number | null; name: string },
  ) {
    await this.ownedProject(projectId, ownerId);
    const created = await AgentTaskService.create(
      {
        projectId,
        title: input.title,
        description: input.description ?? undefined,
        tags: input.tags ?? [],
      },
      actor,
    );
    const task = await AgentTask.findByPk(String((created as any).id));
    return task ? this.listRow(task) : created;
  }

  /**
   * A task plus the outcome of its most recent run. `resultSummary` is what the pipeline concluded;
   * the per-stage rows let the app show where a failed run stopped.
   *
   * `commentsAfter`/`logsAfter` are opaque cursors from a previous response's `commentsCursor`/
   * `latestRun.logsCursor`. A poll loop that already holds everything up to those cursors can pass
   * them back to get just what was added since, instead of the whole thread and trace again every
   * couple of seconds. Omitting them keeps the original full-payload behaviour.
   */
  static async detail(
    taskId: string,
    ownerId: number | string,
    options: { commentsAfter?: string; logsAfter?: string } = {},
  ) {
    const task = await this.ownedTask(taskId, ownerId);

    const [runs, comments] = await Promise.all([
      AgentRun.findAll({ where: { taskId }, order: [['createdAt', 'DESC']], limit: 20 }),
      AgentTaskComment.findAll({ where: { taskId } }),
    ]);

    const latestRun = runs[0] ?? null;

    // Same ordering rule as the dashboard: upstream timestamp when the comment came from a
    // tracker, local creation time otherwise.
    // `id` breaks ties between comments sharing a millisecond timestamp, matching the tiebreak the
    // cursor filter below uses — without it, two same-timestamp comments could land on either side
    // of a cursor depending on unrelated fetch order.
    const orderedComments = [...comments].sort((a, b) => {
      const byTime = this.commentTime(a) - this.commentTime(b);
      return byTime !== 0 ? byTime : (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    });
    const cursor = decodeCursor(options.commentsAfter);
    const visibleComments = cursor
      ? orderedComments.filter((comment) => {
        const time = new Date(this.commentTime(comment));
        return time > cursor.time || (time.getTime() === cursor.time.getTime() && comment.id > cursor.id);
      })
      : orderedComments;
    const lastComment = orderedComments[orderedComments.length - 1];

    return {
      task: {
        ...this.listRow(task),
        description: task.description,
        runCount: runs.length,
      },
      latestRun: latestRun ? await this.runDetail(latestRun, { logsAfter: options.logsAfter }) : null,
      comments: visibleComments.map((comment) => ({
        id: comment.id,
        authorKind: comment.authorKind,
        authorName: comment.authorName,
        body: comment.body,
        runId: comment.runId,
        createdAt: comment.externalCreatedAt ?? comment.createdAt,
      })),
      // Pass this back as `commentsAfter` next call to fetch only comments written since.
      commentsCursor: lastComment ? encodeCursor(new Date(this.commentTime(lastComment)), lastComment.id) : options.commentsAfter ?? null,
    };
  }

  private static commentTime(comment: AgentTaskComment): number {
    const at = comment.externalCreatedAt ?? comment.createdAt;
    return at ? new Date(at as any).getTime() : 0;
  }

  /**
   * Queues a pipeline run. Execution is out of band — `runTask` enqueues a durable worker job and
   * whichever worker is active (the in-process one by default) drains it — so the app polls the
   * detail endpoint rather than waiting on this call.
   */
  static async run(taskId: string, ownerId: number | string) {
    await this.ownedTask(taskId, ownerId);
    const run = await AgentPipelineService.runTask(taskId, 'manual');
    return { id: run.id, status: run.status };
  }

  /** All attempts for a task. Results stay small enough to render as a phone-friendly history. */
  static async runs(taskId: string, ownerId: number | string) {
    await this.ownedTask(taskId, ownerId);
    const runs = await AgentRun.findAll({ where: { taskId }, order: [['createdAt', 'DESC']], limit: 100 });
    return runs.map((run) => this.runRow(run));
  }

  /**
   * One attempt including stage results and its process trace. `logsAfter` is the same cursor
   * `runDetail` hands back as `logsCursor` — pass it to fetch only the log lines written since.
   */
  static async runDetailForTask(
    taskId: string,
    runId: string,
    ownerId: number | string,
    options: { logsAfter?: string } = {},
  ) {
    await this.ownedTask(taskId, ownerId);
    const run = await AgentRun.findOne({ where: { id: runId, taskId } });
    if (!run) throw new MobileAuthError(404, 'Run not found');
    return this.runDetail(run, options);
  }

  /** Cancellation is scoped through the task, so a known run id cannot cross project boundaries. */
  static async cancelRun(taskId: string, runId: string, ownerId: number | string) {
    await this.ownedTask(taskId, ownerId);
    const run = await AgentRun.findOne({ where: { id: runId, taskId } });
    if (!run) throw new MobileAuthError(404, 'Run not found');
    await AgentPipelineService.cancelRun(run.id, 'Cancelled from mobile app');
    return this.runDetailForTask(taskId, runId, ownerId);
  }

  static async addComment(
    taskId: string,
    ownerId: number | string,
    body: string,
    actor: { id: number | null; name: string },
  ) {
    await this.ownedTask(taskId, ownerId);
    const comment = await AgentTaskService.addComment(taskId, {
      authorKind: 'human',
      authorName: actor.name,
      authorId: actor.id,
      body,
    });
    return {
      id: (comment as any).id,
      authorKind: (comment as any).authorKind,
      authorName: (comment as any).authorName,
      body: (comment as any).body,
      runId: (comment as any).runId ?? null,
      createdAt: (comment as any).createdAt,
    };
  }
}
