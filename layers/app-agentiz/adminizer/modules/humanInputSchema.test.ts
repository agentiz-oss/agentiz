import { describe, expect, it } from 'vitest';
import { humanInputChoices, selectedHumanInputChoice } from './humanInputSchema';

describe('humanInputChoices', () => {
  it('uses a oneOf title for display but preserves its const for the agent response', () => {
    const choices = humanInputChoices({
      oneOf: [
        { const: 'report', title: 'Показать краткий отчёт' },
        { const: 'repeat', title: 'Повторить замер' },
      ],
    });

    expect(choices).toEqual([
      { value: 'report', label: 'Показать краткий отчёт', description: undefined },
      { value: 'repeat', label: 'Повторить замер', description: undefined },
    ]);
    expect(selectedHumanInputChoice(choices, 'repeat')).toBe('1');
  });

  it('keeps enum values typed instead of coercing them to displayed strings', () => {
    const choices = humanInputChoices({ enum: [1, 2] });
    expect(choices[1]).toMatchObject({ value: 2, label: '2' });
    expect(selectedHumanInputChoice(choices, 2)).toBe('1');
  });
});
