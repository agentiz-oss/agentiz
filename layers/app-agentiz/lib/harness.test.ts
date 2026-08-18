import { describe, expect, it } from 'vitest';
import { harnessColumnValue, harnessKeyForStage, harnessKeysForStages } from './harness';

describe('harnessKeyForStage', () => {
  it('maps the Claude ACP adapter to "claude"', () => {
    expect(harnessKeyForStage({
      kind: 'openhands-acp',
      config: { acpCommand: ['npx', '-y', '@agentclientprotocol/claude-agent-acp@0.66.0'] },
    })).toBe('claude');
  });

  it('maps both spellings of the Codex adapter to one key', () => {
    // The worker substitutes codex-acp with its own patched launcher; a gate that opens for one
    // spelling and not the other would be a gate with a hole in it.
    expect(harnessKeyForStage({ config: { acpCommand: ['npx', '-y', '@agentclientprotocol/codex-acp@1.1.14'] } })).toBe('codex');
    expect(harnessKeyForStage({ config: { acpCommand: ['python', '-m', 'agentiz_worker.codex_acp'] } })).toBe('codex');
  });

  it('never gates a bash fixture: it spends no tokens', () => {
    expect(harnessKeyForStage({ kind: 'bash-fixture', config: { acpCommand: ['bash'] } })).toBeNull();
  });

  it('falls back to a sanitized package name for an unknown adapter', () => {
    expect(harnessKeyForStage({ config: { acpCommand: ['npx', '-y', '@someone/gemini-acp@2.0.0'] } })).toBe('gemini-acp');
  });

  it('yields null for a stage with no command at all', () => {
    expect(harnessKeyForStage({ kind: 'stub', config: {} })).toBeNull();
    expect(harnessKeyForStage(null)).toBeNull();
  });
});

describe('harnessColumnValue', () => {
  it('is the single key, "mixed" for several, null for none', () => {
    const claude = { config: { acpCommand: ['npx', '@agentclientprotocol/claude-agent-acp'] } };
    const codex = { config: { acpCommand: ['npx', '@agentclientprotocol/codex-acp'] } };
    expect(harnessColumnValue(harnessKeysForStages([claude, claude]))).toBe('claude');
    expect(harnessColumnValue(harnessKeysForStages([claude, codex]))).toBe('mixed');
    expect(harnessColumnValue(harnessKeysForStages([{ kind: 'bash-fixture' }]))).toBeNull();
  });
});
