import { describe, expect, it } from 'vitest';
import { describeRunOverride, harnessKeyForCommand, harnessProfile, normalizeRunOverride, RunOverrideError } from './harnessCatalog';

describe('normalizeRunOverride', () => {
  it('treats an empty body as "run the pipeline as configured"', () => {
    expect(normalizeRunOverride({})).toBeNull();
    expect(normalizeRunOverride({ model: '  ' })).toBeNull();
    expect(normalizeRunOverride(null)).toBeNull();
  });

  it('keeps a model choice without pinning a worker', () => {
    expect(normalizeRunOverride({ model: 'sonnet' })).toEqual({ model: 'sonnet' });
  });

  it('refuses half an executor choice', () => {
    expect(() => normalizeRunOverride({ workerId: 'w1' })).toThrow(RunOverrideError);
    expect(() => normalizeRunOverride({ executorKey: 'codex' })).toThrow(RunOverrideError);
  });

  it('refuses a level outside the shared vocabulary', () => {
    expect(() => normalizeRunOverride({ reasoningLevel: 'ultra' })).toThrow(RunOverrideError);
    expect(normalizeRunOverride({ reasoningLevel: 'xhigh' })).toEqual({ reasoningLevel: 'xhigh' });
  });

  it('carries all three choices at once', () => {
    expect(normalizeRunOverride({ workerId: 'w1', executorKey: 'codex', model: 'gpt-5.5', reasoningLevel: 'high' }))
      .toEqual({ workerId: 'w1', executorKey: 'codex', model: 'gpt-5.5', reasoningLevel: 'high' });
  });
});

describe('the catalogue', () => {
  it('names the harness of a configured command through the one derivation', () => {
    expect(harnessKeyForCommand(['npx', '@agentclientprotocol/claude-agent-acp'])).toBe('claude');
    expect(harnessKeyForCommand(['python', '-m', 'agentiz_worker.codex_acp'])).toBe('codex');
    expect(harnessKeyForCommand(null)).toBeNull();
  });

  it('still describes an unknown harness, with no suggestions of its own', () => {
    const profile = harnessProfile('gemini-cli');
    expect(profile).toEqual({ key: 'gemini-cli', title: 'gemini-cli', models: [], reasoningLevels: [] });
  });

  it('spells the launch comment only from what was chosen', () => {
    expect(describeRunOverride(null)).toBe('');
    expect(describeRunOverride({ model: 'sonnet', reasoningLevel: 'high' })).toBe(' (sonnet, глубоко)');
  });
});
