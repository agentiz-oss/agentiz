import { AgentRun } from '../../models/AgentRun';
import { AgentRunDiff } from '../../models/AgentRunDiff';
import { AgentProject } from '../../models/AgentProject';
import { AgentTask } from '../../models/AgentTask';
import { AgentWorkspaceProposal } from '../../models/AgentWorkspaceProposal';
import { branchToHostLabel } from '../workspaceBranch';

/**
 * What a finished run is, in the words a graph can use — the second half of `msg.payload` after an
 * `agentiz.pipeline` node.
 *
 * The first half (status, summary, verdict) says how the run *ended*; this half says what it
 * *produced*, and without it a graph cannot name the work to the person it is about to ask. Every
 * field here is a fact off a row — a branch, a sha, a count — never the agent's prose: the summary
 * already travels beside it, and the one time a graph put `{{payload.summary}}` into an approval it
 * filled the request with several screens of reasoning.
 *
 * Where each field is available differs by pipeline source, and that is the whole reason this is
 * one function rather than a template per graph:
 *
 * - `repository`: the branch is computed by the final action from the spec and the task, the commit
 *   lands on `AgentRun.commitSha/commitUrl`, a pull request on `responseUrl`;
 * - `worker_workspace`: the branch is chosen when the run is queued (`AgentWorkspaceProposal`
 *   carries it long before the agent starts), and `pushed` is almost always **false** at this
 *   moment — delivery is a separate job that runs after the run is already `succeeded`.
 *
 * `pushed` is therefore a fact about *this instant*, not a promise: a template may name the branch
 * and build a preview URL from it, but nothing here claims the branch is already in the remote. A
 * reviewer who later redirects the commit to another branch (`approve` accepts a `targetBranch`
 * override) does not change what was rendered here — text already written to a person is not
 * rewritten, and anything that needs the live answer reads the proposal instead.
 */
export interface RunFacts {
  branch: string | null;
  /** The branch as a single DNS label, for a preview hostname; null when it cannot be one. */
  branchSlug: string | null;
  commitSha: string | null;
  commitShort: string | null;
  commitUrl: string | null;
  /** The pull request or tracker comment the run answered with, when it opened one. */
  prUrl: string | null;
  /** Whether the branch is in the remote **right now** — see the note above. */
  pushed: boolean;
  pushedAt: string | null;
  baseRef: string | null;
  baseSha: string | null;
  taskTitle: string | null;
  projectSlug: string | null;
  filesChanged: number | null;
  insertions: number | null;
  deletions: number | null;
}

/**
 * Collects them for one finished run.
 *
 * Three reads by primary key on a terminal transition, and all three are optional: a missing row
 * costs the field, never the flow. The caller treats a `null` return as "carry on with the
 * pre-existing payload" — a workflow that cannot be continued because a diff row was missing would
 * be a far worse failure than a template rendering an empty branch.
 */
export async function collectRunFacts(run: AgentRun): Promise<RunFacts> {
  const [proposal, task, project, diff] = await Promise.all([
    run.proposalId ? AgentWorkspaceProposal.findByPk(run.proposalId) : null,
    run.taskId ? AgentTask.findByPk(run.taskId) : null,
    run.projectId ? AgentProject.findByPk(run.projectId) : null,
    AgentRunDiff.findOne({ where: { runId: run.id }, order: [['createdAt', 'DESC']] }),
  ]);

  // `run.branch` is written by whichever final action produced it; the proposal is the fallback for
  // runs that finished before that column existed, and for `targetMode: 'current'`, where the
  // branch is whatever the checkout was already on and only the worker's report knows it.
  const branch = run.branch ?? proposal?.targetBranch ?? proposal?.baseBranch ?? null;
  const commitSha = run.commitSha ?? proposal?.pushedCommitSha ?? null;
  const stats = diff?.stats ?? null;

  return {
    branch,
    branchSlug: branchToHostLabel(branch),
    commitSha,
    commitShort: commitSha ? commitSha.slice(0, 12) : null,
    commitUrl: run.commitUrl ?? null,
    prUrl: run.responseUrl ?? null,
    pushed: proposal ? proposal.status === 'pushed' : Boolean(run.commitSha),
    pushedAt: proposal?.pushedAt ? proposal.pushedAt.toISOString() : null,
    baseRef: run.baseRef ?? null,
    baseSha: run.baseSha ?? null,
    taskTitle: task?.title ?? null,
    projectSlug: project?.slug ?? null,
    filesChanged: stats?.files ?? diff?.ops?.length ?? null,
    insertions: stats?.insertions ?? null,
    deletions: stats?.deletions ?? null,
  };
}
