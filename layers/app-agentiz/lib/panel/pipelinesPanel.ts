import { Op } from 'sequelize';
import { AgentProjectRepository } from '../../models/AgentProjectRepository';
import { AgentRepository } from '../../models/AgentRepository';
import { AgentRole } from '../../models/AgentRole';
import { AgentRun } from '../../models/AgentRun';
import { AgentWorker } from '../../models/AgentWorker';
import { PipelineSpec } from '../../models/PipelineSpec';
import { NotificationPolicyService } from '../../services/NotificationPolicyService';
import { sourceKindOf, verdictStageCount, type PipelineDoc, type PipelineSourceKind } from '../pipelineDraft';
import type { AgentWorkerWorkspace } from '../../types/agentiz';

/**
 * The read side of the two pipeline screens, in one place because it has two readers: the first
 * paint (`lib/panel/render.ts`) and the reload after a write (`_method=getPipelineBoard`). It sits
 * here rather than in `pipelineRoutes.ts` for the reason `runBoard.ts` and `repositoriesPanel.ts`
 * do — the panel renderer must not import a route table, which drags every service behind every
 * screen in with it.
 *
 * One answer serves the list and the editor: they are the same subject at two levels of detail,
 * and the list already has to say what a pipeline works on, which needs exactly the worker and
 * repository names the editor picks from. Asking twice would also be asking two different
 * questions — "what does this pipeline run on" answered once by the row and once by the form is
 * how the two start disagreeing.
 *
 * The spec **document** travels only for the one spec being edited. It can carry two hook scripts
 * of 64 kB each, and Inertia props travel inside the HTML of the page.
 */

export interface PanelPipelineRole {
  id: string;
  key: string;
  title: string;
  model: string | null;
  /** Which ACP agent the role runs under (`config.provider`), or null when nobody picked one. */
  provider: string | null;
}

/** A worker as the source editor needs it: where it can work, and where it may push from. */
export interface PanelPipelineWorker {
  id: string;
  name: string;
  status: string;
  workspaces: AgentWorkerWorkspace[];
  gitPushRoots: string[];
}

export interface PanelPipelineRepository {
  linkId: string;
  repositoryId: string;
  provider: string;
  pathWithNamespace: string;
  defaultBranch: string | null;
  role: string;
}

/** One row of «Пайплайны». Everything here is printable without opening the spec. */
export interface PanelPipelineRow {
  id: string;
  name: string;
  isDefault: boolean;
  isActive: boolean;
  version: number;
  matchTags: string[] | null;
  updatedAt: string | null;
  stageCount: number;
  verdictStages: number;
  sourceKind: PipelineSourceKind;
  /** Whichever half of `source` applies, so the row can name it without the whole document. */
  repositoryId: string | null;
  workspace: { workerId: string; workspaceKey: string | null; path: string | null } | null;
  hooks: { before: boolean; after: boolean };
  humanComment: boolean;
  finalAction: string;
  runCount: number;
  lastRunAt: string | null;
  /** Notification rules of this pipeline's own scope; null when it has none. */
  notify: { mute: boolean; types: number } | null;
}

export interface PanelPipelineBoard {
  specs: PanelPipelineRow[];
  roles: PanelPipelineRole[];
  workers: PanelPipelineWorker[];
  repositories: PanelPipelineRepository[];
  canConfigure: boolean;
  /** The one spec being edited, document and all. Absent on the list screen. */
  spec: (PanelPipelineRow & { spec: PipelineDoc }) | null;
}

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function rowOf(
  spec: PipelineSpec,
  stats: { runCount: number; lastRunAt: string | null },
  notify: { mute: boolean; types: number } | null,
): PanelPipelineRow {
  const doc = (spec.spec ?? { stages: [], finalAction: { type: 'none' } }) as unknown as PipelineDoc;
  const workspace = doc.source?.workspace;
  return {
    id: spec.id,
    name: spec.name,
    isDefault: spec.isDefault,
    isActive: spec.isActive,
    version: spec.version,
    matchTags: spec.matchTags ?? null,
    updatedAt: iso(spec.updatedAt),
    stageCount: (doc.stages ?? []).length,
    verdictStages: verdictStageCount(doc),
    sourceKind: sourceKindOf(doc),
    repositoryId: doc.source?.repositoryId ?? null,
    workspace: workspace
      ? {
          workerId: workspace.workerId,
          workspaceKey: workspace.workspaceKey ?? null,
          path: workspace.path ?? null,
        }
      : null,
    hooks: { before: Boolean(doc.hooks?.before), after: Boolean(doc.hooks?.after) },
    humanComment: doc.triggers?.humanComment === true,
    finalAction: String(doc.finalAction?.type ?? 'none'),
    runCount: stats.runCount,
    lastRunAt: stats.lastRunAt,
    notify,
  };
}

/** How many runs each spec of this project has produced, and when the last one started. */
async function runStatsBySpec(projectId: string): Promise<Map<string, { runCount: number; lastRunAt: string | null }>> {
  const rows = (await AgentRun.findAll({
    attributes: [
      'pipelineSpecId',
      [AgentRun.sequelize!.fn('COUNT', '*'), 'count'],
      [AgentRun.sequelize!.fn('MAX', AgentRun.sequelize!.col('createdAt')), 'last'],
    ],
    where: { projectId, pipelineSpecId: { [Op.ne]: null } },
    group: ['pipelineSpecId'],
    raw: true,
  })) as unknown as Array<{ pipelineSpecId: string; count: string | number; last: string | Date | null }>;
  return new Map(rows.map((row) => [row.pipelineSpecId, { runCount: Number(row.count), lastRunAt: iso(row.last) }]));
}

/**
 * Which pipelines carry notification rules of their own.
 *
 * On the row rather than only inside the pipeline on purpose: a muted pipeline whose silence is
 * invisible from the list is exactly the kind of thing nobody debugs. Read through
 * `NotificationPolicyService`, which resolves the same document the dispatcher does — a screen
 * reading `AGENTIZ_NOTIFY_POLICY` itself would be a second interpretation of it.
 */
async function notifyMarks(): Promise<Map<string, { mute: boolean; types: number }>> {
  try {
    const overrides = await NotificationPolicyService.listOverrides();
    return new Map(
      overrides
        .filter((entry) => entry.scope === 'pipeline' && entry.id)
        .map((entry) => [entry.id as string, { mute: entry.mute, types: entry.types.length }]),
    );
  } catch {
    // A missing badge is not worth failing the page over; the rules themselves are unaffected.
    return new Map();
  }
}

/**
 * Everything both pipeline screens read. `specId` asks for one spec's document as well; an id
 * belonging to another project answers `spec: null`, which is what the screen draws as «не
 * найден» — a spec is an entity of its project and `/projects/other/pipelines/<id>` must not open
 * one project's pipeline under another's sidebar.
 */
export async function pipelineBoard(
  projectId: string,
  options: { canConfigure: boolean; specId?: string },
): Promise<PanelPipelineBoard> {
  const [specs, roles, workers, links, stats, marks] = await Promise.all([
    PipelineSpec.findAll({ where: { projectId }, order: [['updatedAt', 'DESC']] }),
    AgentRole.findAll({ where: { projectId }, order: [['key', 'ASC']] }),
    AgentWorker.findAll({ order: [['name', 'ASC']] }),
    AgentProjectRepository.findAll({
      where: { projectId },
      order: [['createdAt', 'ASC']],
      include: [{ model: AgentRepository, as: 'repository' }],
    }),
    runStatsBySpec(projectId),
    notifyMarks(),
  ]);

  const empty: { runCount: number; lastRunAt: string | null } = { runCount: 0, lastRunAt: null };
  const rows = specs.map((spec) => rowOf(spec, stats.get(spec.id) ?? empty, marks.get(spec.id) ?? null));
  const opened = options.specId ? specs.find((spec) => spec.id === options.specId) ?? null : null;

  return {
    specs: rows,
    roles: roles.map((role) => ({
      id: role.id,
      key: role.key,
      title: role.title,
      model: role.model ?? null,
      provider: (role.config as { provider?: string } | null)?.provider ?? null,
    })),
    // The whole fleet, not just the machines with declared directories: a pipeline may name a bare
    // path on any live worker, and a revoked one still has to be nameable in a spec that already
    // points at it — otherwise the editor would silently show «воркер не выбран».
    workers: workers.map((worker) => ({
      id: worker.id,
      name: worker.name,
      status: worker.status,
      workspaces: worker.workspaces ?? [],
      gitPushRoots: worker.gitPushRoots ?? [],
    })),
    repositories: links.map((link) => ({
      linkId: link.id,
      repositoryId: link.repositoryId,
      provider: link.provider,
      pathWithNamespace: link.repository?.pathWithNamespace ?? link.repositoryId,
      defaultBranch: link.repository?.defaultBranch ?? null,
      role: link.role,
    })),
    canConfigure: options.canConfigure,
    spec: opened
      ? {
          ...rowOf(opened, stats.get(opened.id) ?? empty, marks.get(opened.id) ?? null),
          spec: (opened.spec ?? { stages: [], finalAction: { type: 'none' } }) as unknown as PipelineDoc,
        }
      : null,
  };
}

/**
 * The columns beside the spec document that `updatePipelineSpec` is allowed to write, taken from a
 * request body.
 *
 * Its shape is the whole point, and it is deliberately a pure function so it can be tested without
 * a request: a body that names none of them (which is every call the previous editor ever made)
 * produces an **empty** patch and therefore touches no column at all, and `projectId` is not in the
 * list and never will be — a pipeline spec is an entity of its project and the model refuses to
 * move it (`@BeforeSave`). An editor that offered the move would be promising something the server
 * rejects, which is the worst kind of lie a form can tell.
 */
export function pipelineRowPatch(body: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (!body) return patch;

  if (typeof body.name === 'string' && body.name.trim()) patch.name = body.name.trim();
  if (typeof body.isActive === 'boolean') patch.isActive = body.isActive;
  if (Array.isArray(body.matchTags)) {
    const tags = body.matchTags.map((tag) => String(tag).trim()).filter(Boolean);
    // An empty list and «нет тегов» are the same statement; stored as null, which is what a spec
    // that never had tags already holds.
    patch.matchTags = tags.length > 0 ? tags : null;
  }
  return patch;
}
