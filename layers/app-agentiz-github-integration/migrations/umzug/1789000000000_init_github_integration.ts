import { DataTypes } from 'sequelize';

/**
 * Two tables only: everything else this layer works with — connections, repositories, project
 * links — is core-owned and was created by `app-agentiz:1787000000000`.
 *
 * Numbered after that migration so a fresh database creates the core tables first; there is no
 * data dependency in this direction, but keeping the order readable matters when someone reads the
 * migration list to understand what happened when.
 */
type QI = {
  sequelize: { getDialect: () => string };
  createTable: (name: string, attrs: Record<string, unknown>) => Promise<unknown>;
  dropTable: (name: string) => Promise<unknown>;
};

const APPS = 'agentiz_github_oauth_apps';
const STATES = 'agentiz_github_oauth_states';

export async function up({ context }: { context: QI }) {
  const json = context.sequelize.getDialect() === 'postgres' ? DataTypes.JSONB : DataTypes.JSON;

  await context.createTable(APPS, {
    id: { type: DataTypes.STRING, primaryKey: true, allowNull: false },
    name: { type: DataTypes.STRING, allowNull: false },
    baseUrl: { type: DataTypes.STRING, allowNull: false },
    clientId: { type: DataTypes.STRING, allowNull: false },
    secrets: { type: json, allowNull: true },
    redirectUri: { type: DataTypes.STRING, allowNull: true },
    scopes: { type: json, allowNull: true },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    createdAt: { type: DataTypes.DATE, allowNull: true },
    updatedAt: { type: DataTypes.DATE, allowNull: true },
  });

  // No codeVerifier column: classic GitHub OAuth Apps do not support PKCE. See GithubOAuthState.
  await context.createTable(STATES, {
    id: { type: DataTypes.STRING, primaryKey: true, allowNull: false },
    state: { type: DataTypes.STRING, allowNull: false, unique: true },
    oauthAppId: { type: DataTypes.STRING, allowNull: false },
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
  await context.dropTable(STATES);
  await context.dropTable(APPS);
}
