import { DataTypes } from 'sequelize';

/**
 * Moves "which repository does this project use" out of the GitLab layer and into the core, so a
 * project can hold repositories of several platforms at once.
 *
 * Numbered **after** `1786000000000_init_gitlab_integration`: on an existing database the legacy
 * tables are therefore already created and populated, and on a fresh one they exist and are empty,
 * so the copy below degenerates into a no-op. Both cases are correct without branching.
 *
 * The copy keeps the **original primary keys**. That is the point of the whole migration:
 * `AgentTask.raw.agentizIntegration.integrationId` points at a row of
 * `agentiz_project_integrations`, and preserving ids means not a single stored task has to be
 * rewritten to keep resolving.
 */
type QI = {
  sequelize: {
    getDialect: () => string;
    query: (sql: string, options?: Record<string, unknown>) => Promise<unknown>;
  };
  createTable: (name: string, attrs: Record<string, unknown>) => Promise<unknown>;
  addIndex: (table: string, fields: string[], options?: Record<string, unknown>) => Promise<unknown>;
  dropTable: (name: string) => Promise<unknown>;
  showAllTables: () => Promise<string[]>;
};

const CONNECTIONS = 'agentiz_git_connections';
const REPOSITORIES = 'agentiz_repositories';
const LINKS = 'agentiz_project_repositories';

function jsonType(context: QI) {
  return context.sequelize.getDialect() === 'postgres' ? DataTypes.JSONB : DataTypes.JSON;
}

async function tableExists(context: QI, name: string): Promise<boolean> {
  const tables = await context.showAllTables();
  return tables.map((table) => String(table).toLowerCase()).includes(name.toLowerCase());
}

async function select<T = Record<string, unknown>>(context: QI, sql: string): Promise<T[]> {
  const rows = await context.sequelize.query(sql, { type: 'SELECT' });
  return (rows ?? []) as T[];
}

/** `group/subgroup/repo` -> owner `group/subgroup`, repo `repo` (GitLab allows nested groups). */
function splitPath(pathWithNamespace: string): { owner: string; repo: string } {
  const index = pathWithNamespace.lastIndexOf('/');
  if (index < 0) return { owner: '', repo: pathWithNamespace };
  return { owner: pathWithNamespace.slice(0, index), repo: pathWithNamespace.slice(index + 1) };
}

export async function up({ context }: { context: QI }) {
  const json = jsonType(context);

  await context.createTable(CONNECTIONS, {
    id: { type: DataTypes.STRING, primaryKey: true, allowNull: false },
    provider: { type: DataTypes.STRING, allowNull: false },
    oauthAppId: { type: DataTypes.STRING, allowNull: true },
    baseUrl: { type: DataTypes.STRING, allowNull: true },
    externalUserId: { type: DataTypes.STRING, allowNull: true },
    username: { type: DataTypes.STRING, allowNull: true },
    displayName: { type: DataTypes.STRING, allowNull: true },
    avatarUrl: { type: DataTypes.STRING, allowNull: true },
    secrets: { type: json, allowNull: true },
    scope: { type: DataTypes.STRING, allowNull: true },
    expiresAt: { type: DataTypes.DATE, allowNull: true },
    // STRING, not ENUM: adding a value to a postgres ENUM needs its own ALTER TYPE, which sqlite
    // does not support at all, and this project runs on both.
    status: { type: DataTypes.STRING, allowNull: false, defaultValue: 'active' },
    lastError: { type: DataTypes.TEXT, allowNull: true },
    ownerId: { type: DataTypes.INTEGER, allowNull: true },
    lastSyncedAt: { type: DataTypes.DATE, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: true },
    updatedAt: { type: DataTypes.DATE, allowNull: true },
  });
  await context.addIndex(CONNECTIONS, ['provider', 'oauthAppId', 'externalUserId'], {
    name: 'agentiz_git_connections_account_idx',
  });

  await context.createTable(REPOSITORIES, {
    id: { type: DataTypes.STRING, primaryKey: true, allowNull: false },
    connectionId: {
      type: DataTypes.STRING,
      allowNull: false,
      references: { model: CONNECTIONS, key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
    },
    provider: { type: DataTypes.STRING, allowNull: false },
    externalRepoId: { type: DataTypes.STRING, allowNull: false },
    pathWithNamespace: { type: DataTypes.STRING, allowNull: false },
    owner: { type: DataTypes.STRING, allowNull: false, defaultValue: '' },
    repo: { type: DataTypes.STRING, allowNull: false, defaultValue: '' },
    name: { type: DataTypes.STRING, allowNull: true },
    webUrl: { type: DataTypes.STRING, allowNull: true },
    cloneUrl: { type: DataTypes.STRING, allowNull: true },
    defaultBranch: { type: DataTypes.STRING, allowNull: true },
    visibility: { type: DataTypes.STRING, allowNull: true },
    description: { type: DataTypes.TEXT, allowNull: true },
    issuesEnabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    lastActivityAt: { type: DataTypes.DATE, allowNull: true },
    raw: { type: json, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: true },
    updatedAt: { type: DataTypes.DATE, allowNull: true },
  });
  await context.addIndex(REPOSITORIES, ['connectionId', 'externalRepoId'], {
    unique: true,
    name: 'agentiz_repositories_connection_external_unique',
  });

  await context.createTable(LINKS, {
    id: { type: DataTypes.STRING, primaryKey: true, allowNull: false },
    projectId: {
      type: DataTypes.STRING,
      allowNull: false,
      references: { model: 'agentiz_projects', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
    },
    provider: { type: DataTypes.STRING, allowNull: false },
    connectionId: {
      type: DataTypes.STRING,
      allowNull: false,
      references: { model: CONNECTIONS, key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
    },
    repositoryId: {
      type: DataTypes.STRING,
      allowNull: false,
      references: { model: REPOSITORIES, key: 'id' },
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
  await context.addIndex(LINKS, ['projectId', 'repositoryId'], {
    unique: true,
    name: 'agentiz_project_repositories_project_repo_unique',
  });
  await context.addIndex(LINKS, ['projectId', 'provider']);

  await copyGitlabData(context);
}

/**
 * Copies whatever the GitLab layer accumulated. Every step is guarded by a table-existence check:
 * the layer may never have been mounted on this installation, in which case there is nothing to
 * copy and that is not an error.
 */
async function copyGitlabData(context: QI): Promise<void> {
  const quote = (value: unknown): string => {
    if (value === null || value === undefined) return 'NULL';
    if (value instanceof Date) return `'${value.toISOString()}'`;
    if (typeof value === 'number') return String(value);
    if (typeof value === 'boolean') return context.sequelize.getDialect() === 'postgres' ? String(value) : (value ? '1' : '0');
    if (typeof value === 'object') return `'${JSON.stringify(value).replace(/'/g, "''")}'`;
    return `'${String(value).replace(/'/g, "''")}'`;
  };

  if (await tableExists(context, 'agentiz_gitlab_connections')) {
    // baseUrl lives on the OAuth application in the old schema; it is denormalized into the
    // connection here so the core never has to read a layer's table to build a URL.
    const connections = await select(context, `
      SELECT c.*, a."baseUrl" AS "appBaseUrl"
      FROM agentiz_gitlab_connections c
      LEFT JOIN agentiz_gitlab_oauth_apps a ON a.id = c."oauthAppId"
    `);
    for (const row of connections) {
      await context.sequelize.query(`
        INSERT INTO ${CONNECTIONS} (id, provider, "oauthAppId", "baseUrl", "externalUserId", username,
          "displayName", "avatarUrl", secrets, scope, "expiresAt", status, "lastError", "ownerId",
          "lastSyncedAt", "createdAt", "updatedAt")
        VALUES (${quote(row.id)}, 'gitlab', ${quote(row.oauthAppId)}, ${quote(row.appBaseUrl)},
          ${quote(row.gitlabUserId === null || row.gitlabUserId === undefined ? null : String(row.gitlabUserId))},
          ${quote(row.username)}, ${quote(row.displayName)}, ${quote(row.avatarUrl)}, ${quote(row.secrets)},
          ${quote(row.scope)}, ${quote(row.expiresAt)}, ${quote(row.status ?? 'active')}, ${quote(row.lastError)},
          ${quote(row.ownerId)}, ${quote(row.lastSyncedAt)}, ${quote(row.createdAt)}, ${quote(row.updatedAt)})
      `);
    }
  }

  if (await tableExists(context, 'agentiz_gitlab_repositories')) {
    const repositories = await select(context, 'SELECT * FROM agentiz_gitlab_repositories');
    for (const row of repositories) {
      const { owner, repo } = splitPath(String(row.pathWithNamespace ?? ''));
      const cloneUrl = row.webUrl ? `${String(row.webUrl).replace(/\/$/, '')}.git` : null;
      await context.sequelize.query(`
        INSERT INTO ${REPOSITORIES} (id, "connectionId", provider, "externalRepoId", "pathWithNamespace",
          owner, repo, name, "webUrl", "cloneUrl", "defaultBranch", visibility, description,
          "issuesEnabled", "lastActivityAt", raw, "createdAt", "updatedAt")
        VALUES (${quote(row.id)}, ${quote(row.connectionId)}, 'gitlab', ${quote(String(row.gitlabProjectId))},
          ${quote(row.pathWithNamespace)}, ${quote(owner)}, ${quote(repo)}, ${quote(row.name)},
          ${quote(row.webUrl)}, ${quote(cloneUrl)}, ${quote(row.defaultBranch)}, ${quote(row.visibility)},
          ${quote(row.description)}, ${quote(row.issuesEnabled ?? true)}, ${quote(row.lastActivityAt)},
          ${quote(row.raw)}, ${quote(row.createdAt)}, ${quote(row.updatedAt)})
      `);
    }
  }

  if (await tableExists(context, 'agentiz_project_integrations')) {
    const links = await select(context, 'SELECT * FROM agentiz_project_integrations');
    for (const row of links) {
      await context.sequelize.query(`
        INSERT INTO ${LINKS} (id, "projectId", provider, "connectionId", "repositoryId", role,
          "isPrimary", "syncIssues", "isActive", config, "lastSyncedAt", "lastError", "createdAt", "updatedAt")
        VALUES (${quote(row.id)}, ${quote(row.projectId)}, ${quote(row.provider ?? 'gitlab')},
          ${quote(row.connectionId)}, ${quote(row.repositoryId)}, ${quote(row.role ?? 'both')},
          ${quote(row.isPrimary ?? false)}, ${quote(row.syncIssues ?? true)}, ${quote(row.isActive ?? true)},
          ${quote(row.config)}, ${quote(row.lastSyncedAt)}, ${quote(row.lastError)},
          ${quote(row.createdAt)}, ${quote(row.updatedAt)})
      `);
    }
  }
}

export async function down({ context }: { context: QI }) {
  // Structure comes back, data does not: the legacy tables this copied from are dropped by
  // 1788000000000 in the GitLab layer. Take a dump before running `up` on production.
  await context.dropTable(LINKS);
  await context.dropTable(REPOSITORIES);
  await context.dropTable(CONNECTIONS);
}
