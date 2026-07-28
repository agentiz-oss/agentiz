import { DataTypes } from 'sequelize';

type QI = {
  sequelize: { getDialect: () => string };
  createTable: (name: string, attrs: Record<string, unknown>) => Promise<unknown>;
  addIndex: (table: string, fields: string[], options?: Record<string, unknown>) => Promise<unknown>;
  dropTable: (name: string) => Promise<unknown>;
};

function jsonType(context: QI) {
  return context.sequelize.getDialect() === 'postgres' ? DataTypes.JSONB : DataTypes.JSON;
}

export async function up({ context }: { context: QI }) {
  const json = jsonType(context);

  await context.createTable('agentiz_gitlab_oauth_apps', {
    id: { type: DataTypes.STRING, primaryKey: true, allowNull: false },
    name: { type: DataTypes.STRING, allowNull: false },
    baseUrl: { type: DataTypes.STRING, allowNull: false },
    applicationId: { type: DataTypes.STRING, allowNull: false },
    secrets: { type: json, allowNull: true },
    redirectUri: { type: DataTypes.STRING, allowNull: true },
    scopes: { type: json, allowNull: true },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    createdAt: { type: DataTypes.DATE, allowNull: true },
    updatedAt: { type: DataTypes.DATE, allowNull: true },
  });

  await context.createTable('agentiz_gitlab_connections', {
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
    status: {
      type: DataTypes.ENUM('active', 'expired', 'revoked', 'error'),
      allowNull: false,
      defaultValue: 'active',
    },
    lastError: { type: DataTypes.TEXT, allowNull: true },
    ownerId: { type: DataTypes.INTEGER, allowNull: true },
    lastSyncedAt: { type: DataTypes.DATE, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: true },
    updatedAt: { type: DataTypes.DATE, allowNull: true },
  });
  await context.addIndex('agentiz_gitlab_connections', ['oauthAppId', 'gitlabUserId'], {
    unique: true,
    name: 'agentiz_gitlab_connections_app_user_unique',
  });

  await context.createTable('agentiz_gitlab_repositories', {
    id: { type: DataTypes.STRING, primaryKey: true, allowNull: false },
    connectionId: {
      type: DataTypes.STRING,
      allowNull: false,
      references: { model: 'agentiz_gitlab_connections', key: 'id' },
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
  await context.addIndex('agentiz_gitlab_repositories', ['connectionId', 'gitlabProjectId'], {
    unique: true,
    name: 'agentiz_gitlab_repositories_connection_project_unique',
  });

  await context.createTable('agentiz_project_integrations', {
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
      references: { model: 'agentiz_gitlab_connections', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
    },
    repositoryId: {
      type: DataTypes.STRING,
      allowNull: false,
      references: { model: 'agentiz_gitlab_repositories', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
    },
    role: {
      type: DataTypes.ENUM('source', 'target', 'both'),
      allowNull: false,
      defaultValue: 'both',
    },
    isPrimary: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    syncIssues: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    config: { type: json, allowNull: true },
    lastSyncedAt: { type: DataTypes.DATE, allowNull: true },
    lastError: { type: DataTypes.TEXT, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: true },
    updatedAt: { type: DataTypes.DATE, allowNull: true },
  });
  // One link per (project, repository): a project may hold many repositories, but never twice.
  await context.addIndex('agentiz_project_integrations', ['projectId', 'repositoryId'], {
    unique: true,
    name: 'agentiz_project_integrations_project_repo_unique',
  });
  await context.addIndex('agentiz_project_integrations', ['projectId', 'provider']);

  await context.createTable('agentiz_gitlab_oauth_states', {
    id: { type: DataTypes.STRING, primaryKey: true, allowNull: false },
    state: { type: DataTypes.STRING, allowNull: false, unique: true },
    oauthAppId: { type: DataTypes.STRING, allowNull: false },
    codeVerifier: { type: DataTypes.STRING, allowNull: false },
    redirectUri: { type: DataTypes.STRING, allowNull: false },
    returnTo: { type: DataTypes.STRING, allowNull: true },
    ownerId: { type: DataTypes.INTEGER, allowNull: true },
    expiresAt: { type: DataTypes.DATE, allowNull: false },
    usedAt: { type: DataTypes.DATE, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: true },
    updatedAt: { type: DataTypes.DATE, allowNull: true },
  });
}

export async function down({ context }: { context: QI }) {
  await context.dropTable('agentiz_gitlab_oauth_states');
  await context.dropTable('agentiz_project_integrations');
  await context.dropTable('agentiz_gitlab_repositories');
  await context.dropTable('agentiz_gitlab_connections');
  await context.dropTable('agentiz_gitlab_oauth_apps');
}
