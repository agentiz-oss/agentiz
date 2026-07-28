import { AgentExecutor } from './AgentExecutor';
import type { AgentStageContext, AgentStageResult } from './AgentExecutor';

/**
 * Deterministic placeholder executor: it performs no model call, it only records what the stage
 * WOULD have been asked to do and produces a report file. It exists so the whole pipeline —
 * sync, stage sequencing, logging, commit, tracker response — can be exercised end to end before
 * a real model/agent backend is wired in behind the same AgentExecutor contract.
 */
export class StubAgentExecutor extends AgentExecutor {
  readonly kind = 'stub';

  async execute(context: AgentStageContext): Promise<AgentStageResult> {
    const { task, stage, role, previousOutputs } = context;
    await context.log('info', `stub executor running role "${role.key}" for stage ${stage.order} (${stage.role})`);

    const priorSummaries = Object.entries(previousOutputs).map(([roleName, result]) => `${roleName}: ${result.summary}`);

    const report = [
      `# Agentiz stage report`,
      ``,
      `- task: #${task.externalId} — ${task.title}`,
      `- stage: ${stage.order} (${stage.role})`,
      `- agent role: ${role.key} (${role.title})`,
      `- model: ${role.model ?? '(not set)'}`,
      ``,
      `## Prompt`,
      role.systemPrompt ?? '(no system prompt configured)',
      ``,
      `## Prior stages`,
      priorSummaries.length > 0 ? priorSummaries.map((line) => `- ${line}`).join('\n') : '- (none)',
      ``,
    ].join('\n');

    return {
      summary: `[${stage.role}] executed by stub agent "${role.key}"`,
      output: {
        executor: this.kind,
        roleKey: role.key,
        model: role.model ?? null,
        promptLength: (role.systemPrompt ?? '').length,
        priorStages: Object.keys(previousOutputs),
      },
      fileChanges: [
        {
          path: `.agentiz/${task.externalId}/stage-${stage.order}-${stage.role}.md`,
          content: report,
        },
      ],
    };
  }
}
