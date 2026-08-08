import type { AgentProject } from '../../models/AgentProject';
import type { AgentRole } from '../../models/AgentRole';
import type { AgentRun } from '../../models/AgentRun';
import type { AgentTask } from '../../models/AgentTask';
import type { FileChange, FileOp } from '../../lib/git';
import type { PipelineStageDef } from '../../types/agentiz';
import type { RunConversation } from '../AgentPipelineService';

export interface AgentStageContext {
  project: AgentProject;
  task: AgentTask;
  run: AgentRun;
  stage: PipelineStageDef;
  role: AgentRole;
  /** Outputs of every previous stage of this run, keyed by stage role name. */
  previousOutputs: Record<string, AgentStageResult>;
  /** Frozen task discussion and earlier-run results; primaryPrompt is the triggering user message. */
  conversation: RunConversation;
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string, meta?: Record<string, unknown>) => Promise<void>;
}

export interface AgentStageResult {
  /** Short human-readable line, aggregated into AgentRun.resultSummary and the tracker comment. */
  summary: string;
  /** Arbitrary structured payload persisted to AgentStageExecution.output. */
  output: Record<string, unknown>;
  /**
   * File edits this stage proposes, accumulated across stages and pushed by the final action.
   *
   * Either shape: the legacy `FileChange` (text create/update) or a full `FileOp`, so an in-process
   * executor can express a delete or a rename just like a remote worker does. `normalizeFileChanges`
   * turns the first into the second.
   */
  fileChanges?: Array<FileChange | FileOp>;
}

/**
 * One agent invocation. Concrete executors decide HOW a role is run (a stub, a local LLM call,
 * a Claude Agent SDK session, an external HTTP worker, ...) while the pipeline only depends on
 * this contract. Selected per role via AgentRole.config.executor, see AgentExecutorRegistry.
 */
export abstract class AgentExecutor {
  abstract readonly kind: string;
  abstract execute(context: AgentStageContext): Promise<AgentStageResult>;
}
