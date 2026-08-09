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
    const { task, stage, role, previousOutputs, conversation } = context;
    const model = stage.model ?? role.model;
    await context.log('info', `stub executor running role "${role.key}" for stage ${stage.order} (${stage.role})`);

    await context.log('debug', `reading task #${task.externalId} "${task.title}" (${(task.description ?? '').length} chars of description)`);

    const priorSummaries = Object.entries(previousOutputs).map(([roleName, result]) => `${roleName}: ${result.summary}`);
    await context.log(
      'debug',
      priorSummaries.length > 0
        ? `considering ${priorSummaries.length} prior stage output(s): ${priorSummaries.join('; ')}`
        : 'no prior stage outputs to consider, this is the first stage',
    );
    await context.log(
      'debug',
      conversation.primaryPrompt
        ? `using human message ${conversation.primaryPrompt.id} as primary prompt; ${conversation.messages.length} thread message(s), ${conversation.priorRuns.length} prior run(s) in context`
        : `using task description as primary prompt; ${conversation.messages.length} thread message(s), ${conversation.priorRuns.length} prior run(s) in context`,
    );

    await context.log(
      'debug',
      `resolving role "${role.key}" (${role.title}): model=${model ?? '(not set)'}, prompt=${(role.systemPrompt ?? '').length} chars`,
    );

    await context.log('debug', `drafting stage report for stage ${stage.order} (${stage.role})`);

    const report = [
      `# Agentiz stage report`,
      ``,
      `- task: #${task.externalId} — ${task.title}`,
      `- stage: ${stage.order} (${stage.role})`,
      `- agent role: ${role.key} (${role.title})`,
      `- model: ${model ?? '(not set)'}`,
      ``,
      `## Prompt`,
      role.systemPrompt ?? '(no system prompt configured)',
      ``,
      `## Prior stages`,
      priorSummaries.length > 0 ? priorSummaries.map((line) => `- ${line}`).join('\n') : '- (none)',
      ``,
      `## Conversation`,
      conversation.primaryPrompt ? `Primary prompt: ${conversation.primaryPrompt.body}` : 'Primary prompt: task description',
      conversation.messages.length > 0
        ? conversation.messages.map((message) => `- [${message.authorKind}] ${message.authorName ?? 'unknown'}: ${message.body}`).join('\n')
        : '- (none)',
      ``,
    ].join('\n');

    const reportPath = `.agentiz/${task.externalId}/stage-${stage.order}-${stage.role}.md`;
    await context.log('debug', `writing report file ${reportPath} (${report.length} chars)`);
    await context.log('info', `stub executor finished stage ${stage.order} (${stage.role})`);

    return {
      summary: `[${stage.role}] executed by stub agent "${role.key}"`,
      output: {
        executor: this.kind,
        roleKey: role.key,
        model: model ?? null,
        promptLength: (role.systemPrompt ?? '').length,
        priorStages: Object.keys(previousOutputs),
        primaryPromptId: conversation.primaryPrompt?.id ?? null,
        conversationMessages: conversation.messages.length,
        priorRuns: conversation.priorRuns.length,
      },
      fileChanges: [
        {
          path: reportPath,
          content: report,
        },
      ],
    };
  }
}
