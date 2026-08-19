import type { IMcpTool } from '@nodeknit/app-mcp';
import { NotificationPolicyService } from '../services/NotificationPolicyService';
import { activityTypes } from '../lib/notifications/activityTypes';
import { notifyPolicyJsonSchema, type NotifyPolicyDocument } from '../lib/notifications/policySettings';

/**
 * The notification policy over MCP: read what applies and from where, and replace the document
 * without a deploy. The activity feed itself is untouched by any of this — the policy filters
 * delivery (push/bell) only, which is exactly what makes "выключил и не потерял историю" true.
 */

function objectParams(params: unknown): Record<string, unknown> {
  return params !== null && typeof params === 'object' && !Array.isArray(params) ? params as Record<string, unknown> : {};
}

const manageNotificationPolicyTool: IMcpTool = {
  name: 'agentiz.manageNotificationPolicy',
  group: 'agentiz-actions',
  shortDescription: 'Reads or replaces the notification policy (AGENTIZ_NOTIFY_POLICY).',
  description: [
    'action=describe returns the effective policy document, its source (environment/settings/unset),',
    'the built-in per-type defaults and the type catalogue.',
    'action=set replaces the stored document with `document` (or removes it when document is null);',
    'entries for projects/pipelines whose id no longer exists are pruned and reported.',
    'Scopes resolve pipelines → projects → defaults → built-in, per channel; `mute: true` in a scope',
    'switches everything off below more specific entries.',
    `Event types: ${activityTypes().map((def) => def.type).join(', ')}.`,
    'The activity feed is always written — this only filters push and dashboard delivery.',
  ].join(' '),
  mode: 'protected',
  inputSchema: {
    type: 'object',
    required: ['action'],
    properties: {
      action: { enum: ['describe', 'set'] },
      document: {
        ...notifyPolicyJsonSchema(),
        description: 'The complete policy document for action=set. Pass null to remove the stored document.',
      },
    },
  },
  async handler(params) {
    const payload = objectParams(params);
    const action = String(payload.action ?? 'describe');
    if (action === 'describe') return NotificationPolicyService.describe();
    if (action !== 'set') throw new Error(`Unknown action "${action}"; use describe or set`);
    if (!('document' in payload)) throw new Error('action=set requires `document` (an object, or null to remove)');
    const document = payload.document;
    if (document !== null && (typeof document !== 'object' || Array.isArray(document))) {
      throw new Error('`document` must be an object or null');
    }
    return NotificationPolicyService.set(document as NotifyPolicyDocument | null);
  },
};

export const notificationPolicyMcpTools: IMcpTool[] = [manageNotificationPolicyTool];
