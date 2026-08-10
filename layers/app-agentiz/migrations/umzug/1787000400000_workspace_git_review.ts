import { DataTypes } from 'sequelize';

type QI = {
  sequelize: { getDialect: () => string };
  createTable: (name: string, attrs: Record<string, unknown>) => Promise<unknown>;
  dropTable: (name: string) => Promise<unknown>;
  addColumn: (table: string, column: string, attrs: Record<string, unknown>) => Promise<unknown>;
  removeColumn: (table: string, column: string) => Promise<unknown>;
  addIndex: (table: string, fields: string[], options?: Record<string, unknown>) => Promise<unknown>;
  removeIndex: (table: string, name: string) => Promise<unknown>;
};

export async function up({ context }: { context: QI }) {
  await context.createTable('agentiz_workspace_proposals', {
    id: { type: DataTypes.STRING, primaryKey: true, allowNull: false },
    projectId: { type: DataTypes.STRING, allowNull: false, references: { model: 'agentiz_projects', key: 'id' }, onDelete: 'CASCADE' },
    taskId: { type: DataTypes.STRING, allowNull: false, references: { model: 'agentiz_tasks', key: 'id' }, onDelete: 'CASCADE' },
    repositoryId: { type: DataTypes.STRING, allowNull: false },
    workerId: { type: DataTypes.STRING, allowNull: false },
    workspaceKey: { type: DataTypes.STRING, allowNull: false },
    workspacePath: { type: DataTypes.STRING, allowNull: false },
    reservationKey: { type: DataTypes.STRING, allowNull: true },
    initialRunId: { type: DataTypes.STRING, allowNull: false },
    latestRunId: { type: DataTypes.STRING, allowNull: false },
    revision: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    latestDiffId: { type: DataTypes.STRING, allowNull: true },
    baseSha: { type: DataTypes.STRING, allowNull: true },
    baseBranch: { type: DataTypes.STRING, allowNull: true },
    remote: { type: DataTypes.STRING, allowNull: false, defaultValue: 'origin' },
    remoteUrl: { type: DataTypes.STRING, allowNull: true },
    remoteBaseSha: { type: DataTypes.STRING, allowNull: true },
    expectedTreeSha: { type: DataTypes.STRING, allowNull: true },
    targetMode: { type: DataTypes.STRING, allowNull: false },
    targetBranch: { type: DataTypes.STRING, allowNull: true },
    commitMessage: { type: DataTypes.TEXT, allowNull: false },
    status: { type: DataTypes.STRING, allowNull: false, defaultValue: 'working' },
    decisionActor: { type: DataTypes.STRING, allowNull: true },
    decisionAt: { type: DataTypes.DATE, allowNull: true },
    lastError: { type: DataTypes.TEXT, allowNull: true },
    pushedCommitSha: { type: DataTypes.STRING, allowNull: true },
    pushedAt: { type: DataTypes.DATE, allowNull: true },
    rejectedAt: { type: DataTypes.DATE, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: true },
    updatedAt: { type: DataTypes.DATE, allowNull: true },
  });
  await context.addIndex('agentiz_workspace_proposals', ['reservationKey'], { unique: true, name: 'agentiz_workspace_proposals_reservation_unique' });
  await context.addIndex('agentiz_workspace_proposals', ['taskId', 'createdAt'], { name: 'agentiz_workspace_proposals_task_idx' });

  await context.removeIndex('agentiz_run_jobs', 'agentiz_run_jobs_run_unique');
  await context.addColumn('agentiz_run_jobs', 'jobKind', { type: DataTypes.STRING, allowNull: false, defaultValue: 'pipeline' });
  await context.addColumn('agentiz_run_jobs', 'proposalId', { type: DataTypes.STRING, allowNull: true });
  await context.addIndex('agentiz_run_jobs', ['jobKind', 'runId'], { name: 'agentiz_run_jobs_kind_run_idx' });
  await context.addIndex('agentiz_run_jobs', ['proposalId', 'jobKind', 'status'], { name: 'agentiz_run_jobs_proposal_idx' });

  await context.addColumn('agentiz_runs', 'proposalId', { type: DataTypes.STRING, allowNull: true });
  await context.addColumn('agentiz_runs', 'workspaceRevision', { type: DataTypes.INTEGER, allowNull: true });
  await context.addIndex('agentiz_runs', ['proposalId', 'workspaceRevision'], { name: 'agentiz_runs_proposal_revision_idx' });

  for (const [name, attrs] of Object.entries({
    proposalId: { type: DataTypes.STRING, allowNull: true },
    revision: { type: DataTypes.INTEGER, allowNull: true },
    treeSha: { type: DataTypes.STRING, allowNull: true },
    patchSizeBytes: { type: DataTypes.INTEGER, allowNull: true },
    patchSha256: { type: DataTypes.STRING, allowNull: true },
  })) await context.addColumn('agentiz_run_diffs', name, attrs);
  await context.addIndex('agentiz_run_diffs', ['proposalId', 'revision'], { unique: true, name: 'agentiz_run_diffs_proposal_revision_unique' });
}

export async function down({ context }: { context: QI }) {
  await context.removeIndex('agentiz_run_diffs', 'agentiz_run_diffs_proposal_revision_unique');
  for (const name of ['patchSha256', 'patchSizeBytes', 'treeSha', 'revision', 'proposalId']) {
    await context.removeColumn('agentiz_run_diffs', name);
  }
  await context.removeIndex('agentiz_runs', 'agentiz_runs_proposal_revision_idx');
  await context.removeColumn('agentiz_runs', 'workspaceRevision');
  await context.removeColumn('agentiz_runs', 'proposalId');
  await context.removeIndex('agentiz_run_jobs', 'agentiz_run_jobs_proposal_idx');
  await context.removeIndex('agentiz_run_jobs', 'agentiz_run_jobs_kind_run_idx');
  await context.removeColumn('agentiz_run_jobs', 'proposalId');
  await context.removeColumn('agentiz_run_jobs', 'jobKind');
  await context.addIndex('agentiz_run_jobs', ['runId'], { unique: true, name: 'agentiz_run_jobs_run_unique' });
  await context.dropTable('agentiz_workspace_proposals');
}
