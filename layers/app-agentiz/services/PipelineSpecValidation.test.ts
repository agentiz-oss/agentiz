import { describe, it, expect } from 'vitest';
import {
  assertValidSpec,
  coerceSpec,
  PipelineSpecError,
  PIPELINE_SPEC_RULES,
  PIPELINE_SPEC_SCHEMA_TOOL,
} from './PipelineSpecValidation';
import { hasUpstreamThread } from '../lib/taskManager';

/** The two documents agentiz.pipelineSpecSchema hands an agent as "copy this". */
const repositoryExample = {
  stages: [{ order: 1, role: 'implement', agentRoleKey: 'developer', runtime: { mode: 'host' } }],
  finalAction: { type: 'commit_and_pr', branchPrefix: 'agentiz/' },
};
const workspaceExample = {
  source: { kind: 'worker_workspace', workspace: { workerId: 'worker-1', workspaceKey: 'lyapka' } },
  stages: [{ order: 1, role: 'implement', agentRoleKey: 'developer', runtime: { mode: 'host' } }],
  finalAction: { type: 'comment_only' },
};
const workspacePathExample = {
  source: { kind: 'worker_workspace', workspace: { workerId: 'worker-1', path: '/prj/lyapka-rf', createIfMissing: true } },
  stages: [{ order: 1, role: 'implement', agentRoleKey: 'developer', runtime: { mode: 'host' } }],
  finalAction: { type: 'comment_only' },
};
const workspaceStrictExample = {
  source: {
    kind: 'worker_workspace',
    workspace: { workerId: 'worker-1', workspaceKey: 'lyapka', stashDirty: false },
  },
  stages: [{ order: 1, role: 'implement', agentRoleKey: 'developer', runtime: { mode: 'host' } }],
  finalAction: { type: 'comment_only' },
};
const workspaceGitExample = {
  source: { kind: 'worker_workspace', repositoryId: 'repo-1', workspace: { workerId: 'worker-1', workspaceKey: 'lyapka' } },
  stages: [{ order: 1, role: 'implement', agentRoleKey: 'developer', runtime: { mode: 'host' } }],
  finalAction: { type: 'commit', requireApproval: true, targetBranch: { mode: 'new', prefix: 'agentiz/' } },
};

function rejection(spec: unknown): PipelineSpecError {
  try {
    assertValidSpec(coerceSpec(spec));
  } catch (error) {
    return error as PipelineSpecError;
  }
  throw new Error('expected the spec to be rejected');
}

describe('pipeline spec examples', () => {
  it('accepts the examples the schema tool advertises', () => {
    expect(() => assertValidSpec(repositoryExample)).not.toThrow();
    expect(() => assertValidSpec(workspaceExample)).not.toThrow();
    expect(() => assertValidSpec(workspacePathExample)).not.toThrow();
    expect(() => assertValidSpec(workspaceGitExample)).not.toThrow();
  });
});

describe('rejection messages', () => {
  // Adminizer's CRUD, agentiz.manage and the create_model_record skill all surface `message` and
  // nothing else, so a rejection that omits either half leaves the caller with nowhere to go.
  it('names the failing fields and the tool that documents the shape', () => {
    const error = rejection({ steps: [{ name: 'Initial Step' }], workspace: '/prj/lyapka-rf' });
    expect(error.message).toContain("must have required property 'stages'");
    expect(error.message).toContain('must NOT have additional properties ("steps")');
    expect(error.message).toContain(PIPELINE_SPEC_SCHEMA_TOOL);
    expect(error.errors.length).toBeGreaterThan(0);
  });

  it('separates a bad envelope from a bad document', () => {
    expect(rejection('{"stages": [').message).toContain('not valid JSON');
  });

  it('explains the worker-directory combinations that cannot work', () => {
    expect(rejection({ ...workspaceExample, finalAction: { type: 'commit_and_pr' } }).message)
      .toContain('use "commit", "comment_only" or "none"');
    expect(rejection({
      ...workspaceExample,
      stages: [{ order: 1, role: 'implement', agentRoleKey: 'developer', runtime: { mode: 'docker' } }],
    }).message).toContain('use "host"');
  });

  it('requires a target branch mode for workspace Git delivery', () => {
    expect(rejection({ ...workspaceGitExample, finalAction: { type: 'commit' } }).message)
      .toContain('targetBranch.mode');
  });

  // The directory pushes through its own remote, so a hosted repository record is optional; pinning
  // one is still accepted, and still rejected when the delivery is not a commit.
  it('leaves the pinned repository optional for workspace Git delivery', () => {
    expect(() => assertValidSpec({ ...workspaceGitExample, source: { ...workspaceGitExample.source, repositoryId: undefined } }))
      .not.toThrow();
    expect(rejection({
      ...workspaceExample,
      source: { ...workspaceExample.source, repositoryId: 'repo-1' },
    }).message).toContain('only allowed with worker_workspace when finalAction.type is "commit"');
  });

  // The push grant lives on the worker (AgentWorker.gitPushRoots), so a directory named by path is
  // just as valid a document here as a declared key; whether it may push is decided at queue time.
  it('accepts workspace Git delivery for a directory named by path', () => {
    expect(() => assertValidSpec({
      ...workspaceGitExample,
      source: { kind: 'worker_workspace', repositoryId: 'repo-1', workspace: { workerId: 'worker-1', path: '/prj/lyapka-rf' } },
    })).not.toThrow();
  });

  it('requires exactly one of workspaceKey or path', () => {
    expect(rejection({
      ...workspaceExample,
      source: { kind: 'worker_workspace', workspace: { workerId: 'worker-1' } },
    }).message).toContain('exactly one of workspaceKey');
    expect(rejection({
      ...workspaceExample,
      source: { kind: 'worker_workspace', workspace: { workerId: 'worker-1', workspaceKey: 'lyapka', path: '/prj/lyapka-rf' } },
    }).message).toContain('exactly one of workspaceKey');
  });

  it('rejects a relative workspace path', () => {
    expect(rejection({
      ...workspacePathExample,
      source: { kind: 'worker_workspace', workspace: { workerId: 'worker-1', path: 'lyapka-rf' } },
    }).message).toContain('must be absolute');
  });

  it('rejects createIfMissing alongside workspaceKey', () => {
    expect(rejection({
      ...workspaceExample,
      source: { kind: 'worker_workspace', workspace: { workerId: 'worker-1', workspaceKey: 'lyapka', createIfMissing: true } },
    }).message).toContain('only applies alongside path');
  });

  it('rejects stage orders that are not 1..N', () => {
    expect(rejection({
      ...repositoryExample,
      stages: [
        { order: 1, role: 'a', agentRoleKey: 'developer', runtime: { mode: 'host' } },
        { order: 3, role: 'b', agentRoleKey: 'developer', runtime: { mode: 'host' } },
      ],
    }).message).toContain('without gaps');
  });
});

describe('coerceSpec', () => {
  it('accepts the JSON string generic clients submit', () => {
    expect(coerceSpec(JSON.stringify(workspaceExample))).toEqual(workspaceExample);
  });

  it('leaves a document untouched', () => {
    expect(coerceSpec(workspaceExample)).toBe(workspaceExample);
  });
});

describe('rules catalogue', () => {
  it('states the worker-directory rules the schema cannot express', () => {
    const text = PIPELINE_SPEC_RULES.join('\n');
    expect(text).toContain('worker_workspace');
    expect(text).toContain('setWorkspaces');
  });
});

describe('hasUpstreamThread', () => {
  // Decides whether comment_only has anywhere to post; a locally created task has not, and that
  // must read as "already reported in the local thread" rather than as a failed run.
  it('is false for a task created in Agentiz', () => {
    expect(hasUpstreamThread('local')).toBe(false);
    expect(hasUpstreamThread(null)).toBe(false);
  });

  it('is true for anything mirrored from outside', () => {
    expect(hasUpstreamThread('github')).toBe(true);
    expect(hasUpstreamThread('gitlab-issues')).toBe(true);
  });

  // additionalProperties is false on the workspace object, so an opt-out the schema does not know
  // about is not an opt-out but a rejected spec.
  it('accepts turning the dirty-workspace stash off', () => {
    expect(() => assertValidSpec(coerceSpec(workspaceStrictExample))).not.toThrow();
  });
});
