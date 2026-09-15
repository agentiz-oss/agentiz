import { describe, expect, it } from 'vitest';
import { Sequelize } from 'sequelize';
import { umzugExports } from './umzugExports';

/**
 * The same replay-on-sqlite check app-agentiz runs over its own migrations, for the one thing this
 * layer's correctness rests on: the **composite unique** index over (`endpointId`, `dedupeKey`).
 *
 * That index is not an optimisation. It is what makes a re-delivery a `duplicate` answered 200
 * instead of a second copy of an event — GitHub re-sends by hand from its deliveries page and after
 * any outage — and its absence is completely silent: every insert succeeds, and the only symptom is
 * a flow that ran twice for one push. It has to be a *table* index and not a column flag, or the
 * sqlite rebuild hazard described in AGENTS.md would spread the uniqueness onto `endpointId` and
 * leave the endpoint able to hold exactly one delivery ever.
 */
async function applyAll(): Promise<Sequelize> {
  const sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  const context = sequelize.getQueryInterface() as unknown as Parameters<typeof umzugExports[number]['up']>[0]['context'];
  for (const migration of umzugExports) {
    await migration.up({ context } as never);
  }
  return sequelize;
}

describe('webhook migrations produce a usable schema on sqlite', () => {
  it('creates both tables and no column is uniquely constrained on its own', async () => {
    const sequelize = await applyAll();
    const rows = await sequelize.query<{ name: string; sql: string }>(
      "select name, sql from sqlite_master where type='table' and name like 'agentiz_webhook%'",
      { type: 'SELECT' as never },
    );

    expect(rows.map((row) => row.name).sort()).toEqual([
      'agentiz_webhook_deliveries', 'agentiz_webhook_endpoints',
    ]);
    const deliveries = rows.find((row) => row.name === 'agentiz_webhook_deliveries')!.sql;
    // `endpointId` alone unique would mean one delivery per endpoint, forever.
    expect(/`endpointId`[^,]*\bUNIQUE\b/.test(deliveries)).toBe(false);
    expect(/`dedupeKey`[^,]*\bUNIQUE\b/.test(deliveries)).toBe(false);
    await sequelize.close();
  });

  it('the delivery dedupe index is composite and unique', async () => {
    const sequelize = await applyAll();
    const indexes = await sequelize.query<{ name: string; sql: string | null }>(
      "select name, sql from sqlite_master where type='index' and tbl_name='agentiz_webhook_deliveries'",
      { type: 'SELECT' as never },
    );

    const dedupe = indexes.find((row) => row.name === 'agentiz_webhook_deliveries_endpoint_dedupe');
    expect(dedupe).toBeTruthy();
    expect(dedupe!.sql).toMatch(/UNIQUE/i);
    expect(dedupe!.sql).toMatch(/endpointId/);
    expect(dedupe!.sql).toMatch(/dedupeKey/);
    await sequelize.close();
  });

  it('refuses a second delivery with the same id on one endpoint, and allows it on another', async () => {
    const sequelize = await applyAll();
    const insert = (endpointId: string, dedupeKey: string) => sequelize.query(
      'insert into agentiz_webhook_deliveries (id, "endpointId", outcome, "dedupeKey", "httpStatus")'
      + ` values ('${endpointId}-${dedupeKey}', '${endpointId}', 'accepted', '${dedupeKey}', 200)`,
    );

    await insert('e1', 'd1');
    await expect(sequelize.query(
      `insert into agentiz_webhook_deliveries (id, "endpointId", outcome, "dedupeKey", "httpStatus")`
      + ` values ('other', 'e1', 'accepted', 'd1', 200)`,
    )).rejects.toThrow();
    // Two senders numbering their deliveries from the same counter must not collide.
    await expect(insert('e2', 'd1')).resolves.toBeTruthy();
    await sequelize.close();
  });
});
