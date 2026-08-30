import type { AdminizerRouteMiddleware } from '@nodeknit/app-adminizer';
import { NotificationPolicyService, type PolicyScopeRef } from '../services/NotificationPolicyService';
import { PipelineSpec } from '../models/PipelineSpec';
import { guardGlobal, guardProject, requirePanelUser } from './access/panelGuard';
import { GLOBAL_TOKENS, PROJECT_TOKENS } from './access/tokens';

/**
 * The notification policy in the panel: the `defaults` scope on its own page, plus the endpoints
 * every scope editor uses — the project card (AgentizHome), the pipeline editor (AgentizPipelines)
 * and this page are the same component pointed at different scopes, so they share one route.
 *
 * The page also lists **where the document is overridden**. Nothing else ever walks it, and an
 * override made months ago inside a project card is otherwise unfindable — silence with no visible
 * cause is the thing that makes a notification system untrustworthy.
 *
 * A scope is guarded by what it names. `project` and `pipeline` are `project-configure` in the
 * project they belong to — a pipeline scope resolves through its spec's `projectId`, which is the
 * only place the pipeline's project is written down. The `defaults` scope belongs to nobody's
 * project and is therefore global: `agentiz-notifications-manage`, or an administrator.
 */

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** `scope`/`id` off a query string or a body, as the scope editor sends them. */
/**
 * Whether the caller may *edit* this scope. Reading it is deliberately looser — the editor shows
 * the resolved values wherever it is opened, and hiding them would only make "почему не пришло"
 * harder without hiding anything a person could not infer.
 */
async function mayEditScope(req: any, res: any, ref: PolicyScopeRef): Promise<boolean> {
  if (ref.scope === 'defaults') {
    return guardGlobal(req, res, GLOBAL_TOKENS.notificationsManage, 'Недостаточно прав, чтобы менять общие правила уведомлений');
  }
  if (ref.scope === 'project') return guardProject(req, res, ref.id, PROJECT_TOKENS.projectConfigure);

  // A pipeline scope carries only the spec id; its project is on the spec, and that is the only
  // place it is recorded — `AgentTask.pipelineSpecId` names the latest run's spec, not the owner.
  const spec = await PipelineSpec.findByPk(ref.id);
  if (!spec) {
    res.status(404).json({ message: 'Pipeline Spec not found' });
    return false;
  }
  return guardProject(req, res, spec.projectId, PROJECT_TOKENS.projectConfigure);
}

function scopeRef(input: any): PolicyScopeRef {
  const scope = str(input?.scope) || 'defaults';
  if (scope === 'defaults') return { scope: 'defaults' };
  const id = str(input?.id);
  if (!id) throw new Error(`scope=${scope} requires an id`);
  if (scope === 'project') return { scope: 'project', id };
  if (scope === 'pipeline') return { scope: 'pipeline', id };
  throw new Error(`Unknown scope "${scope}"; use defaults, project or pipeline`);
}

export const notificationRoutes: AdminizerRouteMiddleware[] = [
  {
    route: '/agentiz-notifications',
    method: 'get',
    handler: async (req, res) => {
      const method = str(req.query._method);
      if (!requirePanelUser(req, res)) return undefined;

      try {
        if (method === 'getScope') {
          return res.json({ data: await NotificationPolicyService.describeScope(scopeRef(req.query)) });
        }

        if (method === 'getOverrides') {
          return res.json({ data: await NotificationPolicyService.listOverrides() });
        }
      } catch (error: any) {
        return res.status(400).json({ message: error?.message ?? String(error) });
      }

      return req.Inertia.render({
        component: 'module',
        props: { moduleComponent: '/dashboard/modules/AgentizNotifications.js' },
      });
    },
  },
  {
    route: '/agentiz-notifications',
    method: 'post',
    handler: async (req, res) => {
      try {
        const method = str(req.body?._method);
        if (!requirePanelUser(req, res)) return undefined;
        if (method !== 'setScope') return res.status(400).json({ message: `Unknown _method: ${method || '(none)'}` });

        const ref = scopeRef(req.body);
        if (!await mayEditScope(req, res, ref)) return undefined;

        // One scope at a time: patchScope merges into the stored document, so two editors open at
        // once do not overwrite each other. `entry: null` drops the scope back to inheritance.
        const entry = req.body?.entry ?? null;
        return res.json({ data: await NotificationPolicyService.patchScope(ref, entry) });
      } catch (error: any) {
        return res.status(400).json({ message: error?.message ?? String(error) });
      }
    },
  },
];
