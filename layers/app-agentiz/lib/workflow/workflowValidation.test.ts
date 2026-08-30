import { describe, expect, it } from 'vitest';
import { NodeRegistry, validateWorkflowSpec } from '@nodeknit/app-workflow';
import type { NodeTypeDefinition, WorkflowSpec } from '@nodeknit/app-workflow';

/**
 * §9.2 of `.ai-notes/human-in-the-loop-workflow-plan.md`: the two-input scenario needs the graph
 * to let two branches converge on one node (fan-in), while `WorkflowEngine.advance()` still loses
 * its queue of not-yet-run siblings the moment a branch parks in an `external`/`defer` node — so
 * fan-out (two edges out of the *same* port) stays forbidden until that queue is persisted. This
 * test exercises `validateWorkflowSpec` directly against a private registry, not the real node
 * catalogue, so it survives independently of what app-agentiz happens to register.
 */

const trigger: NodeTypeDefinition = {
  type: 'test.trigger',
  name: 'Trigger',
  kind: 'trigger',
  ports: { inputs: 0, outputs: ['out'] },
  trigger: { bind: () => {}, unbind: () => {} },
};

const passThrough: NodeTypeDefinition = {
  type: 'test.passThrough',
  name: 'Pass-through',
  kind: 'server',
  ports: { inputs: 1, outputs: ['out'] },
  executor: { execute: async (ctx) => ({ msg: ctx.msg }) },
};

const twoPorts: NodeTypeDefinition = {
  type: 'test.twoPorts',
  name: 'Two ports',
  kind: 'server',
  ports: { inputs: 1, outputs: ['succeeded', 'failed'] },
  executor: { execute: async (ctx) => ({ msg: ctx.msg }) },
};

// NodeRegistry backs onto a process-wide `Symbol.for` map (see NodeRegistry.ts), so every type
// is registered exactly once here rather than per test.
const registry = new NodeRegistry();
for (const def of [trigger, passThrough, twoPorts]) registry.register(def);

describe('validateWorkflowSpec — fan-in / fan-out', () => {
  it('allows two branches to converge on one node (fan-in)', () => {
    const spec: WorkflowSpec = {
      id: 's',
      nodes: [
        { id: 't1', type: 'test.trigger' },
        { id: 't2', type: 'test.trigger' },
        { id: 'join', type: 'test.passThrough' },
      ],
      edges: [
        { from: 't1', to: 'join' },
        { from: 't2', to: 'join' },
      ],
    };
    expect(validateWorkflowSpec(spec, registry)).toEqual([]);
  });

  it('rejects two edges out of the same output port (fan-out)', () => {
    const spec: WorkflowSpec = {
      id: 's',
      nodes: [
        { id: 't1', type: 'test.trigger' },
        { id: 'a', type: 'test.passThrough' },
        { id: 'b', type: 'test.passThrough' },
      ],
      edges: [
        { from: 't1', to: 'a' },
        { from: 't1', to: 'b' },
      ],
    };
    const errors = validateWorkflowSpec(spec, registry);
    expect(errors).toEqual([
      { nodeId: 't1', message: 'Node "t1" has 2 outgoing edges from port "out"; fan-out is not supported' },
    ]);
  });

  it('does not treat two different output ports as fan-out', () => {
    const spec: WorkflowSpec = {
      id: 's',
      nodes: [
        { id: 't1', type: 'test.trigger' },
        { id: 'branch', type: 'test.twoPorts' },
        { id: 'onOk', type: 'test.passThrough' },
        { id: 'onFail', type: 'test.passThrough' },
      ],
      edges: [
        { from: 't1', to: 'branch' },
        { from: 'branch', to: 'onOk', fromPort: 'succeeded' },
        { from: 'branch', to: 'onFail', fromPort: 'failed' },
      ],
    };
    expect(validateWorkflowSpec(spec, registry)).toEqual([]);
  });

  it('still rejects a genuine cycle, fan-in notwithstanding', () => {
    const spec: WorkflowSpec = {
      id: 's',
      nodes: [
        { id: 't1', type: 'test.trigger' },
        { id: 'a', type: 'test.passThrough' },
        { id: 'b', type: 'test.passThrough' },
      ],
      edges: [
        { from: 't1', to: 'a' },
        { from: 'a', to: 'b' },
        { from: 'b', to: 'a' },
      ],
    };
    const errors = validateWorkflowSpec(spec, registry);
    expect(errors.some((e) => e.message.startsWith('The graph contains a cycle'))).toBe(true);
  });

  it('still refuses an incoming edge into a trigger node', () => {
    const spec: WorkflowSpec = {
      id: 's',
      nodes: [
        { id: 'a', type: 'test.passThrough' },
        { id: 't1', type: 'test.trigger' },
      ],
      edges: [{ from: 'a', to: 't1' }],
    };
    const errors = validateWorkflowSpec(spec, registry);
    expect(errors).toEqual([{ nodeId: 't1', message: 'Trigger node "t1" cannot have incoming edges' }]);
  });
});
