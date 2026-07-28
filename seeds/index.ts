import type { AppManager } from '@nodeknit/app-manager';
import { seed as agentizSeed } from './agentiz.seed';

const seeds = [
  { name: 'agentiz', fn: agentizSeed },
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
