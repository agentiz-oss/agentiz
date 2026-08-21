import type { WorkflowSpec, WorkflowSpecProvider, WorkflowSpecRef } from '@nodeknit/app-workflow';
import { AgentWorkflowSpec } from '../../models/AgentWorkflowSpec';

/**
 * Where Agentiz keeps workflow graphs. The engine owns no tables — it reads every spec through a
 * provider — so this class is what makes a flow survive a restart, and what the canvas (and later
 * MCP) writes through: `WorkflowEngine.saveSpec` validates, calls this, then rebinds the triggers.
 *
 * No `onChange`: the only writer is the engine itself, which rebinds after every write. Editing a
 * row in the database by hand therefore takes effect on the next restart, not immediately.
 */
export class AgentizWorkflowSpecProvider implements WorkflowSpecProvider {
  readonly id = 'agentiz';
  readonly name = 'Agentiz';

  async listSpecs(): Promise<Array<Omit<WorkflowSpecRef, 'providerId'>>> {
    const rows = await AgentWorkflowSpec.findAll({ order: [['updatedAt', 'DESC']] });
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      active: row.active,
      // Descriptive link only — it is what lets a project page ask for "its" workflows.
      entity: row.projectId ? { model: 'AgentProject', id: row.projectId } : undefined,
    }));
  }

  async getSpec(specId: string): Promise<WorkflowSpec | null> {
    const row = await AgentWorkflowSpec.findByPk(specId);
    return row ? toSpec(row) : null;
  }

  async saveSpec(spec: WorkflowSpec): Promise<WorkflowSpec> {
    const row = await AgentWorkflowSpec.findByPk(spec.id);
    if (!row) throw new Error(`Воркфлоу "${spec.id}" не найдено`);
    await row.update({
      name: spec.name?.trim() || row.name,
      active: spec.active ?? row.active,
      // A run keeps the version it started on, so the counter has to move on every save.
      version: row.version + 1,
      spec: { nodes: spec.nodes ?? [], edges: spec.edges ?? [] },
    });
    return toSpec(row);
  }

  async createSpec(input: { name: string }): Promise<WorkflowSpec> {
    const row = await AgentWorkflowSpec.create({
      name: input.name?.trim() || 'Новый воркфлоу',
      // Created inactive: a half-drawn graph must not arm its triggers.
      active: false,
      version: 1,
      spec: { nodes: [], edges: [] },
      projectId: null,
    });
    return toSpec(row);
  }

  async deleteSpec(specId: string): Promise<void> {
    await AgentWorkflowSpec.destroy({ where: { id: specId } });
  }
}

function toSpec(row: AgentWorkflowSpec): WorkflowSpec {
  // The column holds whatever the engine last validated and saved, so this cast restores a shape
  // that was checked on the way in rather than asserting one that was never established.
  const graph = (row.spec ?? { nodes: [], edges: [] }) as unknown as Pick<WorkflowSpec, 'nodes' | 'edges'>;
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    active: row.active,
    nodes: graph.nodes ?? [],
    edges: graph.edges ?? [],
  };
}
