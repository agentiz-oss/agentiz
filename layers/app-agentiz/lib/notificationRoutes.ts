import type { AdminizerRouteMiddleware } from '@nodeknit/app-adminizer';
import { NotificationPolicyService, type PolicyScopeRef } from '../services/NotificationPolicyService';

/**
 * The notification policy in the panel: the `defaults` scope on its own page, plus the endpoints
 * every scope editor uses — the project card (AgentizHome), the pipeline editor (AgentizPipelines)
 * and this page are the same component pointed at different scopes, so they share one route.
 *
 * The page also lists **where the document is overridden**. Nothing else ever walks it, and an
 * override made months ago inside a project card is otherwise unfindable — silence with no visible
 * cause is the thing that makes a notification system untrustworthy.
 */

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** `scope`/`id` off a query string or a body, as the scope editor sends them. */
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
        if (method !== 'setScope') return res.status(400).json({ message: `Unknown _method: ${method || '(none)'}` });

        // One scope at a time: patchScope merges into the stored document, so two editors open at
        // once do not overwrite each other. `entry: null` drops the scope back to inheritance.
        const entry = req.body?.entry ?? null;
        return res.json({ data: await NotificationPolicyService.patchScope(scopeRef(req.body), entry) });
      } catch (error: any) {
        return res.status(400).json({ message: error?.message ?? String(error) });
      }
    },
  },
];
