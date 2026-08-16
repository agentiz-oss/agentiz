import type { IMcpTool } from '@nodeknit/app-mcp';
import { MobileDevice } from '../models/MobileDevice';

/**
 * The registered phones, over MCP.
 *
 * "The notification did not arrive" splits in two at exactly one question: is there a device row at
 * all? Everything on the server side — credentials, the owner of the project, the provider — is
 * already inspectable, but until now the table itself was not, and the app registers *silently* on
 * purpose (a failure there must not interrupt someone who is signing in). That left the most common
 * cause — the phone never got as far as `POST /devices` — the only one that could not be checked.
 *
 * Read-only, and the token is never returned in full: it is a capability to notify that installation,
 * and correlating a row with a device needs only its tail.
 */

function objectParams(params: unknown): Record<string, unknown> {
  return params !== null && typeof params === 'object' && !Array.isArray(params) ? params as Record<string, unknown> : {};
}

/** Enough to recognise which registration a row is, and nothing that could be used to send. */
function tokenTail(token: string): string {
  const raw = String(token ?? '');
  return raw.length <= 6 ? '••••' : `••••${raw.slice(-6)}`;
}

const devicesTool: IMcpTool = {
  name: 'agentiz.devices',
  group: 'agentiz',
  shortDescription: 'Lists the mobile installations registered for push.',
  description: [
    'Registered devices: which user each belongs to, the platform, the app version that registered it',
    'and when it was last seen. Optional `userId` narrows to one person — push is addressed to the',
    'owner of the project, so a row under a different user is as good as no row at all.',
    'Push tokens are returned only as a masked tail.',
  ].join(' '),
  mode: 'protected',
  inputSchema: {
    type: 'object',
    properties: {
      userId: { type: 'number', description: 'Only devices registered by this UserAP id.' },
      limit: { type: 'number', description: 'Maximum rows to return; default 50.' },
    },
  },
  async handler(params) {
    const payload = objectParams(params);
    const userId = Number(payload.userId);
    const limit = Number.isFinite(Number(payload.limit)) ? Math.min(Math.max(Number(payload.limit), 1), 200) : 50;
    const where = Number.isFinite(userId) ? { userId } : undefined;

    const rows = await MobileDevice.findAll({
      ...(where ? { where } : {}),
      order: [['updatedAt', 'DESC']],
      limit,
    });
    return {
      count: rows.length,
      items: rows.map((device) => ({
        id: device.id,
        userId: device.userId,
        platform: device.platform,
        token: tokenTail(device.token),
        appVersion: device.appVersion,
        deviceName: device.deviceName,
        lastSeenAt: device.lastSeenAt,
        createdAt: device.createdAt,
      })),
    };
  },
};

export const deviceMcpTools: IMcpTool[] = [devicesTool];
