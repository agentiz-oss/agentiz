import { describe, expect, it } from 'vitest';
import { adminizerModuleUrl } from './adminizerModuleUrl';

describe('adminizerModuleUrl', () => {
  it('versions a module entry URL to invalidate the browser cache after deployment', () => {
    expect(adminizerModuleUrl('AgentizApp', 'test-sha')).toBe(
      '/dashboard/modules/AgentizApp.js?v=test-sha',
    );
  });
});
