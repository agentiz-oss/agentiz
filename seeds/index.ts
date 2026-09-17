import type { AppManager } from '@nodeknit/app-manager';
import { seed as agentizSeed } from './agentiz.seed';
import { seed as agentizProjectsSeed } from './agentiz-projects.seed';
import { seed as mobileScreenshotsSeed } from './mobile-screenshots.seed';

const seeds = [
  { name: 'agentiz', fn: agentizSeed },
  { name: 'agentiz-projects', fn: agentizProjectsSeed },
  // Off unless AGENTIZ_SEED_MOBILE_SCREENSHOTS=1 — see the file header. Registered unconditionally,
  // same as every other seed here; the gate lives inside the function, not in this list.
  { name: 'mobile-screenshots', fn: mobileScreenshotsSeed },
];

export async function runSeeds(appManager: AppManager) {
  console.log('[seeds] Running seeds...');

  for (const seed of seeds) {
    try {
      await seed.fn(appManager);
    } catch (err) {
      console.error(`[seeds] Seed "${seed.name}" failed:`, err);
    }
  }

  console.log('[seeds] Done');
}
