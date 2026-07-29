import { DataTypes, QueryTypes } from 'sequelize';

/**
 * Worker onboarding moved into the admin panel, GitLab-runner style: an admin creates the worker,
 * the panel shows its token once, and the worker is started with that token. There is no
 * self-enrollment and no approval step any more, so:
 *
 * - `instanceId` becomes nullable — the record exists before any machine has claimed it, and the
 *   worker reports the id on its first call;
 * - `approvedAt`/`approvedBy` lose their meaning and give way to `createdBy`;
 * - leftover `pending`/`disabled` rows collapse into `paused` (they hold a token but get no jobs).
 *
 * Every step checks the current shape first: a development database may already carry part of this
 * change from an earlier revision of the migration, and re-adding a column is a hard error.
 */
type QI = {
  sequelize: {
    getDialect: () => string;
    query: (sql: string, options: Record<string, unknown>) => Promise<unknown>;
  };
  describeTable: (table: string) => Promise<Record<string, unknown>>;
  addColumn: (table: string, column: string, attr: Record<string, unknown>) => Promise<unknown>;
  removeColumn: (table: string, column: string) => Promise<unknown>;
  changeColumn: (table: string, column: string, attr: Record<string, unknown>) => Promise<unknown>;
};

const TABLE = 'agentiz_workers';

async function columns(context: QI): Promise<Record<string, any>> {
  return (await context.describeTable(TABLE)) as Record<string, any>;
}

async function remapStatus(context: QI, from: string[], to: string) {
  await context.sequelize.query(`UPDATE ${TABLE} SET status = :to WHERE status IN (:from)`, {
    replacements: { to, from },
    type: QueryTypes.UPDATE,
  });
}

export async function up({ context }: { context: QI }) {
  const existing = await columns(context);

  if (!existing.createdBy) {
    await context.addColumn(TABLE, 'createdBy', { type: DataTypes.STRING, allowNull: true });
  }
  if (existing.instanceId?.allowNull === false) {
    await context.changeColumn(TABLE, 'instanceId', {
      type: DataTypes.STRING,
      allowNull: true,
      unique: true,
    });
  }

  await remapStatus(context, ['pending', 'disabled'], 'paused');

  for (const column of ['approvedAt', 'approvedBy']) {
    if (existing[column]) await context.removeColumn(TABLE, column);
  }
}

export async function down({ context }: { context: QI }) {
  const existing = await columns(context);

  if (!existing.approvedAt) {
    await context.addColumn(TABLE, 'approvedAt', { type: DataTypes.DATE, allowNull: true });
  }
  if (!existing.approvedBy) {
    await context.addColumn(TABLE, 'approvedBy', { type: DataTypes.STRING, allowNull: true });
  }

  await remapStatus(context, ['paused'], 'disabled');

  if (existing.createdBy) await context.removeColumn(TABLE, 'createdBy');

  // Rows created by the panel-driven flow may have no instanceId; give them a placeholder so the
  // column can go back to NOT NULL.
  await context.sequelize.query(
    `UPDATE ${TABLE} SET "instanceId" = 'unbound-' || id WHERE "instanceId" IS NULL`,
    { type: QueryTypes.UPDATE },
  );
  await context.changeColumn(TABLE, 'instanceId', {
    type: DataTypes.STRING,
    allowNull: false,
    unique: true,
  });
}
