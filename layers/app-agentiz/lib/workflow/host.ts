import { AppManager } from '@nodeknit/app-manager';
import type { WorkflowHost } from '@nodeknit/app-workflow';

/**
 * The host seam: everything of Agentiz's own that the engine is allowed to reach.
 *
 * Minimal on purpose, and each answer is a decision rather than a placeholder:
 *
 * - `checkPermission` — true. The engine does not call it yet (no enforcement is wired into the
 *   routes), and the only way to reach a flow today is the canvas, which sits behind Adminizer's
 *   session on `/dashboard`. Saying "open" out loud beats the default host's silent deny, which
 *   would start refusing things the moment enforcement lands with nobody having chosen a policy.
 * - `resolveSecret` — `process.env`, the same source every other credential in this layer reads.
 * - `notify` — the run log. It deliberately does **not** call `ActivityService.record()` yet: that
 *   dispatcher's event types are a closed catalogue (`lib/notifications/activityTypes.ts`) which
 *   the policy schema and the UI hints are generated from, so `workflow.*` events are a change to
 *   make there, once, rather than a string smuggled in from here.
 */
export class AgentizWorkflowHost implements WorkflowHost {
  async checkPermission(): Promise<boolean> {
    return true;
  }

  async resolveSecret(key: string): Promise<string | undefined> {
    return process.env[key];
  }

  async notify(event: { type: string; message: string; meta?: Record<string, unknown> }): Promise<void> {
    AppManager.log.warn(`[AppAgentiz] workflow ${event.type}: ${event.message}`, event.meta ?? '');
  }

  now(): Date {
    return new Date();
  }
}
