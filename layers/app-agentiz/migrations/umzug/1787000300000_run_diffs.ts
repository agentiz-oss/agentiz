import { DataTypes } from 'sequelize';

/**
 * "Разницу всегда хранить в Agentiz": one row per run holding what the agent changed, written
 * before the final action runs so that a failed push no longer destroys the work product.
 *
 * `runId` is unique — a retry of the same run overwrites its diff instead of accumulating rows.
 */
type QI = {
  sequelize: { getDialect: () => string };
  createTable: (name: string, attrs: Record<string, unknown>) => Promise<unknown>;
  addIndex: (table: string, fields: string[], options?: Record<string, unknown>) => Promise<unknown>;
  dropTable: (name: string) => Promise<unknown>;
};

const TABLE = 'agentiz_run_diffs';

export async function up({ context }: { context: QI }) {
  const json = context.sequelize.getDialect() === 'postgres' ? DataTypes.JSONB : DataTypes.JSON;

  await context.createTable(TABLE, {
    id: { type: DataTypes.STRING, primaryKey: true, allowNull: false },
    runId: {
      type: DataTypes.STRING,
      allowNull: false,
      references: { model: 'agentiz_runs', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
    },
    projectId: {
      type: DataTypes.STRING,
      allowNull: false,
      references: { model: 'agentiz_projects', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
    },
    // Deliberately not a foreign key: the diff has to outlive the repository row it came from,
    // otherwise deleting a repository would erase the record of what was changed in it.
    repositoryId: { type: DataTypes.STRING, allowNull: true },
    baseSha: { type: DataTypes.STRING, allowNull: true },
    patch: { type: DataTypes.TEXT, allowNull: true },
    ops: { type: json, allowNull: true },
    stats: { type: json, allowNull: true },
    truncated: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    appliedAt: { type: DataTypes.DATE, allowNull: true },
    appliedCommitSha: { type: DataTypes.STRING, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: true },
    updatedAt: { type: DataTypes.DATE, allowNull: true },
  });
  await context.addIndex(TABLE, ['runId'], { unique: true, name: 'agentiz_run_diffs_run_unique' });
}

export async function down({ context }: { context: QI }) {
  await context.dropTable(TABLE);
}
