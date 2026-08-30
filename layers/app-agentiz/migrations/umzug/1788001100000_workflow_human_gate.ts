import { DataTypes } from 'sequelize';

type QI = {
  createTable: (table: string, attributes: Record<string, unknown>) => Promise<unknown>;
  dropTable: (table: string) => Promise<unknown>;
  addColumn: (table: string, field: string, options: Record<string, unknown>) => Promise<unknown>;
  removeColumn: (table: string, field: string) => Promise<unknown>;
  addIndex: (table: string, fields: string[], options?: Record<string, unknown>) => Promise<unknown>;
  removeIndex: (table: string, index: string) => Promise<unknown>;
};

const TASKS = 'agentiz_tasks';
const WORKFLOW_RUNS = 'agentiz_workflow_runs';
const APPROVALS = 'agentiz_approval_requests';

/**
 * The human gate of the "разработчик → агент-тестировщик → человек" flow
 * (`.ai-notes/human-in-the-loop-workflow-plan.md` §3).
 *
 * Three things, one migration, because they are one feature and a half-applied schema here means
 * a workflow that parks on a node whose table does not exist:
 *
 * - `agentiz_tasks.workflowStatus` — the free text a flow writes into the task card («ждём
 *   человека»). Deliberately not part of `WORKFLOW_WATCHED_FIELDS`: a flow writing a status must
 *   not wake its own `task.updated` trigger.
 * - `agentiz_workflow_runs.projectId/taskId` — "покажи воркфлоу этой задачи" and "сколько кругов
 *   уже было" are SQL questions; before this they lived inside the `msg` jsonb and were not.
 * - `agentiz_approval_requests` — a decision that waits for a person **outside** any run: it
 *   survives the run, the restart and the deploy, and closes only on a decision or a cancelled
 *   flow. That is exactly why it is not an `AgentRunInteraction`, which is tied to a worker lease.
 */
export async function up({ context }: { context: QI }) {
  await context.addColumn(TASKS, 'workflowStatus', { type: DataTypes.STRING, allowNull: true });
  await context.addColumn(TASKS, 'workflowStatusAt', { type: DataTypes.DATE, allowNull: true });
  await context.addColumn(TASKS, 'currentWorkflowRunId', { type: DataTypes.STRING, allowNull: true });

  await context.addColumn(WORKFLOW_RUNS, 'projectId', { type: DataTypes.STRING, allowNull: true });
  await context.addColumn(WORKFLOW_RUNS, 'taskId', { type: DataTypes.STRING, allowNull: true });
  await context.addIndex(WORKFLOW_RUNS, ['taskId'], { name: 'agentiz_workflow_runs_task_idx' });

  await context.createTable(APPROVALS, {
    id: { type: DataTypes.STRING, primaryKey: true },
    projectId: { type: DataTypes.STRING, allowNull: false },
    taskId: { type: DataTypes.STRING, allowNull: true },
    workflowRunId: { type: DataTypes.STRING, allowNull: true },
    nodeId: { type: DataTypes.STRING, allowNull: true },
    runId: { type: DataTypes.STRING, allowNull: true },
    assigneeUserId: { type: DataTypes.INTEGER, allowNull: true },
    assigneeToken: { type: DataTypes.STRING, allowNull: false },
    title: { type: DataTypes.STRING, allowNull: false },
    message: { type: DataTypes.TEXT, allowNull: true },
    links: { type: DataTypes.JSONB, allowNull: true },
    status: {
      type: DataTypes.ENUM('pending', 'approved', 'rejected', 'cancelled', 'expired'),
      allowNull: false,
      defaultValue: 'pending',
    },
    decidedByUserId: { type: DataTypes.INTEGER, allowNull: true },
    decidedAt: { type: DataTypes.DATE, allowNull: true },
    decisionComment: { type: DataTypes.TEXT, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false },
    updatedAt: { type: DataTypes.DATE, allowNull: false },
  });
  await context.addIndex(APPROVALS, ['projectId', 'status'], { name: 'agentiz_approvals_project_idx' });
  await context.addIndex(APPROVALS, ['taskId', 'status'], { name: 'agentiz_approvals_task_idx' });
  // Not unique: a partial "unique while pending" index is not expressible portably across the
  // postgres and sqlite deployments, so the "one pending request per waiting node" rule is
  // enforced in `ApprovalService.request` (find-or-create) instead. The index is what makes that
  // lookup cheap.
  await context.addIndex(APPROVALS, ['workflowRunId', 'nodeId'], { name: 'agentiz_approvals_node_idx' });
}

export async function down({ context }: { context: QI }) {
  await context.removeIndex(APPROVALS, 'agentiz_approvals_node_idx');
  await context.removeIndex(APPROVALS, 'agentiz_approvals_task_idx');
  await context.removeIndex(APPROVALS, 'agentiz_approvals_project_idx');
  await context.dropTable(APPROVALS);

  await context.removeIndex(WORKFLOW_RUNS, 'agentiz_workflow_runs_task_idx');
  await context.removeColumn(WORKFLOW_RUNS, 'taskId');
  await context.removeColumn(WORKFLOW_RUNS, 'projectId');

  await context.removeColumn(TASKS, 'currentWorkflowRunId');
  await context.removeColumn(TASKS, 'workflowStatusAt');
  await context.removeColumn(TASKS, 'workflowStatus');
}
