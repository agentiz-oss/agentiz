import { AbstractApp, AppManager, Collection } from '@nodeknit/app-manager';
import { claudeLimitProvider } from './lib/claudeLimitProvider';
import type { HarnessLimitProvider } from '../app-agentiz/lib/harnessLimits';

/**
 * Claude harness limit provider layer.
 *
 * app-agentiz owns subscriptions, claim gates and deferral scheduling; this layer contributes the
 * one thing the core must not know — what a Claude limit refusal looks like and how a Claude
 * usage report maps onto abstract windows. Unmounting the layer returns those harness keys to
 * manual mode (markHarnessExhausted / resetSchedule keep working).
 */
export class AppAgentizClaudeLimits extends AbstractApp {
    appId: string = 'app-agentiz-claude-limits';
    name: string = 'App Agentiz Claude Limits';

    @Collection
    harnessLimitProviders: HarnessLimitProvider[] = [claudeLimitProvider];

    constructor(appManager: AppManager) {
        super(appManager);
    }

    async mount(): Promise<void> {
        // Registration happens through the collection; nothing else to wire.
    }

    async unmount(): Promise<void> {}
}

export default AppAgentizClaudeLimits;
