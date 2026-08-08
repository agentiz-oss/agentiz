import { DataTypes } from 'sequelize';

/**
 * Drops the tables whose contents moved into the core by `app-agentiz:1787000000000`.
 *
 * A separate migration, and numbered after the copy, for two reasons: the copy has to have run
 * first, and if this layer is not mounted at all the drop simply never runs and three unused tables
 * stay behind — harmless, and recoverable by mounting the layer once.
 *
 * `down` recreates the structure but **not** the data: the rows now live in
 * `agentiz_git_connections` / `agentiz_repositories` / `agentiz_project_repositories`. Take a dump
 * before running this on production.
 */
type QI = {
  sequelize: { getDialect: () => string };
  createTable: (name: string, attrs: Record<string, unknown>) => Promise<unknown>;
  dropTable: (name: string) => Promise<unknown>;
  showAllTables: () => Promise<string[]>;
};

const LEGACY_LINKS = 'agentiz_project_integrations';
const LEGACY_REPOSITORIES = 'agentiz_gitlab_repositories';
const LEGACY_CONNECTIONS = 'agentiz_gitlab_connections';

async function tableExists(context: QI, name: string): Promise<boolean> {
  const tables = await context.showAllTables();
  return tables.map((table) => String(table).toLowerCase()).includes(name.toLowerCase());
}

export async function up({ context }: { context: QI }) {
  // Order matters: foreign keys point links -> repositories -> connections.
  for (const table of [LEGACY_LINKS, LEGACY_REPOSITORIES, LEGACY_CONNECTIONS]) {
    if (await tableExists(context, table)) await context.dropTable(table);
  }
}

export async function down({ context }: { context: QI }) {
  const json = context.sequelize.getDialect() === 'postgres' ? DataTypes.JSONB : DataTypes.JSON;

  await context.createTable(LEGACY_CONNECTIONS, {
    id: { type: DataTypes.STRING, primaryKey: true, allowNull: false },
    oauthAppId: {
      type: DataTypes.STRING,
      allowNull: false,
      references: { model: 'agentiz_gitlab_oauth_apps', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
    },
    gitlabUserId: { type: DataTypes.INTEGER, allowNull: true },
    username: { type: DataTypes.STRING, allowNull: true },
    displayName: { type: DataTypes.STRING, allowNull: true },
    avatarUrl: { type: DataTypes.STRING, allowNull: true },
    secrets: { type: json, allowNull: true },
    scope: { type: DataTypes.STRING, allowNull: true },
    expiresAt: { type: DataTypes.DATE, allowNull: true },
    status: { type: DataTypes.STRING, allowNull: false, defaultValue: 'active' },
    lastError: { type: DataTypes.TEXT, allowNull: true },
    ownerId: { type: DataTypes.INTEGER, allowNull: true },
    lastSyncedAt: { type: DataTypes.DATE, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: true },
    updatedAt: { type: DataTypes.DATE, allowNull: true },
  });

  await context.createTable(LEGACY_REPOSITORIES, {
    id: { type: DataTypes.STRING, primaryKey: true, allowNull: false },
    connectionId: {
      type: DataTypes.STRING,
      allowNull: false,
      references: { model: LEGACY_CONNECTIONS, key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
    },
    gitlabProjectId: { type: DataTypes.INTEGER, allowNull: false },
    pathWithNamespace: { type: DataTypes.STRING, allowNull: false },
    name: { type: DataTypes.STRING, allowNull: true },
    webUrl: { type: DataTypes.STRING, allowNull: true },
    defaultBranch: { type: DataTypes.STRING, allowNull: true },
    visibility: { type: DataTypes.STRING, allowNull: true },
    description: { type: DataTypes.TEXT, allowNull: true },
    issuesEnabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    lastActivityAt: { type: DataTypes.DATE, allowNull: true },
    raw: { type: json, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: true },
    updatedAt: { type: DataTypes.DATE, allowNull: true },
  });

  await context.createTable(LEGACY_LINKS, {
    id: { type: DataTypes.STRING, primaryKey: true, allowNull: false },
    projectId: {
      type: DataTypes.STRING,
      allowNull: false,
      references: { model: 'agentiz_projects', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
    },
    provider: { type: DataTypes.STRING, allowNull: false, defaultValue: 'gitlab' },
    connectionId: {
      type: DataTypes.STRING,
      allowNull: false,
      references: { model: LEGACY_CONNECTIONS, key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
    },
    repositoryId: {
      type: DataTypes.STRING,
      allowNull: false,
      references: { model: LEGACY_REPOSITORIES, key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
    },
    role: { type: DataTypes.STRING, allowNull: false, defaultValue: 'both' },
    isPrimary: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    syncIssues: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    config: { type: json, allowNull: true },
    lastSyncedAt: { type: DataTypes.DATE, allowNull: true },
    lastError: { type: DataTypes.TEXT, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: true },
    updatedAt: { type: DataTypes.DATE, allowNull: true },
  });
}
