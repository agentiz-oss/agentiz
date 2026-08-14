export type HumanInputChoice = {
  value: unknown;
  label: string;
  description?: string;
};

export type HumanInputField = {
  type?: string;
  title?: string;
  description?: string;
  enum?: unknown[];
  oneOf?: Array<{ const?: unknown; title?: string; description?: string }>;
  default?: unknown;
};

/**
 * Convert the JSON-Schema choice forms emitted by ACP agents to UI choices.
 *
 * `oneOf` commonly uses a human-readable title with a compact `const` value.  The form must
 * submit that `const`, rather than its title, otherwise Ajv correctly rejects the response.
 */
export function humanInputChoices(field: HumanInputField): HumanInputChoice[] {
  if (Array.isArray(field.oneOf)) {
    return field.oneOf
      .filter((choice) => Object.prototype.hasOwnProperty.call(choice, 'const'))
      .map((choice) => ({
        value: choice.const,
        label: choice.title ?? String(choice.const),
        description: choice.description,
      }));
  }
  if (Array.isArray(field.enum)) {
    return field.enum.map((value) => ({ value, label: String(value) }));
  }
  return [];
}

export function selectedHumanInputChoice(choices: HumanInputChoice[], value: unknown): string {
  const index = choices.findIndex((choice) => Object.is(choice.value, value));
  return index < 0 ? '' : String(index);
}

/**
 * ACP/Codex marks choice questions optional in JSON Schema so a sibling `__other` field can be
 * supplied instead.  A plain form submit with neither is not a meaningful answer, though, and
 * would submit an empty string that fails the choice's `oneOf` validation on the server.
 */
export function missingHumanInputChoice(
  properties: Record<string, HumanInputField> | undefined,
  content: Record<string, unknown>,
): string | null {
  for (const [name, field] of Object.entries(properties ?? {})) {
    const choices = humanInputChoices(field);
    if (choices.length === 0 || selectedHumanInputChoice(choices, content[name]) !== '') continue;
    const other = content[`${name}__other`];
    if (typeof other === 'string' && other.trim()) continue;
    return field.title ?? name;
  }
  return null;
}
