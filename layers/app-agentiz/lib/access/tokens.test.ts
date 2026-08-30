import { describe, expect, it } from 'vitest';
import {
  ACCESS_GROUP,
  AGENTIZ_GRAPH_MODELS,
  AGENTIZ_TOKEN_CATALOGUE,
  GLOBAL_TOKENS,
  PROJECT_TOKENS,
  ROLE_PRESETS,
  agentizAccessRightTokens,
  modelCrudToken,
  ownerRolePreset,
  seededGroups,
} from './tokens';

/**
 * Two invariants of the catalogue, both of which break silently in production if they break.
 *
 * **Lower case.** A plain string grant is compared two different ways: the access graph does it
 * case-insensitively (`grantsToken`), the global check does it exactly
 * (`AccessRightsHelper.hasAssignedPermission`). A group carrying `Read-AgentTask-Model` therefore
 * passes the graph and fails the token gate — "участник видит список, но не может войти в раздел",
 * with nothing in any log to explain it.
 *
 * **The ladder.** Each preset must contain the previous one whole. That is what makes "повысить
 * роль" a choice of row rather than a diff of checkboxes, what lets the members screen say «Особая
 * роль» and mean exactly "не совпало ни с одной ступенью", and what makes «может ли он меньше того»
 * a comparison of positions. Nothing enforces it at runtime — one careless edit to a preset and it
 * comes apart quietly.
 */
describe('the Agentiz token catalogue', () => {
  it('writes every token in lower case', () => {
    const everything = [
      ...Object.values(PROJECT_TOKENS),
      ...Object.values(GLOBAL_TOKENS),
      ...AGENTIZ_TOKEN_CATALOGUE.map((token) => token.id),
      ...seededGroups().flatMap((group) => group.tokens),
    ];
    for (const token of everything) {
      expect(token, `${token} is not lower case`).toBe(token.toLowerCase());
    }
  });

  it('builds a model CRUD token exactly as adminizer does', () => {
    expect(modelCrudToken('read', 'AgentTask')).toBe('read-agenttask-model');
    expect(modelCrudToken('create', 'PipelineSpec')).toBe('create-pipelinespec-model');
  });

  it('registers every token it names, so a typo cannot become a token nobody carries', () => {
    const registered = new Set(agentizAccessRightTokens().map((token) => token.id));
    for (const token of [...Object.values(PROJECT_TOKENS), ...Object.values(GLOBAL_TOKENS)]) {
      expect(registered.has(token), `${token} is missing from the catalogue`).toBe(true);
    }
    for (const token of agentizAccessRightTokens()) {
      expect(token.name.length).toBeGreaterThan(0);
      expect(token.description.length).toBeGreaterThan(0);
      expect(token.department.length).toBeGreaterThan(0);
    }
  });

  it('keeps the role ladder nested: each step contains the previous one whole', () => {
    for (let index = 1; index < ROLE_PRESETS.length; index += 1) {
      const lower = ROLE_PRESETS[index - 1];
      const higher = ROLE_PRESETS[index];
      const held = new Set(higher.tokens);
      for (const token of lower.tokens) {
        expect(held.has(token), `${higher.key} does not carry ${token} from ${lower.key}`).toBe(true);
      }
      expect(higher.tokens.length, `${higher.key} adds nothing to ${lower.key}`).toBeGreaterThan(lower.tokens.length);
    }
  });

  it('gives the owner step every project token and every model verb', () => {
    const owner = new Set(ownerRolePreset().tokens);
    for (const token of Object.values(PROJECT_TOKENS)) expect(owner.has(token)).toBe(true);
    for (const model of AGENTIZ_GRAPH_MODELS) {
      for (const verb of ['create', 'read', 'update', 'delete'] as const) {
        expect(owner.has(modelCrudToken(verb, model)), `owner lacks ${verb} on ${model}`).toBe(true);
      }
    }
  });

  it('keeps membership rows out of the upper-bound group', () => {
    // The model is outside the graph on purpose: a global reader of membership rows reads them
    // everywhere, which is exactly what the group handed to every new person must not do.
    expect(ACCESS_GROUP.tokens.some((token) => token.includes('agentprojectmember'))).toBe(false);
    expect(ACCESS_GROUP.tokens).toContain('access-to-adminpanel');
    expect(ACCESS_GROUP.tokens).toContain(GLOBAL_TOKENS.access);
  });

  it('never puts the graph bypass token on a role group', () => {
    // `hasGraphBypass` reads `user.groups` only, so it would do nothing there anyway — but a role
    // that looks like it can widen its own project boundary is a lie worth failing on.
    for (const preset of seededGroups()) {
      expect(preset.tokens, `${preset.key} carries the bypass token`).not.toContain(GLOBAL_TOKENS.projectAdmin);
    }
  });
});
