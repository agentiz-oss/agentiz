import { DataTypes } from 'sequelize';

/**
 * A project no longer has to own a repository: repositories can be attached through integrations
 * (see the app-agentiz-gitlab-integration layer), and a project may have many of them at once.
 */
type QI = {
  sequelize: { getDialect: () => string };
  changeColumn: (table: string, column: string, attr: Record<string, unknown>) => Promise<unknown>;
};

function jsonType(context: QI) {
  return context.sequelize.getDialect() === 'postgres' ? DataTypes.JSONB : DataTypes.JSON;
}

export async function up({ context }: { context: QI }) {
  await context.changeColumn('agentiz_projects', 'repoProvider', { type: DataTypes.STRING, allowNull: true });
  await context.changeColumn('agentiz_projects', 'repoConfig', { type: jsonType(context), allowNull: true });
}

export async function down({ context }: { context: QI }) {
  await context.changeColumn('agentiz_projects', 'repoProvider', { type: DataTypes.STRING, allowNull: false });
  await context.changeColumn('agentiz_projects', 'repoConfig', { type: jsonType(context), allowNull: false });
}
