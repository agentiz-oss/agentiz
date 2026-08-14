import { describe, expect, it } from 'vitest';
import { adminizerModuleUrl } from './adminizerModuleUrl';

describe('adminizerModuleUrl', () => {
  it('versions a module entry URL to invalidate the browser cache after deployment', () => {
    expect(adminizerModuleUrl('AgentizInteractions', 'test-sha')).toBe(
      '/dashboard/modules/AgentizInteractions.js?v=test-sha',
    );
  });
});
