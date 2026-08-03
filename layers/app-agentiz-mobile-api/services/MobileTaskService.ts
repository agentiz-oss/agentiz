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

  private static async runDetail(run: AgentRun) {
    const [stages, logs, job] = await Promise.all([
      AgentStageExecution.findAll({ where: { runId: run.id }, order: [['stageIndex', 'ASC']] }),
      AgentRunLog.findAll({ where: { runId: run.id }, order: [['createdAt', 'ASC']], limit: 500 }),
      // A run has one durable queue job. Its `result` is the exact terminal payload accepted
      // from the worker; AgentRun intentionally keeps only the small human summary.
      AgentRunJob.findOne({ where: { runId: run.id }, order: [['createdAt', 'DESC']] }),
    ]);
    const stageRoleByExecutionId = new Map(stages.map((stage) => [stage.id, stage.role]));
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
   */
  static async detail(taskId: string, ownerId: number | string) {
    const task = await this.ownedTask(taskId, ownerId);

    const [runs, comments] = await Promise.all([
      AgentRun.findAll({ where: { taskId }, order: [['createdAt', 'DESC']], limit: 20 }),
      AgentTaskComment.findAll({ where: { taskId } }),
    ]);

    const latestRun = runs[0] ?? null;

    return {
      task: {
        ...this.listRow(task),
        description: task.description,
        runCount: runs.length,
      },
      latestRun: latestRun ? await this.runDetail(latestRun) : null,
      // Same ordering rule as the dashboard: upstream timestamp when the comment came from a
      // tracker, local creation time otherwise.
      comments: [...comments]
        .sort((a, b) => this.commentTime(a) - this.commentTime(b))
        .map((comment) => ({
          id: comment.id,
          authorKind: comment.authorKind,
          authorName: comment.authorName,
          body: comment.body,
          runId: comment.runId,
          createdAt: comment.externalCreatedAt ?? comment.createdAt,
        })),
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

  /** One attempt including stage results and its process trace. */
  static async runDetailForTask(taskId: string, runId: string, ownerId: number | string) {
    await this.ownedTask(taskId, ownerId);
    const run = await AgentRun.findOne({ where: { id: runId, taskId } });
    if (!run) throw new MobileAuthError(404, 'Run not found');
    return this.runDetail(run);
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
