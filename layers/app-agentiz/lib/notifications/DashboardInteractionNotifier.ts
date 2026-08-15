import { AgentProject } from '../../models/AgentProject';
import { AgentRun } from '../../models/AgentRun';
import { AgentTask } from '../../models/AgentTask';
import type { InteractionCreatedEvent, InteractionNotifier } from '../interactionNotifiers';
import { dashboardNotificationsEnabled, sendDashboardNotification } from './dashboardNotifications';

/**
 * Second channel for "an agent is waiting for a human": the Adminizer bell, alongside the phone.
 *
 * The recipient rule is the mobile one, deliberately — the project's `ownerId`, which in Agentiz is
 * an Adminizer user id, so both channels address the same number. Somebody watching the dashboard
 * learns about a parked run without having the app installed or with push switched off.
 *
 * This lives in app-agentiz although the layer contributes no *push* notifier of its own: the rule
 * keeping delivery out of the core is about device tokens and provider credentials, and the
 * recipient here is a user of the very panel app-agentiz already runs inside.
 */
export class DashboardInteractionNotifier implements InteractionNotifier {
  readonly id = 'app-agentiz:interaction-dashboard';

  async notifyCreated(event: InteractionCreatedEvent): Promise<void> {
    if (!dashboardNotificationsEnabled()) return;

    const project = await AgentProject.findByPk(event.projectId);
    // No owner, nobody to tell — the blind spot every owner-scoped view has by design. Not
    // broadcast to all admins instead: the question text is that project's business.
    if (!project?.ownerId) return;

    const run = await AgentRun.findByPk(event.runId);
    const task = run ? await AgentTask.findByPk(run.taskId) : null;

    await sendDashboardNotification({
      channel: 'interaction',
      title: task?.title ? `Нужен ответ · ${task.title}` : `Нужен ответ · ${project.name}`,
      // The question itself: the bell shows title and message and nothing else, so what a person
      // has to read cannot live in metadata.
      message: event.message,
      userId: Number(project.ownerId),
      metadata: {
        kind: 'interaction',
        interactionId: event.interactionId,
        runId: event.runId,
        projectId: event.projectId,
        projectName: project.name ?? '',
        taskId: run?.taskId ?? '',
        source: event.source,
        // Nothing renders this today; it is here so the record identifies what was asked, and so a
        // link can be built from it the day the panel learns to open one.
        url: '/dashboard/agentiz-interactions',
      },
    });
  }
}
