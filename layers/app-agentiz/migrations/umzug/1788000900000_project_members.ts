import { DataTypes } from 'sequelize';

type QI = {
  createTable: (table: string, attributes: Record<string, unknown>) => Promise<unknown>;
  dropTable: (table: string) => Promise<unknown>;
  addIndex: (table: string, fields: string[], options?: Record<string, unknown>) => Promise<unknown>;
  removeIndex: (table: string, index: string) => Promise<unknown>;
};

const MEMBERS = 'agentiz_project_members';

/**
 * Project membership: project × person × role group (see models/AgentProjectMember.ts).
 *
 * Schema only. The role groups themselves and the owner's membership row are **seeded from
 * `AppAgentiz.mount()`** (lib/access/roleSeed.ts) rather than from here, for one reason: this
 * migration does not run in development at all (`MigrationHandler` skips unless
 * `NODE_ENV=production` or `USE_MIGRATIONS=true`, because dev syncs the models instead), and a
 * boundary that exists only on one of the two setups is worse than no boundary. The seeding is
 * idempotent and matches groups by name, so running it on every boot changes nothing after the
 * first.
 *
 * The unique index is `(projectId, userId, groupId)` — one person may legitimately hold two roles
 * in a project; what must not happen twice is the same role. The read indexes follow the two
 * questions actually asked: "what may this person do here" (`projectId, userId`) and "which
 * projects are theirs" (`userId`).
 */
export async function up({ context }: { context: QI }) {
  await context.createTable(MEMBERS, {
    id: { type: DataTypes.STRING, primaryKey: true },
    projectId: { type: DataTypes.STRING, allowNull: false },
    userId: { type: DataTypes.INTEGER, allowNull: false },
    groupId: { type: DataTypes.INTEGER, allowNull: false },
    grantedByUserId: { type: DataTypes.INTEGER, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false },
    updatedAt: { type: DataTypes.DATE, allowNull: false },
  });
  await context.addIndex(MEMBERS, ['projectId', 'userId', 'groupId'], {
    name: 'agentiz_project_members_unique_idx',
    unique: true,
  });
  await context.addIndex(MEMBERS, ['projectId', 'userId'], { name: 'agentiz_project_members_project_idx' });
  await context.addIndex(MEMBERS, ['userId'], { name: 'agentiz_project_members_user_idx' });
}

export async function down({ context }: { context: QI }) {
  await context.removeIndex(MEMBERS, 'agentiz_project_members_user_idx');
  await context.removeIndex(MEMBERS, 'agentiz_project_members_project_idx');
  await context.removeIndex(MEMBERS, 'agentiz_project_members_unique_idx');
  await context.dropTable(MEMBERS);
}
