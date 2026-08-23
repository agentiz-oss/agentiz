import { AgentProject } from '../../app-agentiz/models/AgentProject';
import { AgentRun } from '../../app-agentiz/models/AgentRun';
import { AgentRunDiff } from '../../app-agentiz/models/AgentRunDiff';
import { AgentRunJob } from '../../app-agentiz/models/AgentRunJob';
import { listRunLogs, type RunLogQuery } from '../../app-agentiz/lib/runLogs';
import { runUsage } from '../../app-agentiz/lib/runUsage';
import { AgentWorkspaceProposal } from '../../app-agentiz/models/AgentWorkspaceProposal';
import { AgentStageExecution } from '../../app-agentiz/models/AgentStageExecution';
import { AgentTask } from '../../app-agentiz/models/AgentTask';
import { AgentTaskAttachment } from '../../app-agentiz/models/AgentTaskAttachment';
import { AgentTaskComment } from '../../app-agentiz/models/AgentTaskComment';
import { AgentPipelineService } from '../../app-agentiz/services/AgentPipelineService';
import { AgentTaskService } from '../../app-agentiz/services/AgentTaskService';
import { normalizeRunOverride } from '../../app-agentiz/lib/harnessCatalog';
import { buildRunOptions } from '../../app-agentiz/lib/runOptions';
import {
  attachmentDiskPath,
  deleteAttachment,
  listTaskAttachments,
  storeAttachment,
} from '../../app-agentiz/lib/taskAttachments';
import { MobileActivityService } from './MobileActivityService';
import { MobileAuthError } from './MobileAuthService';
import { MobileInteractionService } from './MobileInteractionService';

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
  /**
   * Resolves a task the caller is allowed to see together with the project that granted the
   * access, or throws 404. The project has to be read to answer "is this yours" at all, so a
   * caller that also wants to *name* it costs nothing extra.
   */
  private static async ownedTaskWithProject(
    taskId: string,
    ownerId: number | string,
  ): Promise<{ task: AgentTask; project: AgentProject }> {
    const task = await AgentTask.findByPk(taskId);
    if (!task) throw new MobileAuthError(404, 'Task not found');
    const project = await AgentProject.findByPk(task.projectId);
    if (!project || String(project.ownerId ?? '') !== String(ownerId)) {
      throw new MobileAuthError(404, 'Task not found');
    }
    return { task, project };
  }

  /** Resolves a task the caller is allowed to see, or throws 404. */
  private static async ownedTask(taskId: string, ownerId: number | string): Promise<AgentTask> {
    return (await this.ownedTaskWithProject(taskId, ownerId)).task;
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
      // Token spend accumulated across attempts; null until a worker result reports usage.
      usage: runUsage(run),
    };
  }

  /**
   * The diff the run screen shows — the row the dashboard also picks (`proposal ? latestDiff :
   * diff` in AgentizRunDetail): for a workspace run the proposal's latest revision supersedes the
   * run's own row, because a later "continue" run may have amended the change this run started.
   * Resolved server-side so the response carries one `diff` field either way.
   *
   * Shaped down to what a phone renders. `ops`, `patchSha256` and `treeSha` stay behind: the
   * mobile client applies nothing, so the operations are dead weight next to a patch that is
   * already capped by AGENTIZ_MAX_PATCH_BYTES at write time.
   */
  private static async displayedDiff(run: AgentRun) {
    let row: AgentRunDiff | null = null;
    if (run.proposalId) {
      const proposal = await AgentWorkspaceProposal.findByPk(run.proposalId);
      if (proposal?.latestDiffId) row = await AgentRunDiff.findByPk(proposal.latestDiffId);
    }
    row ??= await AgentRunDiff.findOne({ where: { runId: run.id } });
    if (!row) return null;
    return {
      patch: row.patch,
      truncated: row.truncated,
      stats: row.stats,
      baseSha: row.baseSha,
      appliedAt: row.appliedAt,
      appliedCommitSha: row.appliedCommitSha,
    };
  }

  /**
   * What the run was actually asked to do.
   *
   * A run's page used to show only the task's *title*, which for a task started from a one-word
   * comment ("выполни") says nothing at all — the instruction the agent received lives either in
   * the comment the run was triggered from (`AgentRun.triggerCommentId`, the same one
   * `AgentPipelineService.conversationForRun` puts last in the prompt as the current instruction)
   * or, with no such comment, in the task's description. Resolved here rather than on the client so
   * both cases arrive as one field with its origin named.
   */
  private static async runInstruction(run: AgentRun, task?: AgentTask | null): Promise<{
    source: 'comment' | 'description';
    body: string;
    authorName: string | null;
    createdAt: Date | null;
  } | null> {
    if (run.triggerCommentId) {
      const comment = await AgentTaskComment.findByPk(run.triggerCommentId);
      if (comment && comment.body.trim().length > 0) {
        return {
          source: 'comment' as const,
          body: comment.body,
          authorName: comment.authorName,
          createdAt: comment.externalCreatedAt ?? comment.createdAt,
        };
      }
    }
    const owner = task ?? await AgentTask.findByPk(run.taskId);
    const description = owner?.description?.trim();
    if (!description) return null;
    return { source: 'description' as const, body: description, authorName: null, createdAt: owner?.createdAt ?? null };
  }

  /**
   * [withDiff] is false for the copy of the latest run embedded in a task's detail: only the run
   * screen renders the patch, and it always loads the run through its own endpoint. Sending it
   * with the task instead would put up to AGENTIZ_MAX_PATCH_BYTES (5 MB by default) on the wire —
   * and into the task's cache entry — every time somebody opens a task, to render nothing.
   */
  private static async runDetail(run: AgentRun, withDiff = true, logQuery: RunLogQuery = {}, task?: AgentTask | null) {
    const [stages, logs, job, interactions, diff, instruction] = await Promise.all([
      AgentStageExecution.findAll({ where: { runId: run.id }, order: [['stageIndex', 'ASC']] }),
      // The tail, not the first page: a run streaming its tool calls outgrows any fixed limit, and
      // the phone screen is opened to see what the agent is doing *now*. `logsCursor` lets a client
      // poll for the delta; one that ignores it still gets a correct, if whole, tail every time.
      listRunLogs(run.id, { limit: 500, ...logQuery }),
      // A run has one durable queue job. Its `result` is the exact terminal payload accepted
      // from the worker; AgentRun intentionally keeps only the small human summary.
      AgentRunJob.findOne({ where: { runId: run.id }, order: [['createdAt', 'DESC']] }),
      // A run in `waiting_input` is blocked on one of these until somebody answers it, so a run's
      // record is incomplete without them — answered ones stay as the history of what was asked.
      MobileInteractionService.forRun(run.id),
      withDiff ? this.displayedDiff(run) : null,
      this.runInstruction(run, task),
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
      logs: logs.logs.map((log) => ({
        level: log.level,
        message: log.message,
        stageRole: log.stageExecutionId ? stageRoleByExecutionId.get(log.stageExecutionId) ?? null : null,
        createdAt: log.createdAt,
      })),
      logsCursor: logs.nextCursor,
      logsEarlierCursor: logs.earlierCursor,
      logsHasEarlier: logs.hasEarlier,
      logsHasMore: logs.hasMore,
      workerResult: job?.result ?? null,
      interactions,
      diff,
      instruction,
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
    const { task, project } = await this.ownedTaskWithProject(taskId, ownerId);

    const [runs, comments, pendingInteractions, attachments, actionRequired] = await Promise.all([
      AgentRun.findAll({ where: { taskId }, order: [['createdAt', 'DESC']], limit: 20 }),
      AgentTaskComment.findAll({ where: { taskId } }),
      MobileInteractionService.pendingForTask(taskId),
      listTaskAttachments(taskId),
      // The owner id *is* the caller's user id in this API (see MobileAuthService), and the inbox
      // hides what they have dismissed — here too, or a waved-away row would come back one screen
      // deeper.
      MobileActivityService.itemsForTask(task, project, Number(ownerId)),
    ]);

    const latestRun = runs[0] ?? null;

    return {
      task: {
        ...this.listRow(task),
        description: task.description,
        runCount: runs.length,
      },
      latestRun: latestRun ? await this.runDetail(latestRun, false, {}, task) : null,
      /**
       * What this task is waiting on *from a person*, in the same shape the inbox renders: a
       * question, a review, a failed push, a held diff. The task screen used to state only its
       * status, so "ждёт ревью" was something a reader had to deduce from a run's page.
       */
      actionRequired,
      // Surfaced at task level too: a question can belong to a run the task screen is not showing
      // in full, and a blocked run must not be something the reader has to go hunting for.
      pendingInteractions,
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
      attachments: attachments.map((attachment) => this.attachmentRow(attachment)),
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
  static async run(taskId: string, ownerId: number | string, choice?: unknown) {
    await this.ownedTask(taskId, ownerId);
    let override;
    try {
      override = normalizeRunOverride(choice as Record<string, unknown> | null | undefined);
    } catch (error) {
      // A bad pick is the caller's mistake, not a server fault: without this it would surface as a
      // 500 with the same text.
      throw new MobileAuthError(400, error instanceof Error ? error.message : String(error));
    }
    const run = await AgentPipelineService.runTask(taskId, 'manual', { executorOverride: override });
    return { id: run.id, status: run.status };
  }

  /**
   * What this task's launch dialog may offer. Scoped through the task like every other mobile
   * endpoint, so a foreign id answers 404 rather than leaking a project's workers.
   */
  static async runOptions(taskId: string, ownerId: number | string) {
    const task = await this.ownedTask(taskId, ownerId);
    return buildRunOptions(task);
  }

  /** All attempts for a task. Results stay small enough to render as a phone-friendly history. */
  static async runs(taskId: string, ownerId: number | string) {
    await this.ownedTask(taskId, ownerId);
    const runs = await AgentRun.findAll({ where: { taskId }, order: [['createdAt', 'DESC']], limit: 100 });
    return runs.map((run) => this.runRow(run));
  }

  /**
   * One attempt including stage results and its process trace.
   *
   * Unlike the copy embedded in a task's detail, this one names the task and project it belongs
   * to: a run opened from the board, the activity feed or a notification arrives with nothing but
   * two ids, and the screen has to be able to say *whose* run this is and offer the way into it.
   * Both rows are already loaded to authorise the call, so the context is free.
   */
  static async runDetailForTask(taskId: string, runId: string, ownerId: number | string, logQuery: RunLogQuery = {}) {
    const { task, project } = await this.ownedTaskWithProject(taskId, ownerId);
    const run = await AgentRun.findOne({ where: { id: runId, taskId } });
    if (!run) throw new MobileAuthError(404, 'Run not found');
    return {
      ...(await this.runDetail(run, true, logQuery, task)),
      taskId: task.id,
      taskTitle: task.title,
      projectId: project.id,
      projectName: project.name,
      /**
       * What this run wants from a person, in the same shape the inbox renders — printed at the
       * very top of the run screen, above the result.
       *
       * A run that stopped on something a human has to settle used to say so only by its status
       * word and, further down the page, by a review block a reader had to recognise. The list the
       * inbox is built from already knows the answer *and* the words for it, so the run screen asks
       * it instead of restating the state machine in Kotlin.
       */
      actionRequired: await MobileActivityService.itemsForRun(run, task, project, Number(ownerId)),
    };
  }

  /**
   * Applies a diff `requireApproval` held back — the same call the panel's button makes.
   *
   * Without it the phone could only *show* a held diff and send the reader to a laptop, which is
   * exactly the dead end the inbox is supposed to not have. The rules (a diff applies once,
   * workspace diffs go through their proposal instead) live in `applyStoredDiff`; here they only
   * get translated into a status code the app can act on.
   */
  static async applyDiff(
    taskId: string,
    runId: string,
    ownerId: number | string,
    actor: { id: number | null; name: string },
  ) {
    await this.ownedTask(taskId, ownerId);
    const run = await AgentRun.findOne({ where: { id: runId, taskId } });
    if (!run) throw new MobileAuthError(404, 'Run not found');
    try {
      const diff = await AgentPipelineService.applyStoredDiff(run.id, actor.id !== null ? `user:${actor.id} (${actor.name})` : actor.name);
      return { applied: true, diffId: diff.id, appliedCommitSha: diff.appliedCommitSha ?? null };
    } catch (error) {
      // Everything this can refuse is a conflict about the diff's state, not a server fault: it was
      // applied already, it holds no operations, it belongs to a workspace proposal.
      throw new MobileAuthError(409, error instanceof Error ? error.message : String(error));
    }
  }

  /** Cancellation is scoped through the task, so a known run id cannot cross project boundaries. */
  static async cancelRun(taskId: string, runId: string, ownerId: number | string) {
    await this.ownedTask(taskId, ownerId);
    const run = await AgentRun.findOne({ where: { id: runId, taskId } });
    if (!run) throw new MobileAuthError(404, 'Run not found');
    await AgentPipelineService.cancelRun(run.id, 'Cancelled from mobile app');
    return this.runDetailForTask(taskId, runId, ownerId);
  }

  /** The wire shape of one attachment; the app builds its download URL from the id. */
  private static attachmentRow(attachment: AgentTaskAttachment) {
    return {
      id: attachment.id,
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      uploadedByName: attachment.uploadedByName,
      createdAt: attachment.createdAt,
    };
  }

  static async listAttachments(taskId: string, ownerId: number | string) {
    await this.ownedTask(taskId, ownerId);
    return (await listTaskAttachments(taskId)).map((attachment) => this.attachmentRow(attachment));
  }

  /**
   * Stores an uploaded file on the task. The same storage helper the admin panel writes through,
   * so an attachment is one thing wherever it came from — the run snapshot and the worker download
   * cannot tell (and must not care) which surface added it.
   */
  static async addAttachment(
    taskId: string,
    ownerId: number | string,
    input: { fileName: string; mimeType: string | null; content: Buffer },
    actor: { id: number | null; name: string },
  ) {
    await this.ownedTask(taskId, ownerId);
    const attachment = await storeAttachment({
      taskId,
      fileName: input.fileName,
      mimeType: input.mimeType,
      content: input.content,
      uploadedById: actor.id,
      uploadedByName: actor.name,
    });
    // The thread records the upload exactly like the dashboard does — and through the frozen
    // conversation this line is also how a later run learns a file appeared mid-thread.
    await AgentTaskService.addComment(taskId, {
      authorKind: 'system',
      authorName: actor.name,
      authorId: actor.id,
      body: `Прикреплён файл «${attachment.fileName}» (${attachment.sizeBytes} байт)`,
      meta: { kind: 'attachment.added', attachmentId: attachment.id, via: 'mobile' },
    });
    return this.attachmentRow(attachment);
  }

  /**
   * One attachment's bytes, scoped through the task like every run endpoint — a known attachment
   * id must not cross project boundaries, and a foreign one reads as 404, never 403.
   */
  static async attachmentFile(taskId: string, attachmentId: string, ownerId: number | string) {
    await this.ownedTask(taskId, ownerId);
    const attachment = await AgentTaskAttachment.findOne({ where: { id: attachmentId, taskId } });
    if (!attachment) throw new MobileAuthError(404, 'Attachment not found');
    return {
      diskPath: attachmentDiskPath(attachment),
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
    };
  }

  static async removeAttachment(
    taskId: string,
    attachmentId: string,
    ownerId: number | string,
    actor: { id: number | null; name: string },
  ) {
    await this.ownedTask(taskId, ownerId);
    const attachment = await AgentTaskAttachment.findOne({ where: { id: attachmentId, taskId } });
    if (!attachment) throw new MobileAuthError(404, 'Attachment not found');
    const fileName = attachment.fileName;
    await deleteAttachment(attachment);
    await AgentTaskService.addComment(taskId, {
      authorKind: 'system',
      authorName: actor.name,
      authorId: actor.id,
      body: `Удалён файл «${fileName}»`,
      meta: { kind: 'attachment.deleted', attachmentId, via: 'mobile' },
    });
    return { deleted: true };
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
