import { describe, it, expect } from 'vitest';
import type { AgentWorkerWorkspace } from '../types/agentiz';
import { assertWorkspaceOwnership, declarationForPath, workspaceOwnerProjectId } from './workspaceOwnership';

const workspaces: AgentWorkerWorkspace[] = [
  { key: 'lyapka-rf', path: '/prj/lyapka-rf', projectId: 'project-lyapka' },
  { key: 'shared', path: '/prj/shared' },
];

const check = (specProjectId: string, ref: Parameters<typeof assertWorkspaceOwnership>[0]['ref']) =>
  assertWorkspaceOwnership({ workerName: 'worker-2', workspaces, specProjectId, named: '"x"', ref });

describe('worker workspace ownership', () => {
  it('lets the owning project use its own directory', () => {
    expect(() => check('project-lyapka', { declared: workspaces[0], path: '/prj/lyapka-rf' })).not.toThrow();
  });

  it('refuses a spec of another project, naming both projects', () => {
    expect(() => check('project-m42', { declared: workspaces[0], path: '/prj/lyapka-rf' }))
      .toThrow(/belongs to project project-lyapka.*belongs to project project-m42/s);
  });

  it('closes the path loophole: naming the directory directly is the same directory', () => {
    expect(() => check('project-m42', { path: '/prj/lyapka-rf/' })).toThrow(/project-lyapka/);
    expect(workspaceOwnerProjectId(workspaces, { path: '/prj/lyapka-rf' })).toBe('project-lyapka');
  });

  it('keeps an unbound directory shared, as before the field existed', () => {
    expect(() => check('project-m42', { declared: workspaces[1], path: '/prj/shared' })).not.toThrow();
    expect(workspaceOwnerProjectId(workspaces, { path: '/prj/elsewhere' })).toBeNull();
  });

  it('matches a declaration by path regardless of trailing slashes', () => {
    expect(declarationForPath(workspaces, '/prj/shared/')?.key).toBe('shared');
    expect(declarationForPath(workspaces, '')).toBeNull();
  });
});
