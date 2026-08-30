import { describe, expect, it } from 'vitest';
import { DataTypes, Sequelize } from 'sequelize';
import { umzugExports } from './umzugExports';

/**
 * Replays **every** migration on an empty sqlite database and looks at the schema that comes out.
 *
 * This exists because of a failure mode that neither a green migration run nor a passing unit test
 * catches: on sqlite, `changeColumn` and `removeColumn` rebuild the whole table, and sequelize
 * reconstructs the old shape through `describeTable`, which copies a **composite** unique index's
 * `unique` flag onto **every** column of that index
 * (`node_modules/sequelize/lib/dialects/sqlite/query-interface.js`). One such call in
 * `1787000500000_run_interactions` was enough to leave `agentiz_tasks.projectId` and
 * `agentiz_stage_executions.stageIndex` uniquely constrained — a database that holds one task per
 * project and one stage per run, on a **fresh** install, with every migration reporting success.
 *
 * So the assertion is not "migrations run" (they always did) but "the schema they produce is the
 * one the models expect". `addColumn` is safe and needs no care; the two rebuilding verbs do, and
 * this test is what says so when somebody adds the next one.
 */

/**
 * Columns that are legitimately unique on their own — declared `unique: true` on the column in
 * both the model and the migration that created it. A **single**-column unique index rendering as
 * a column-level `UNIQUE` after a rebuild is correct; the bug this test guards is a **composite**
 * one being spread over its members.
 */
const INTENTIONALLY_UNIQUE: Record<string, string[]> = {
  agentiz_projects: ['slug'],
  // One live registration per machine, one live token per worker.
  agentiz_workers: ['instanceId', 'tokenHash'],
  // A workspace path is held by at most one proposal — the whole reservation mechanism.
  agentiz_workspace_proposals: ['reservationKey'],
};

/** Parsed out of `sqlite_master`: which columns carry a column-level `UNIQUE`. */
function uniqueColumns(createSql: string): string[] {
  const body = createSql.slice(createSql.indexOf('(') + 1);
  return [...body.matchAll(/`([A-Za-z0-9_]+)`[^,]*?\bUNIQUE\b/g)]
    .map((match) => match[1])
    // The primary key is rendered as `NOT NULL UNIQUE PRIMARY KEY` by some paths and plain
    // `PRIMARY KEY` by others; either way it is not what this test is about.
    .filter((column) => !new RegExp(`\`${column}\`[^,]*PRIMARY KEY`).test(body));
}

async function applyAll(): Promise<Sequelize> {
  const sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  const context = sequelize.getQueryInterface() as unknown as Parameters<typeof umzugExports[number]['up']>[0]['context'];
  for (const migration of umzugExports) {
    await migration.up({ context } as never);
  }
  return sequelize;
}

describe('migrations produce a usable schema on sqlite', () => {
  it('every migration applies to an empty database', async () => {
    const sequelize = await applyAll();
    const tables = await sequelize.query<{ name: string }>(
      "select name from sqlite_master where type='table' and name like 'agentiz%'",
      { type: 'SELECT' as never },
    );
    expect(tables.length).toBeGreaterThan(20);
    await sequelize.close();
  });

  it('no column is uniquely constrained by accident', async () => {
    const sequelize = await applyAll();
    const rows = await sequelize.query<{ name: string; sql: string }>(
      "select name, sql from sqlite_master where type='table' and name like 'agentiz%'",
      { type: 'SELECT' as never },
    );

    const offenders: Record<string, string[]> = {};
    for (const row of rows) {
      const unexpected = uniqueColumns(row.sql ?? '')
        .filter((column) => !(INTENTIONALLY_UNIQUE[row.name] ?? []).includes(column));
      if (unexpected.length > 0) offenders[row.name] = unexpected;
    }

    // Named explicitly rather than as a count: when this fails, the message has to say which
    // column, because the fix is always "that migration rebuilt this table on sqlite".
    expect(offenders).toEqual({});
    await sequelize.close();
  });

  it('a project can hold two tasks and a run two stages — the shape the models rely on', async () => {
    const sequelize = await applyAll();
    const now = new Date().toISOString();
    await sequelize.query(
      `insert into agentiz_projects (id, name, slug, createdAt, updatedAt) values ('p','P','p','${now}','${now}')`,
    );
    for (const [id, external] of [['t1', 'a'], ['t2', 'b']]) {
      await sequelize.query(
        `insert into agentiz_tasks (id, projectId, externalId, title, status, priority, createdAt, updatedAt)`
        + ` values ('${id}','p','${external}','T','new','normal','${now}','${now}')`,
      );
    }
    await sequelize.query(
      `insert into agentiz_runs (id, taskId, projectId, status, trigger, currentStageIndex, pipelineSnapshot, createdAt, updatedAt)`
      + ` values ('r','t1','p','pending','manual',0,'{}','${now}','${now}')`,
    );
    for (const index of [0, 1]) {
      await sequelize.query(
        `insert into agentiz_stage_executions (id, runId, stageIndex, role, status, createdAt, updatedAt)`
        + ` values ('s${index}','r',${index},'dev','pending','${now}','${now}')`,
      );
    }

    const [tasks] = await sequelize.query<{ n: number }>(
      "select count(*) as n from agentiz_tasks where projectId = 'p'", { type: 'SELECT' as never },
    );
    const [stages] = await sequelize.query<{ n: number }>(
      "select count(*) as n from agentiz_stage_executions where runId = 'r'", { type: 'SELECT' as never },
    );
    expect(tasks.n).toBe(2);
    expect(stages.n).toBe(2);
    await sequelize.close();
  });

  it('the composite unique indexes the models depend on are still there', async () => {
    const sequelize = await applyAll();
    const indexes = await sequelize.query<{ name: string }>(
      "select name from sqlite_master where type='index'", { type: 'SELECT' as never },
    );
    const names = indexes.map((index) => index.name);
    // Losing these would be the opposite mistake: a schema that accepts two tasks with the same
    // external id, which is how a tracker sync starts duplicating everything it pulls.
    expect(names).toContain('agentiz_tasks_project_external_id_unique');
    expect(names).toContain('agentiz_stage_executions_run_stage_index_unique');
    expect(names).toContain('agentiz_roles_project_key_unique');
    await sequelize.close();
  });

  it('DataTypes is importable here — the migrations are typed against sequelize, not the models', () => {
    expect(DataTypes.STRING).toBeDefined();
  });
});
