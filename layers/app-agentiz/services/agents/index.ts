import { AgentExecutor } from './AgentExecutor';
import { StubAgentExecutor } from './StubAgentExecutor';
import type { AgentRole } from '../../models/AgentRole';

export { AgentExecutor, StubAgentExecutor };
export type { AgentStageContext, AgentStageResult } from './AgentExecutor';

const executors = new Map<string, AgentExecutor>();

export function registerAgentExecutor(executor: AgentExecutor): void {
  executors.set(executor.kind, executor);
}

registerAgentExecutor(new StubAgentExecutor());

export const DEFAULT_EXECUTOR_KIND = 'stub';

/**
 * Picks the executor for a role. `AgentRole.config.executor` names the backend; roles that do
 * not name one fall back to the stub so a project is runnable as soon as it is created.
 */
export function resolveAgentExecutor(role: AgentRole): AgentExecutor {
  const kind = String((role.config as any)?.executor ?? DEFAULT_EXECUTOR_KIND);
  const executor = executors.get(kind);
  if (!executor) {
    throw new Error(
      `Agent role "${role.key}": unknown executor "${kind}". Registered: [${[...executors.keys()].join(', ')}]`,
    );
  }
  return executor;
}
