import Ajv from 'ajv';
import { Op, type Transaction } from 'sequelize';
import { AgentProject } from '../models/AgentProject';
import { AgentRun } from '../models/AgentRun';
import { AgentRunInteraction } from '../models/AgentRunInteraction';
import { AgentRunJob } from '../models/AgentRunJob';
import { AgentRunLog } from '../models/AgentRunLog';
import { AgentStageExecution } from '../models/AgentStageExecution';
import { AgentTask } from '../models/AgentTask';
import type { AgentRunInteractionAction } from '../types/agentiz';
import type { AgentTaskStatus } from '../types/agentiz';

const MAX_MESSAGE_BYTES = 8 * 1024;
const MAX_SCHEMA_BYTES = 64 * 1024;
const MAX_META_BYTES = 32 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_SEC = 24 * 60 * 60;
const UNRESOLVED = ['pending', 'answered'] as const;
const SENSITIVE_FIELD = /(password|passphrase|api[ _-]?key|access[ _-]?token|refresh[ _-]?token|private[ _-]?key|recovery[ _-]?code|card[ _-]?number|\bcvv\b)/i;

const ajv = new Ajv({ allErrors: true, strict: false });

export class InteractionError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export interface HumanInputRequest {
  externalRequestId: string;
  stageExecutionId: string;
  source: string;
  message: string;
  requestedSchema: Record<string, unknown>;
  toolCallId?: string | null;
  meta?: Record<string, unknown> | null;
  timeoutSec?: number;
}

export interface InteractionActor {
  id: number | null;
  name: string;
  isAdmin?: boolean;
}

function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value ?? null), 'utf8');
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Codex represents an "Other" answer as a sibling `<question>__other` field, but leaves the
 * option field's `oneOf` in the JSON Schema.  Its adapter intentionally gives the sibling
 * priority.  Omit the option field from validation in that one case: it is optional in the Codex
 * schema and the complete, unmodified content is still sent back to the adapter afterwards.
 */
function contentForValidation(schema: Record<string, unknown>, content: Record<string, unknown>): Record<string, unknown> {
  const properties = plainObject(schema.properties) ? schema.properties : {};
  const validationContent = { ...content };
  for (const [otherName, definition] of Object.entries(properties)) {
    if (!plainObject(definition) || !plainObject(definition._meta) || !plainObject(definition._meta.codex)) continue;
    const codex = definition._meta.codex;
    const questionId = typeof codex.questionId === 'string' ? codex.questionId : null;
    if (codex.isOtherAnswer !== true || !questionId) continue;
    const otherAnswer = content[otherName];
    const question = properties[questionId];
    const questionMeta = plainObject(question) && plainObject(question._meta) && plainObject(question._meta.codex)
      ? question._meta.codex
      : null;
    if (typeof otherAnswer === 'string' && otherAnswer.trim() && questionMeta?.isOther === true) {
      delete validationContent[questionId];
    }
  }
  return validationContent;
}

function validateRequest(input: HumanInputRequest): void {
  if (!input.externalRequestId || input.externalRequestId.length > 256) {
    throw new InteractionError(400, 'externalRequestId is required and must be at most 256 characters');
  }
  if (!input.stageExecutionId) throw new InteractionError(400, 'stageExecutionId is required');
  if (!input.source || input.source.length > 64) throw new InteractionError(400, 'source is required and must be at most 64 characters');
  if (!input.message || Buffer.byteLength(input.message, 'utf8') > MAX_MESSAGE_BYTES) {
    throw new InteractionError(400, `message is required and must be at most ${MAX_MESSAGE_BYTES} bytes`);
  }
  if (SENSITIVE_FIELD.test(input.message)) {
    throw new InteractionError(400, 'Sensitive credentials cannot be requested through form elicitation');
  }
  if (!plainObject(input.requestedSchema) || bytes(input.requestedSchema) > MAX_SCHEMA_BYTES) {
    throw new InteractionError(400, `requestedSchema must be an object no larger than ${MAX_SCHEMA_BYTES} bytes`);
  }
  if (input.requestedSchema.type !== 'object' || !plainObject(input.requestedSchema.properties)) {
    throw new InteractionError(400, 'Only ACP form schemas with an object and properties are supported');
  }
  if (Object.keys(input.requestedSchema.properties).length > 50) {
    throw new InteractionError(400, 'requestedSchema may contain at most 50 fields');
  }
  for (const [name, definition] of Object.entries(input.requestedSchema.properties)) {
    const text = `${name} ${plainObject(definition) ? String(definition.title ?? '') : ''} ${plainObject(definition) ? String(definition.description ?? '') : ''}`;
    if (SENSITIVE_FIELD.test(text)) {
      throw new InteractionError(400, `Sensitive field "${name}" cannot be requested through form elicitation`);
    }
  }
  if (input.meta && bytes(input.meta) > MAX_META_BYTES) {
    throw new InteractionError(400, `meta must be at most ${MAX_META_BYTES} bytes`);
  }
  try {
    ajv.compile(input.requestedSchema);
  } catch (error) {
    throw new InteractionError(400, `Invalid requestedSchema: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export class AgentRunInteractionService {
  static async create(job: AgentRunJob, input: HumanInputRequest): Promise<AgentRunInteraction> {
    validateRequest(input);
    const stage = await AgentStageExecution.findOne({ where: { id: input.stageExecutionId, runId: job.runId } });
    if (!stage) throw new InteractionError(400, 'stageExecutionId does not belong to this run');
    const timeoutSec = Math.min(Math.max(Number(input.timeoutSec ?? DEFAULT_TIMEOUT_SEC), 60), 7 * 24 * 60 * 60);
    const [interaction, created] = await AgentRunInteraction.findOrCreate({
      where: { jobId: job.id, attempt: job.attempt, externalRequestId: input.externalRequestId },
      defaults: {
        projectId: job.projectId,
        runId: job.runId,
        jobId: job.id,
        attempt: job.attempt,
        stageExecutionId: stage.id,
        kind: 'elicitation',
        source: input.source,
        externalRequestId: input.externalRequestId,
        toolCallId: input.toolCallId ?? null,
        message: input.message,
        requestedSchema: input.requestedSchema,
        status: 'pending',
        responseAction: null,
        responseContent: null,
        answeredById: null,
        answeredByName: null,
        answeredAt: null,
        deliveredAt: null,
        expiresAt: new Date(Date.now() + timeoutSec * 1000),
        meta: input.meta ?? null,
      },
    });
    if (created) {
      await Promise.all([
        AgentRun.update({ status: 'waiting_input' }, { where: { id: job.runId, status: { [Op.in]: ['pending', 'running'] } } }),
        AgentStageExecution.update({ status: 'waiting_input' }, { where: { id: stage.id, status: 'running' } }),
      ]);
      await this.recomputeTaskForRun(job.runId);
      await this.log(interaction, 'info', 'Agent is waiting for human input', { interactionId: interaction.id, source: interaction.source });
    }
    return interaction;
  }

  static async wait(job: AgentRunJob, interactionId: string, waitMs = 25_000): Promise<AgentRunInteraction | null> {
    const deadline = Date.now() + Math.min(Math.max(waitMs, 0), 25_000);
    while (true) {
      const interaction = await AgentRunInteraction.findOne({
        where: { id: interactionId, jobId: job.id, attempt: job.attempt },
      });
      if (!interaction) throw new InteractionError(404, 'Interaction not found for this lease attempt');
      if (interaction.status !== 'pending') return interaction;
      if (interaction.expiresAt && interaction.expiresAt.getTime() <= Date.now()) {
        await interaction.update({ status: 'expired', responseAction: 'cancel', responseContent: null });
        await job.update({ cancelRequestedAt: new Date(), cancelReason: 'Human input request expired' });
        await this.log(interaction, 'warn', 'Human input request expired');
        return interaction;
      }
      if (job.cancelRequestedAt) {
        await interaction.update({ status: 'cancelled', responseAction: 'cancel', responseContent: null });
        return interaction;
      }
      if (Date.now() >= deadline) return null;
      await new Promise((resolve) => setTimeout(resolve, Math.min(500, deadline - Date.now())));
      await job.reload();
    }
  }

  static async acknowledge(job: AgentRunJob, interactionId: string): Promise<AgentRunInteraction> {
    const sequelize = AgentRunInteraction.sequelize;
    if (!sequelize) throw new InteractionError(500, 'Sequelize is not initialized');
    const interaction = await sequelize.transaction(async (transaction) => {
      const row = await AgentRunInteraction.findOne({
        where: { id: interactionId, jobId: job.id, attempt: job.attempt },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!row) throw new InteractionError(404, 'Interaction not found for this lease attempt');
      if (row.status === 'answered') {
        await row.update({ status: 'delivered', deliveredAt: new Date() }, { transaction });
      } else if (row.status !== 'delivered' && row.status !== 'cancelled' && row.status !== 'expired') {
        throw new InteractionError(409, `Interaction is ${row.status}`);
      }
      return row;
    });
    await this.resumeIfResolved(interaction.runId, interaction.stageExecutionId, interaction.jobId, interaction.attempt);
    if (interaction.status === 'delivered') await this.log(interaction, 'info', 'Human input delivered to agent');
    return interaction;
  }

  static async answer(
    interactionId: string,
    action: AgentRunInteractionAction,
    content: Record<string, unknown> | null,
    actor: InteractionActor,
  ): Promise<AgentRunInteraction> {
    if (!['accept', 'decline', 'cancel'].includes(action)) throw new InteractionError(400, 'action must be accept, decline or cancel');
    if (action === 'accept') {
      if (!plainObject(content) || bytes(content) > MAX_RESPONSE_BYTES) {
        throw new InteractionError(400, `Accepted content must be an object no larger than ${MAX_RESPONSE_BYTES} bytes`);
      }
    } else if (content !== null) {
      throw new InteractionError(400, 'decline and cancel responses must not contain content');
    }
    const sequelize = AgentRunInteraction.sequelize;
    if (!sequelize) throw new InteractionError(500, 'Sequelize is not initialized');
    const interaction = await sequelize.transaction(async (transaction) => {
      const row = await AgentRunInteraction.findByPk(interactionId, { transaction, lock: transaction.LOCK.UPDATE });
      if (!row) throw new InteractionError(404, 'Interaction not found');
      await this.assertProjectAccess(row.projectId, actor, transaction);
      if (row.status !== 'pending') throw new InteractionError(409, `Interaction is already ${row.status}`);
      if (action === 'accept') {
        const validate = ajv.compile(row.requestedSchema);
        if (!validate(contentForValidation(row.requestedSchema, content!))) {
          const detail = ajv.errorsText(validate.errors, { separator: '; ' });
          throw new InteractionError(400, `Response does not match requestedSchema: ${detail}`);
        }
      }
      await row.update({
        status: 'answered',
        responseAction: action,
        responseContent: action === 'accept' ? content : null,
        answeredById: actor.id,
        answeredByName: actor.name,
        answeredAt: new Date(),
      }, { transaction });
      return row;
    });
    await this.log(interaction, 'info', `Human input answered with ${action}`, { answeredBy: actor.name });
    return interaction;
  }

  static async listPending(actor: InteractionActor): Promise<AgentRunInteraction[]> {
    const projects = await AgentProject.findAll();
    const allowed = projects.filter((project) => this.canAccessProject(project, actor)).map((project) => project.id);
    if (allowed.length === 0) return [];
    return AgentRunInteraction.findAll({
      where: { projectId: { [Op.in]: allowed }, status: 'pending' },
      order: [['createdAt', 'ASC']],
      limit: 200,
    });
  }

  static async closeForJob(
    job: AgentRunJob,
    status: 'cancelled' | 'orphaned',
    reason?: string,
  ): Promise<number> {
    const interactions = await AgentRunInteraction.findAll({
      where: { jobId: job.id, attempt: job.attempt, status: { [Op.in]: [...UNRESOLVED] } },
    });
    if (interactions.length === 0) return 0;
    await AgentRunInteraction.update({
      status,
      responseAction: status === 'cancelled' ? 'cancel' : null,
      responseContent: null,
    }, { where: { id: { [Op.in]: interactions.map((item) => item.id) } } });
    for (const interaction of interactions) {
      interaction.status = status;
      await this.log(interaction, 'warn', `Human input request ${status}${reason ? `: ${reason}` : ''}`);
    }
    await this.resumeIfResolved(job.runId, interactions[0].stageExecutionId, job.id, job.attempt);
    return interactions.length;
  }

  static async hasUnresolved(job: AgentRunJob): Promise<boolean> {
    return Boolean(await AgentRunInteraction.findOne({
      where: { jobId: job.id, attempt: job.attempt, status: { [Op.in]: [...UNRESOLVED] } },
      attributes: ['id'],
    }));
  }

  /** Keep one run finishing from hiding another active run (especially one waiting for input). */
  static async setTaskStatusConsideringActiveRuns(taskId: string, fallback: AgentTaskStatus): Promise<void> {
    const active = await AgentRun.findAll({
      where: { taskId, status: { [Op.in]: ['pending', 'running', 'waiting_input'] } },
      attributes: ['status'],
    });
    const status: AgentTaskStatus = active.some((item) => item.status === 'waiting_input')
      ? 'waiting_input'
      : active.some((item) => item.status === 'running')
        ? 'running'
        : active.length > 0
          ? 'queued'
          : fallback;
    await AgentTask.update({ status }, { where: { id: taskId } });
  }

  private static async resumeIfResolved(runId: string, stageExecutionId: string, jobId: string, attempt: number): Promise<void> {
    const unresolved = await AgentRunInteraction.count({
      where: { jobId, attempt, status: { [Op.in]: [...UNRESOLVED] } },
    });
    if (unresolved > 0) return;
    await Promise.all([
      AgentRun.update({ status: 'running' }, { where: { id: runId, status: 'waiting_input' } }),
      AgentStageExecution.update({ status: 'running' }, { where: { id: stageExecutionId, status: 'waiting_input' } }),
    ]);
    await this.recomputeTaskForRun(runId);
  }

  private static async recomputeTaskForRun(runId: string): Promise<void> {
    const run = await AgentRun.findByPk(runId);
    if (!run) return;
    await this.setTaskStatusConsideringActiveRuns(run.taskId, 'running');
  }

  private static canAccessProject(project: AgentProject, actor: InteractionActor): boolean {
    return Boolean(actor.isAdmin || project.ownerId === null || (actor.id !== null && project.ownerId === actor.id));
  }

  private static async assertProjectAccess(projectId: string, actor: InteractionActor, transaction: Transaction): Promise<void> {
    const project = await AgentProject.findByPk(projectId, { transaction });
    if (!project) throw new InteractionError(404, 'Project not found');
    if (!this.canAccessProject(project, actor)) throw new InteractionError(403, 'You do not have access to this project');
  }

  private static async log(
    interaction: AgentRunInteraction,
    level: 'info' | 'warn',
    message: string,
    meta?: Record<string, unknown>,
  ): Promise<void> {
    await AgentRunLog.create({
      runId: interaction.runId,
      projectId: interaction.projectId,
      stageExecutionId: interaction.stageExecutionId,
      level,
      message,
      meta: { interactionId: interaction.id, ...(meta ?? {}) },
    });
  }
}
