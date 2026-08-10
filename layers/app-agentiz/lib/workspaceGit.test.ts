import { describe, it, expect } from 'vitest';
import { gitPushRootFor, isUnderGitPushRoot, normalizeGitPushRoot, resolveWorkspaceGitGrant } from './workspaceGit';

describe('workspace Git push grant', () => {
  it('treats a root and its subdirectories as granted', () => {
    expect(isUnderGitPushRoot('/srv/projects', '/srv/projects')).toBe(true);
    expect(isUnderGitPushRoot('/srv/projects/app', '/srv/projects')).toBe(true);
    expect(isUnderGitPushRoot('/srv/projects/app/', '/srv/projects/')).toBe(true);
  });

  it('does not let a shared name prefix pass as containment', () => {
    expect(isUnderGitPushRoot('/srv/projects-secret', '/srv/projects')).toBe(false);
    expect(isUnderGitPushRoot('/srv', '/srv/projects')).toBe(false);
    expect(isUnderGitPushRoot('/srv/projects', '')).toBe(false);
  });

  it('normalizes away trailing slashes without losing the root itself', () => {
    expect(normalizeGitPushRoot('/srv/projects///')).toBe('/srv/projects');
    expect(normalizeGitPushRoot('/')).toBe('/');
    expect(normalizeGitPushRoot('  ')).toBe('');
  });

  it('names the covering root, so a rejection can say what was missing', () => {
    expect(gitPushRootFor('/prj/lyapka-rf', ['/opt', '/prj'])).toBe('/prj');
    expect(gitPushRootFor('/prj/lyapka-rf', ['/opt'])).toBeNull();
  });

  it('grants push through a root with the default remote', () => {
    expect(resolveWorkspaceGitGrant('/prj/lyapka-rf', ['/prj'])).toEqual({ pushEnabled: true, remote: 'origin' });
    expect(resolveWorkspaceGitGrant('/prj/lyapka-rf', null)).toBeNull();
  });

  it('lets a declared workspace name a different remote, and win over the roots', () => {
    const declared = { key: 'lyapka', path: '/elsewhere/lyapka', git: { pushEnabled: true, remote: 'upstream' } };
    expect(resolveWorkspaceGitGrant('/elsewhere/lyapka', null, declared)).toEqual({ pushEnabled: true, remote: 'upstream' });
    expect(resolveWorkspaceGitGrant('/prj/lyapka-rf', ['/prj'], { key: 'k', path: '/prj/lyapka-rf' }))
      .toEqual({ pushEnabled: true, remote: 'origin' });
  });
});
