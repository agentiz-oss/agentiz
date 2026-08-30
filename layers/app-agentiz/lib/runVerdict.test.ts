import { describe, it, expect } from 'vitest';
import { extractVerdict } from './runVerdict';

describe('extractVerdict', () => {
  it('reads a plain pass marker', () => {
    expect(extractVerdict('Всё проверил.\nAGENTIZ_VERDICT: pass')).toEqual({ verdict: 'pass', reason: null });
  });

  it('reads a fail marker with a reason', () => {
    expect(extractVerdict('AGENTIZ_VERDICT: fail — тесты не проходят'))
      .toEqual({ verdict: 'fail', reason: 'тесты не проходят' });
  });

  it('accepts a plain hyphen as well as an em dash', () => {
    expect(extractVerdict('AGENTIZ_VERDICT: fail - build broken'))
      .toEqual({ verdict: 'fail', reason: 'build broken' });
  });

  it('is case-insensitive on both the keyword and the value', () => {
    expect(extractVerdict('agentiz_verdict: PASS')).toEqual({ verdict: 'pass', reason: null });
  });

  it('takes the last marker when the answer restates it', () => {
    const text = 'AGENTIZ_VERDICT: fail — draft\nMore investigation...\nAGENTIZ_VERDICT: pass';
    expect(extractVerdict(text)).toEqual({ verdict: 'pass', reason: null });
  });

  it('does not capture a reason spilling onto the next line', () => {
    const text = 'AGENTIZ_VERDICT: fail — see below\nActually the whole story is longer than one line';
    expect(extractVerdict(text)).toEqual({ verdict: 'fail', reason: 'see below' });
  });

  it('treats an unclear value as no marker at all', () => {
    expect(extractVerdict('AGENTIZ_VERDICT: unclear')).toEqual({ verdict: null, reason: null });
  });

  it('returns null for missing or empty text', () => {
    expect(extractVerdict(null)).toEqual({ verdict: null, reason: null });
    expect(extractVerdict('')).toEqual({ verdict: null, reason: null });
    expect(extractVerdict('No marker here at all.')).toEqual({ verdict: null, reason: null });
  });
});
