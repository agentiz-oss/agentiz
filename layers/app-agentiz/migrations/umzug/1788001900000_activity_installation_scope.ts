import type { QueryInterface } from 'sequelize';
import { DataTypes } from 'sequelize';

const ACTIVITIES = 'agentiz_activities';

/** The two indexes `1788000300000_agent_activities` created — a sqlite rebuild drops both. */
const INDEXES: Array<{ name: string; fields: string[] }> = [
  { name: 'agentiz_activities_project_created_idx', fields: ['projectId', 'createdAt'] },
  { name: 'agentiz_activities_created_idx', fields: ['createdAt'] },
];

/**
 * `agentiz_activities.projectId` becomes nullable: an **installation** event (a new server
 * version) belongs to no project, and its feed row says so with `null` rather than borrowing some
 * project whose members would then read it. Existing rows keep their project; nothing backfills.
 *
 * This is a `changeColumn`, which on sqlite rebuilds the table (see
 * `migrations/migrationSchema.test.ts`). The hazard documented there — a composite **unique**
 * index spread over its columns — does not apply: this table has none. What a rebuild does do is
 * `DROP TABLE`, and every index goes with it, so on sqlite the two from the creating migration are
 * put back here; the schema test checks they survive.
 */
export const up = async ({ context: queryInterface }: { context: QueryInterface }): Promise<void> => {
  const table = await queryInterface.describeTable(ACTIVITIES);
  if (!table.projectId || table.projectId.allowNull) return;
  await queryInterface.changeColumn(ACTIVITIES, 'projectId', { type: DataTypes.STRING, allowNull: true });
  if (queryInterface.sequelize.getDialect() !== 'sqlite') return;

  const present = new Set(
    ((await queryInterface.showIndex(ACTIVITIES)) as Array<{ name: string }>).map((index) => index.name),
  );
  for (const index of INDEXES) {
    if (present.has(index.name)) continue;
    await queryInterface.addIndex(ACTIVITIES, index.fields, { name: index.name });
  }
};

/**
 * The constraint can only come back without the rows it was relaxed for, so those are deleted
 * first — they are notifications about deploys, not history anybody restores. On sqlite the down
 * path changes nothing: a nullable column costs less than another table rebuild.
 */
export const down = async ({ context: queryInterface }: { context: QueryInterface }): Promise<void> => {
  if (queryInterface.sequelize.getDialect() === 'sqlite') return;
  await queryInterface.bulkDelete(ACTIVITIES, { projectId: null });
  await queryInterface.changeColumn(ACTIVITIES, 'projectId', { type: DataTypes.STRING, allowNull: false });
};
