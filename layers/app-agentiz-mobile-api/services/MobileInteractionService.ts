import { Op } from 'sequelize';
import { AgentProject } from '../../app-agentiz/models/AgentProject';
import { AgentRun } from '../../app-agentiz/models/AgentRun';
import { AgentRunInteraction } from '../../app-agentiz/models/AgentRunInteraction';
import { AgentStageExecution } from '../../app-agentiz/models/AgentStageExecution';
import { AgentTask } from '../../app-agentiz/models/AgentTask';
import { AgentRunInteractionService } from '../../app-agentiz/services/AgentRunInteractionService';
import type { AgentRunInteractionAction } from '../../app-agentiz/types/agentiz';
import { MobileAuthError } from './MobileAuthService';

/**
 * The human-input side of a run on a phone: an agent that stopped mid-stage to ask a question
 * (ACP form elicitation, see app-agentiz/services/AgentRunInteractionService) can be answered from
 * the app instead of only from the dashboard.
 *
 * Ownership is resolved the same way MobileTaskService resolves it — a question is reachable only
 * through a project the caller owns, and anything else is reported as 404 so the API never confirms
 * that an interaction id exists. Writing goes through `AgentRunInteractionService.answer`, which
 * stays the single place that validates the response against `requestedSchema`, flips the run and
 * stage back out of `waiting_input` and records who answered.
 */
export class MobileInteractionService {
  /** Ids of the projects the caller owns. Empty means "nothing to look at", never "everything". */
  private static async ownedProjectIds(ownerId: number | string): Promise<string[]> {
    const projects = await AgentProject.findAll({ where: { ownerId: ownerId as any }, attributes: ['id'] });
    return projects.map((project) => project.id);
  }

  /**
   * The question as the app renders it: the prompt, the JSON-Schema form to fill in, and enough
   * context (project, task, stage) for the standalone list to be readable away from its task.
   */
  private static row(
    interaction: AgentRunInteraction,
    context: { task?: AgentTask | null; project?: AgentProject | null; stage?: AgentStageExecution | null } = {},
  ) {
    return {
      id: interaction.id,
      runId: interaction.runId,
      projectId: interaction.projectId,
      taskId: context.task?.id ?? null,
      taskTitle: context.task?.title ?? null,
      projectName: context.project?.name ?? null,
      stageRole: context.stage?.role ?? null,
      stageIndex: context.stage?.stageIndex ?? null,
      source: interaction.source,
      message: interaction.message,
      requestedSchema: interaction.requestedSchema,
      status: interaction.status,
      responseAction: interaction.responseAction,
      answeredByName: interaction.answeredByName,
      answeredAt: interaction.answeredAt,
      expiresAt: interaction.expiresAt,
      createdAt: interaction.createdAt,
    };
  }

  /** Every question of one run, oldest first — the run's own page shows answered ones as history. */
  static async forRun(runId: string) {
    const interactions = await AgentRunInteraction.findAll({
      where: { runId },
      order: [['createdAt', 'ASC']],
      limit: 100,
    });
    if (interactions.length === 0) return [];
    const stages = await AgentStageExecution.findAll({
      where: { id: { [Op.in]: [...new Set(interactions.map((item) => item.stageExecutionId))] } },
    });
    const stageById = new Map(stages.map((stage) => [stage.id, stage]));
    return interactions.map((interaction) => this.row(interaction, { stage: stageById.get(interaction.stageExecutionId) }));
  }

  /** Unanswered questions of one task, across all of its runs. */
  static async pendingForTask(taskId: string) {
    const runs = await AgentRun.findAll({ where: { taskId }, attributes: ['id'] });
    if (runs.length === 0) return [];
    const interactions = await AgentRunInteraction.findAll({
      where: { runId: { [Op.in]: runs.map((run) => run.id) }, status: 'pending' },
      order: [['createdAt', 'ASC']],
    });
    if (interactions.length === 0) return [];
    const stages = await AgentStageExecution.findAll({
      where: { id: { [Op.in]: [...new Set(interactions.map((item) => item.stageExecutionId))] } },
    });
    const stageById = new Map(stages.map((stage) => [stage.id, stage]));
    return interactions.map((interaction) => this.row(interaction, { stage: stageById.get(interaction.stageExecutionId) }));
  }

  /**
   * Everything waiting on the caller, across every project they own — the app's "Вопросы" screen.
   * A run pauses until this is answered, so the list is deliberately unfiltered by project.
   */
  static async listPending(ownerId: number | string) {
    const projectIds = await this.ownedProjectIds(ownerId);
    if (projectIds.length === 0) return [];
    const interactions = await AgentRunInteraction.findAll({
      where: { projectId: { [Op.in]: projectIds }, status: 'pending' },
      order: [['createdAt', 'ASC']],
      limit: 200,
    });
    if (interactions.length === 0) return [];

    const [runs, stages, projects] = await Promise.all([
      AgentRun.findAll({ where: { id: { [Op.in]: [...new Set(interactions.map((item) => item.runId))] } } }),
      AgentStageExecution.findAll({
        where: { id: { [Op.in]: [...new Set(interactions.map((item) => item.stageExecutionId))] } },
      }),
      AgentProject.findAll({ where: { id: { [Op.in]: projectIds } } }),
    ]);
    const tasks = await AgentTask.findAll({ where: { id: { [Op.in]: [...new Set(runs.map((run) => run.taskId))] } } });

    const runById = new Map(runs.map((run) => [run.id, run]));
    const stageById = new Map(stages.map((stage) => [stage.id, stage]));
    const taskById = new Map(tasks.map((task) => [task.id, task]));
    const projectById = new Map(projects.map((project) => [project.id, project]));

    return interactions.map((interaction) => {
      const run = runById.get(interaction.runId);
      return this.row(interaction, {
        task: run ? taskById.get(run.taskId) : null,
        project: projectById.get(interaction.projectId),
        stage: stageById.get(interaction.stageExecutionId),
      });
    });
  }

  /**
   * One question by id — what a tapped push notification opens. Returned whatever its status, so
   * the app can say "уже отвечен" instead of showing an empty screen when somebody got there first;
   * a question in a project the caller does not own is a 404 like everywhere else.
   */
  static async getForOwner(interactionId: string, ownerId: number | string) {
    const interaction = await AgentRunInteraction.findByPk(interactionId);
    if (!interaction) throw new MobileAuthError(404, 'Interaction not found');
    const project = await AgentProject.findByPk(interaction.projectId);
    if (!project || String(project.ownerId ?? '') !== String(ownerId)) {
      throw new MobileAuthError(404, 'Interaction not found');
    }
    const [stage, run] = await Promise.all([
      AgentStageExecution.findByPk(interaction.stageExecutionId),
      AgentRun.findByPk(interaction.runId),
    ]);
    const task = run ? await AgentTask.findByPk(run.taskId) : null;
    return this.row(interaction, { project, stage, task });
  }

  /**
   * Answers one question. `accept` carries the filled-in form and is validated against the
   * interaction's own `requestedSchema` by the core service; `decline` and `cancel` carry nothing
   * and let the agent continue without an answer.
   */
  static async answer(
    interactionId: string,
    ownerId: number | string,
    action: AgentRunInteractionAction,
    content: Record<string, unknown> | null,
    actor: { id: number | null; name: string },
  ) {
    const interaction = await AgentRunInteraction.findByPk(interactionId);
    if (!interaction) throw new MobileAuthError(404, 'Interaction not found');
    const project = await AgentProject.findByPk(interaction.projectId);
    if (!project || String(project.ownerId ?? '') !== String(ownerId)) {
      throw new MobileAuthError(404, 'Interaction not found');
    }

    // Ownership has just been proven against the project row itself, so the actor handed to the
    // core service is the project's owner — not `isAdmin`, which would widen this beyond the one
    // project the mobile caller was checked against.
    const answered = await AgentRunInteractionService.answer(interactionId, action, content, {
      id: project.ownerId ?? actor.id,
      name: actor.name,
    });
    const stage = await AgentStageExecution.findByPk(answered.stageExecutionId);
    return this.row(answered, { project, stage });
  }
}
