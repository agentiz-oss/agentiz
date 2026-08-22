import type {
  WorkflowSpec,
  WorkflowSpecEntity,
  WorkflowSpecProvider,
  WorkflowSpecRef,
} from '@nodeknit/app-workflow';
import { AgentProject } from '../../models/AgentProject';
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
    // One query for the names, not one per flow: the label is what the canvas filter groups by,
    // so it is read on every listing.
    const names = await projectNames(rows.map((row) => row.projectId));
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      active: row.active,
      // Descriptive link only — it is what lets a project page ask for "its" workflows.
      entity: entityOf(row, names),
    }));
  }

  async getSpec(specId: string): Promise<WorkflowSpec | null> {
    const row = await AgentWorkflowSpec.findByPk(specId);
    if (!row) return null;
    return toSpec(row, await projectNames([row.projectId]));
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
      // Absent `entity` means "unchanged", not "unbind": the editor posts back a graph and says
      // nothing about the binding, and a save from there must not silently orphan the flow.
      ...(spec.entity === undefined ? {} : { projectId: projectIdOf(spec.entity) }),
    });
    return toSpec(row, await projectNames([row.projectId]));
  }

  async createSpec(input: { name: string; entity?: WorkflowSpecEntity }): Promise<WorkflowSpec> {
    const row = await AgentWorkflowSpec.create({
      name: input.name?.trim() || 'Новый воркфлоу',
      // Created inactive: a half-drawn graph must not arm its triggers.
      active: false,
      version: 1,
      spec: { nodes: [], edges: [] },
      // Created from a project's own screen ⇒ bound to it; from the general list ⇒ unbound.
      projectId: projectIdOf(input.entity),
    });
    return toSpec(row, await projectNames([row.projectId]));
  }

  async deleteSpec(specId: string): Promise<void> {
    await AgentWorkflowSpec.destroy({ where: { id: specId } });
  }
}

/**
 * The binding, as the canvas shows it: only `AgentProject` means anything here, so anything else
 * an editor might post is read as "no project" rather than stored as a dangling reference.
 */
function projectIdOf(entity: WorkflowSpecEntity | null | undefined): string | null {
  if (!entity || entity.model !== 'AgentProject') return null;
  const id = String(entity.id ?? '').trim();
  return id || null;
}

/** Names for the ids that have one; a project deleted since keeps the flow, minus its label. */
async function projectNames(ids: Array<string | null>): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => !!id))];
  if (wanted.length === 0) return new Map();
  const projects = await AgentProject.findAll({ where: { id: wanted } });
  return new Map(projects.map((project) => [project.id, project.name]));
}

function entityOf(row: AgentWorkflowSpec, names: Map<string, string>): WorkflowSpecEntity | undefined {
  if (!row.projectId) return undefined;
  return {
    model: 'AgentProject',
    id: row.projectId,
    label: names.get(row.projectId) ?? `Проект ${row.projectId}`,
    url: `/dashboard/agentiz?projectId=${encodeURIComponent(row.projectId)}`,
  };
}

function toSpec(row: AgentWorkflowSpec, names: Map<string, string> = new Map()): WorkflowSpec {
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
    entity: entityOf(row, names),
  };
}
