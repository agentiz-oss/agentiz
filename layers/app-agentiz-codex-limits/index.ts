import { AbstractApp, AppManager, Collection } from '@nodeknit/app-manager';
import { codexLimitProvider } from './lib/codexLimitProvider';
import type { HarnessLimitProvider } from '../app-agentiz/lib/harnessLimits';

/** Codex-specific usage vocabulary, contributed without making the capacity core know Codex. */
export class AppAgentizCodexLimits extends AbstractApp {
  appId: string = 'app-agentiz-codex-limits';
  name: string = 'App Agentiz Codex Limits';

  @Collection
  harnessLimitProviders: HarnessLimitProvider[] = [codexLimitProvider];

  constructor(appManager: AppManager) {
    super(appManager);
  }

  async mount(): Promise<void> {}

  async unmount(): Promise<void> {}
}

export default AppAgentizCodexLimits;
