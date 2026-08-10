import { describe, expect, it } from 'vitest';
import { assertWorkspaceBranch, generateWorkspaceBranch } from './workspaceBranch';

describe('workspace branch names', () => {
  it('uses no more than three semantic slug words and keeps the collision suffix in the last one', () => {
    const branch = generateWorkspaceBranch('Fix the authentication request timeout everywhere', 'agentiz/', '7ac1');
    expect(branch).toBe('agentiz/fix-authentication-request7ac1');
    expect(branch.split('/').at(-1)?.split('-')).toHaveLength(3);
  });

  it('transliterates and validates edited names', () => {
    expect(generateWorkspaceBranch('Исправить авторизацию', 'agentiz/', 'abcd')).toMatch(/^agentiz\/[a-z0-9-]+abcd$/);
    expect(() => assertWorkspaceBranch('agentiz/fix-auth-timeout-extra')).toThrow(/1–3/);
    expect(() => assertWorkspaceBranch('agentiz/fix auth')).toThrow(/Invalid Git/);
  });
});
