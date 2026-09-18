import { describe, expect, it, vi } from 'vitest';
import { MobileAuthError, MobileAuthService } from './MobileAuthService';

/**
 * A fake `UserAP` row: only `get` and `update`, which is all the service touches. Deliberately not a
 * Sequelize model — the column is adminizer's, and a test that had to define it would be testing its
 * own definition rather than what this layer does with whatever is in it.
 */
function userRow(attrs: Record<string, unknown>) {
  const state = { ...attrs };
  return {
    get: (key: string) => state[key],
    update: vi.fn(async (values: Record<string, unknown>) => {
      Object.assign(state, values);
      return undefined;
    }),
    state,
  };
}

/** A `sequelize` stub whose only job is to hand `requireUser` the row above. */
function sequelizeWith(row: ReturnType<typeof userRow> | null) {
  return {
    isDefined: () => true,
    model: () => ({
      associations: {},
      findByPk: async () => row,
      getAttributes: () => ({ login: {}, email: {} }),
    }),
  } as any;
}

describe('the language on a mobile profile', () => {
  it('is absent rather than guessed when the column is empty', () => {
    // The pre-existing state of every account on this deployment: adminizer only offers the field
    // where `config.translation` is set, and it is not set here. Null has to reach the client
    // unchanged — it is what makes the app fall back to the device rather than to a language
    // somebody would then have to find the switch for.
    expect(MobileAuthService.toAuthUser(userRow({ id: 1, login: 'ivan' })).locale).toBeNull();
    expect(MobileAuthService.toAuthUser(userRow({ id: 1, login: 'ivan', locale: '' })).locale).toBeNull();
    expect(MobileAuthService.toAuthUser(userRow({ id: 1, login: 'ivan', locale: '  ' })).locale).toBeNull();
  });

  it('reduces whatever the column holds to a language the app actually has', () => {
    // Three spellings of one wish, from three writers: our own app sends a bare subtag, adminizer's
    // user form sends a full locale, and a phone can offer a regional Spanish. All three are
    // answers this app can honour, so none of them may read as "nobody said".
    const of = (locale: unknown) => MobileAuthService.toAuthUser(userRow({ id: 1, login: 'i', locale })).locale;
    expect(of('ru')).toBe('ru');
    expect(of('ru-RU')).toBe('ru');
    expect(of('ru_RU')).toBe('ru');
    expect(of('ES')).toBe('es');
    expect(of('es-419')).toBe('es');
    expect(of('en-GB')).toBe('en');
    // A language the app is not translated into is not a setting it can honour, so it reads as
    // unset — the reader gets their device's language instead of a screen of missing words.
    expect(of('de')).toBeNull();
    expect(of(42)).toBeNull();
  });

  it('writes the normalized tag to the profile, never the raw one', async () => {
    const row = userRow({ id: 7, login: 'ivan' });
    await MobileAuthService.setLocale(sequelizeWith(row), 7, 'es-419');
    expect(row.update).toHaveBeenCalledWith({ locale: 'es' });
    expect(MobileAuthService.toAuthUser(row).locale).toBe('es');
  });

  it('refuses a language it cannot show rather than storing it', async () => {
    const row = userRow({ id: 7, login: 'ivan', locale: 'ru' });
    await expect(MobileAuthService.setLocale(sequelizeWith(row), 7, 'de')).rejects.toBeInstanceOf(MobileAuthError);
    await expect(MobileAuthService.setLocale(sequelizeWith(row), 7, '')).rejects.toBeInstanceOf(MobileAuthError);
    // The column is shared with the panel, so a refused write must leave the previous answer
    // standing rather than clearing it.
    expect(row.update).not.toHaveBeenCalled();
    expect(MobileAuthService.toAuthUser(row).locale).toBe('ru');
  });
});
