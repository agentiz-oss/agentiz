import type { IMcpTool } from '@nodeknit/app-mcp';
import { PUSH_SETTING_KEYS } from '../lib/push/settings';
import { PushSettingsService } from '../services/PushSettingsService';

/**
 * Push configuration over MCP.
 *
 * Reading it is diagnosis: "the notification did not arrive" has four or five infrastructure causes
 * before it has an interesting one, and every one of them is visible in which settings are set and
 * where they came from. Writing it is administration: this installation's `.env` is behind a deploy,
 * and a credential that can only be installed by editing a file and restarting is a credential that
 * stays broken until somebody has a shell.
 *
 * The values are write-only — nothing here returns a stored secret, only whether it is present.
 */

function objectParams(params: unknown): Record<string, unknown> {
  return params !== null && typeof params === 'object' && !Array.isArray(params) ? params as Record<string, unknown> : {};
}

const settingsDescription = `Push notification settings and their sources. Keys: ${PUSH_SETTING_KEYS.join(', ')}.`;

const pushSettingsTool: IMcpTool = {
  name: 'agentiz.pushSettings',
  group: 'agentiz',
  shortDescription: 'Shows which push settings are configured, and from where.',
  description: `${settingsDescription} Reports for each setting whether it comes from the database or the environment, whether push is currently able to deliver, and warnings about configurations that cannot work (gateway selected without a URL, a missing service account). Credential values are masked and never returned.`,
  mode: 'protected',
  inputSchema: { type: 'object', properties: {} },
  async handler() {
    return PushSettingsService.describe();
  },
};

const managePushSettingsTool: IMcpTool = {
  name: 'agentiz.managePushSettings',
  group: 'agentiz-actions',
  shortDescription: 'Sets or removes push settings; takes effect without a restart.',
  description: [
    'Installs push credentials and switches. Pass `settings` as an object of key/value pairs;',
    'a value of null removes the setting, which falls back to the environment variable of the same name.',
    `Known keys: ${PUSH_SETTING_KEYS.join(', ')}.`,
    'AGENTIZ_FCM_SERVICE_ACCOUNT takes the service-account JSON itself or a path to it.',
    'Values are validated before being stored and applied immediately — the next notification uses them, no restart.',
    'This writes credentials to the database; they cannot be read back afterwards.',
  ].join(' '),
  mode: 'protected',
  inputSchema: {
    type: 'object',
    required: ['settings'],
    properties: {
      settings: {
        type: 'object',
        description: 'Key/value pairs to set. Use null as a value to remove a setting.',
        additionalProperties: { type: ['string', 'null'] },
      },
      updatedBy: { type: 'string', description: 'Who is making the change, recorded on the row.' },
    },
  },
  async handler(params) {
    const payload = objectParams(params);
    const settings = payload.settings;
    if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) {
      throw new Error('settings:object is required, e.g. {"PUSH_PROVIDER":"gateway"}');
    }
    const values: Record<string, string | null> = {};
    for (const [key, value] of Object.entries(settings as Record<string, unknown>)) {
      if (value === null) values[key] = null;
      else if (typeof value === 'string' || typeof value === 'number') values[key] = String(value);
      else throw new Error(`${key}: value must be a string, or null to remove it`);
    }
    const updatedBy = typeof payload.updatedBy === 'string' && payload.updatedBy.trim()
      ? payload.updatedBy.trim()
      : 'mcp';
    return PushSettingsService.set(values, updatedBy);
  },
};

export const pushSettingsMcpTools: IMcpTool[] = [pushSettingsTool, managePushSettingsTool];
