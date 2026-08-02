import { QueryTypes } from 'sequelize';
import { randomUUID } from 'crypto';

/**
 * Some projects ended up with a PipelineSpec row whose `spec` has no `stages` (e.g. `{}`), created
 * before PipelineSpecResolver started rejecting that shape at run time. Such a project can never
 * run a task — `resolveSpecForTask` finds the spec, `assertValidSpec` throws, every run fails
 * before the first stage. Give each of those specs a minimal working stub pipeline (creating the
 * `stub` AgentRole it references, if the project doesn't already have one) so tasks stop being
 * silently unrunnable. Specs that already declare real stages are left untouched.
 */
type QI = {
  sequelize: {
    query: (sql: string, options: Record<string, unknown>) => Promise<unknown>;
  };
};

const ROLE_TABLE = 'agentiz_roles';
const SPEC_TABLE = 'agentiz_pipeline_specs';
const STUB_ROLE_KEY = 'stub';

function hasStages(spec: unknown): boolean {
  const stages = (spec as { stages?: unknown } | null)?.stages;
  return Array.isArray(stages) && stages.length > 0;
}

export async function up({ context }: { context: QI }) {
  const specs = (await context.sequelize.query(`SELECT id, "projectId", spec FROM ${SPEC_TABLE}`, {
    type: QueryTypes.SELECT,
  })) as Array<{ id: string; projectId: string; spec: unknown }>;

  for (const row of specs) {
    const spec = typeof row.spec === 'string' ? JSON.parse(row.spec) : row.spec;
    if (hasStages(spec)) continue;

    const existingRoles = (await context.sequelize.query(
      `SELECT id FROM ${ROLE_TABLE} WHERE "projectId" = :projectId AND key = :key`,
      { replacements: { projectId: row.projectId, key: STUB_ROLE_KEY }, type: QueryTypes.SELECT },
    )) as Array<{ id: string }>;

    if (existingRoles.length === 0) {
      await context.sequelize.query(
        `INSERT INTO ${ROLE_TABLE}
           (id, "projectId", key, title, "systemPrompt", model, "allowedTools", config, "createdAt", "updatedAt")
         VALUES
           (:id, :projectId, :key, :title, :systemPrompt, NULL, :allowedTools, :config, NOW(), NOW())`,
        {
          replacements: {
            id: randomUUID(),
            projectId: row.projectId,
            key: STUB_ROLE_KEY,
            title: 'Stub executor',
            systemPrompt: 'Выполни задачу и опиши, что было сделано.',
            allowedTools: JSON.stringify([]),
            config: JSON.stringify({ executor: 'stub' }),
          },
          type: QueryTypes.INSERT,
        },
      );
    }

    const fixedSpec = {
      stages: [{ order: 1, role: 'execute', agentRoleKey: STUB_ROLE_KEY, onFail: 'stop' }],
      finalAction: { type: 'none' },
    };

    await context.sequelize.query(`UPDATE ${SPEC_TABLE} SET spec = :spec, "updatedAt" = NOW() WHERE id = :id`, {
      replacements: { id: row.id, spec: JSON.stringify(fixedSpec) },
      type: QueryTypes.UPDATE,
    });
  }
}

export async function down() {
  // Data repair only, not reversible: the original empty/invalid spec content isn't recoverable.
}
