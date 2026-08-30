/**
 * The `accessGraph` declaration — record-level access for everything that belongs to a project,
 * written once.
 *
 * `AgentProject` is the root; a person reaches it through an `AgentProjectMember` row, and that
 * row's `group` — an ordinary panel group used as a per-project role — decides which actions the
 * membership counts for: adminizer checks the CRUD token of the model being read
 * (`read-agenttask-model`, …) against that group. Everything below the root inherits its reach down
 * `parent` edges, transitively where there is no direct column (comments and attachments through
 * their task, stage executions through their run). Those three had no record scope at all before,
 * and the graph closes them for free.
 *
 * `parent` names an **association alias**, not a column, and the parent model must itself be in the
 * graph — hence tasks and runs above their children. The root needs no edge.
 *
 * ## Why this is installed from `mount()` and not written in `config/adminizer.ts`
 *
 * Because `Adminizer.init()` calls `validateAccessGraph`, and that **throws** on a root model that
 * is not registered — while every Agentiz model reaches the panel *after* init, through the
 * `adminizerModelConfigs` collection (`AdminizerModelConfigHandler.process` → `modelHandler.add`).
 * A graph declared in the root config therefore kills the boot with
 * `root model "AgentProject" is not registered`, and takes app-adminizer and every layer that
 * depends on it down with it.
 *
 * Installing it here, immediately after that collection has been appended, hits the same code path
 * from the other side: the compiled graph is cached per (`config.accessGraph` identity ×
 * `registryVersion`), so assigning the declaration once the models exist compiles it on the first
 * read with nothing missing. What is given up is the boot-time structural check, which is why
 * `accessGraph.test.ts` asserts the things that check would have caught — every `parent` reaching a
 * model inside the graph, and every model of the graph actually registered.
 *
 * The internal allowlists follow by themselves: `configureInternalAccess` stamps an epoch, every
 * `modelHandler.add` bumps the registry's, and the mismatch makes the next internal read rebuild
 * the map from the config as it is *then* — which is after this assignment, because nothing serves
 * a request until every app has mounted.
 *
 * ## One declaration, and it stays one
 *
 * A model of a *new* layer is added to the object below, not declared by that layer. Layer configs
 * reach adminizer through the `adminizerConfigs` collection, whose handler rebuilds from the
 * default and merges shallowly (`ConfigProcessor.updateConfig`), so a second contributor would
 * erase the first's graph whole. Wanting the opposite means fixing that handler, not splitting the
 * graph.
 */

import type { AccessGraphConfig } from 'adminizer';
import { GLOBAL_TOKENS } from './tokens';

export const AGENTIZ_GRAPH_KEY = 'agentiz';

export const AGENTIZ_ACCESS_GRAPH: AccessGraphConfig = {
  root: 'AgentProject',
  membership: { through: 'AgentProjectMember', via: 'user', group: 'group' },
  // Matched against the user's own global groups only. On a role group it does nothing, which is
  // the point: a project role must not be able to widen its own boundary.
  bypassToken: GLOBAL_TOKENS.projectAdmin,
  include: {
    // A direct edge to the root — each of these carries its own projectId column.
    AgentTask: { parent: 'project' },
    AgentRun: { parent: 'project' },
    AgentRunLog: { parent: 'project' },
    AgentRunDiff: { parent: 'project' },
    AgentRunInteraction: { parent: 'project' },
    AgentRunJob: { parent: 'project' },
    AgentWorkspaceProposal: { parent: 'project' },
    AgentProjectRepository: { parent: 'project' },
    AgentTaskSource: { parent: 'project' },
    PipelineSpec: { parent: 'project' },
    AgentRole: { parent: 'project' },
    AgentActivity: { parent: 'project' },
    // Transitive — no project column of their own, and no scope at all before this.
    AgentTaskComment: { parent: 'task' },
    AgentTaskAttachment: { parent: 'task' },
    AgentStageExecution: { parent: 'run' },
  },
  // Both performance stages are deliberately off. By default a read costs one query per level of
  // the chain and inlines every intermediate id the person can reach into the last of them, so the
  // price grows with the size of the account rather than of the page. `pushdown: true` is the first
  // thing to try when that starts to hurt — it is one line and needs no column.
};

/** Minimal shape of what `install` needs; typing the whole Adminizer here would buy nothing. */
interface GraphHost {
  config?: { accessGraph?: Record<string, AccessGraphConfig> };
  modelHandler?: { getResourceRecord(resourceName: string): unknown };
}

/**
 * Hands the graph to a running panel. Call **after** the layer's models have been registered.
 *
 * Returns the models it could not find, so the caller can say so out loud: an unregistered model in
 * `include` is adminizer's one fail-soft branch (a warning, and the model stays outside the
 * boundary), and a warning that becomes the last word about a model is exactly how a hole gets
 * missed. An unregistered *root* or membership model is worse than that — the graph would deny its
 * own models — so those are named separately.
 */
export function installAgentizAccessGraph(adminizer: GraphHost): { missing: string[]; blocking: string[] } {
  if (!adminizer.config) return { missing: [], blocking: [] };

  const resolves = (name: string) => Boolean(adminizer.modelHandler?.getResourceRecord(name));
  const blocking = [AGENTIZ_ACCESS_GRAPH.root, AGENTIZ_ACCESS_GRAPH.membership!.through].filter((name) => !resolves(name));
  const missing = Object.keys(AGENTIZ_ACCESS_GRAPH.include ?? {}).filter((name) => !resolves(name));

  adminizer.config.accessGraph = {
    ...(adminizer.config.accessGraph ?? {}),
    [AGENTIZ_GRAPH_KEY]: AGENTIZ_ACCESS_GRAPH,
  };

  return { missing, blocking };
}
