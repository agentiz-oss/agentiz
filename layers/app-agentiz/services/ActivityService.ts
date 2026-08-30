import { AgentActivity } from '../models/AgentActivity';
import { AgentProject } from '../models/AgentProject';
import { AgentRun } from '../models/AgentRun';
import { AgentTask } from '../models/AgentTask';
import { dispatchActivity } from '../lib/activityNotifiers';
import type { ActivityEvent } from '../lib/activityNotifiers';
import { activityTypeDef } from '../lib/notifications/activityTypes';
import { effectiveActivityPolicy } from '../lib/notifications/policySettings';
import { recipientsForProject } from '../lib/access/projectAccess';

/** `title` is STRING(255); `body`/`data` errors are cut so a stack trace cannot bloat the feed. */
const MAX_TITLE = 250;
const MAX_BODY = 4000;

function truncate(text: string, limit: number): string {
  const clean = String(text ?? '').trim();
  return clean.length <= limit ? clean : `${clean.slice(0, limit - 1)}…`;
}

export interface RecordActivityInput {
  type: string;
  projectId: string;
  runId?: string | null;
  taskId?: string | null;
  proposalId?: string | null;
  interactionId?: string | null;
  title: string;
  body: string;
  data?: Record<string, unknown> | null;
  /**
   * Narrows the addressees to the people who hold this project token, instead of everybody with a
   * stake in the project.
   *
   * Absent (the default, and what every pre-existing emitter passes) means the whole project —
   * news is news for all of it. An **approval request** is the first event for which that is
   * wrong: it is a decision, only the holders of `agentiz-approval-decide` may make it, and
   * waking the rest is how a notification list stops being read. `recipientsForProject` always
   * includes the owner whatever the token says.
   */
  recipientToken?: string | null;
}

/**
 * The one dispatcher between "something happened" and everyone who may care.
 *
 * `record()` always writes the feed row first — the journal is complete whatever the notification
 * policy says — then resolves the policy once and fans out to the `activityNotifiers` collection,
 * skipping channels the policy turned off. The policy check lives *here*, not in the notifiers:
 * a notifier only declares its channel, so a new delivery layer physically cannot forget it.
 *
 * Fan-out is fire-and-forget (see dispatchActivity): several emitters sit on paths that must not
 * wait for — let alone fail because of — a push provider. `record` itself never throws either:
 * it is called from model hooks and result handlers whose own work must complete regardless, so a
 * broken feed degrades to a warning in the log, never to a failed run.
 */
export class ActivityService {
  static async record(input: RecordActivityInput): Promise<AgentActivity | null> {
    try {
      const def = activityTypeDef(input.type);

      const project = await AgentProject.findByPk(input.projectId);
      if (!project) {
        console.warn(`[app-agentiz] activity ${input.type} dropped: project ${input.projectId} not found`);
        return null;
      }
      const run = input.runId ? await AgentRun.findByPk(input.runId) : null;
      const taskId = input.taskId ?? run?.taskId ?? null;
      const task = taskId ? await AgentTask.findByPk(taskId) : null;

      const activity = await AgentActivity.create({
        type: def.type,
        kind: def.kind,
        projectId: project.id,
        runId: input.runId ?? null,
        taskId,
        proposalId: input.proposalId ?? null,
        interactionId: input.interactionId ?? null,
        title: truncate(input.title, MAX_TITLE),
        body: truncate(input.body, MAX_BODY),
        data: input.data ?? null,
      });

      // The pipeline scope needs the spec the run was created from — run.pipelineSpecId, written in
      // createRun. Events without a run (none today) would just skip that scope.
      const delivery = effectiveActivityPolicy(def.type, project.id, run?.pipelineSpecId ?? null);

      const event: ActivityEvent = {
        activity: {
          id: activity.id,
          type: activity.type,
          kind: activity.kind,
          projectId: activity.projectId,
          runId: activity.runId,
          taskId: activity.taskId,
          proposalId: activity.proposalId,
          interactionId: activity.interactionId,
          title: activity.title,
          body: activity.body,
          data: activity.data,
          createdAt: activity.createdAt,
        },
        context: {
          ownerId: project.ownerId ?? null,
          // Everybody with a stake in this project, not just its owner. Resolved once, here, so
          // no delivery layer has to know what a membership row is — and resolved from the live
          // rows on every event, because a person added yesterday must hear about today's run.
          recipientIds: await recipientsForProject(project.id, input.recipientToken ?? undefined),
          projectName: project.name ?? '',
          taskTitle: task?.title ?? null,
          run,
        },
        delivery,
      };
      dispatchActivity(event);
      return activity;
    } catch (error) {
      console.warn(
        `[app-agentiz] activity ${input.type} was not recorded:`,
        error instanceof Error ? error.message : error,
      );
      return null;
    }
  }
}
