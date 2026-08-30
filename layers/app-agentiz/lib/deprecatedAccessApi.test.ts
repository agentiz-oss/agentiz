import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

/**
 * A sentry over the permission API, not over any behaviour of ours.
 *
 * Adminizer froze `hasPermission`/`enoughPermissions` synchronous forever and marked them
 * `@deprecated`: they fail closed and can never honour a contextual token's `check`, because that
 * check is async and there is nothing to await it with. The asynchronous
 * `checkPermission`/`checkAnyPermission` are the only pair that can. So a call to the old pair
 * compiles, type-checks, and denies a contextual token silently — there is no compiler error and
 * no test failure anywhere to notice it, only a deprecation line in the startup log that nobody
 * reads.
 *
 * The risk is not that we would write one on purpose. It is that `hasPermission` is the obvious
 * name: an editor's completion, an agent, or anybody reading older Adminizer code reaches for it
 * first, and the result looks correct. A text scan is the whole point — eslint here is not
 * configured for type-aware rules, and a grep-shaped check rides along in the run that is already
 * green or red.
 *
 * Inside Agentiz there is a second rule this does not enforce, because it is about placement
 * rather than naming: a permission decision belongs in one place, and everything else asks that
 * place. See `.ai-notes/check-permission-migration-plan.md`.
 */
describe('permission API: the deprecated synchronous pair stays out of the tree', () => {
  const selfPath = fileURLToPath(import.meta.url);
  const repoRoot = path.resolve(path.dirname(selfPath), '../../..');

  /**
   * Sources we own. `local_modules/*` are separate packages developed from this checkout — their
   * built output and dependencies are not ours, so only `src` is read. Everything installed
   * (including Adminizer itself, which of course still declares the deprecated pair) is out of
   * scope by construction.
   */
  const roots = [
    'layers',
    'config',
    ...fs
      .readdirSync(path.join(repoRoot, 'local_modules'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join('local_modules', entry.name, 'src')),
  ];

  const skipDirs = new Set(['node_modules', 'dist', 'build', '.git', 'coverage']);

  /**
   * Matched without requiring the leading dot, so a destructured or re-exported binding is caught
   * too, and so a local interface that copies Adminizer's signature — the failure mode that
   * survives an upgrade silently, because the compiler checks the call against the copy — shows up
   * as well. A mention in prose stays legal: the names appear without parentheses there, which is
   * how this comment and the migration plan can name them.
   */
  const deprecatedCall = /\b(hasPermission|enoughPermissions)\s*\(/;

  const sourceFiles = (dir: string): string[] => {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return skipDirs.has(entry.name) ? [] : sourceFiles(full);
      return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
    });
  };

  /** `file:line` for every offending call, so a failure names the place instead of the count. */
  const findings = (): string[] => {
    const found: string[] = [];
    for (const root of roots) {
      for (const file of sourceFiles(path.join(repoRoot, root))) {
        // This file spells the names it forbids.
        if (path.resolve(file) === selfPath) continue;
        const lines = fs.readFileSync(file, 'utf8').split('\n');
        lines.forEach((line, index) => {
          if (deprecatedCall.test(line)) found.push(`${path.relative(repoRoot, file)}:${index + 1}`);
        });
      }
    }
    return found;
  };

  it('reads the sources it is supposed to guard', () => {
    // Guards the guard: a wrong root or a broken walk would make the check below pass on an empty
    // set, which is indistinguishable from a clean tree.
    const files = roots.flatMap((root) => sourceFiles(path.join(repoRoot, root)));
    expect(files.length).toBeGreaterThan(100);
    expect(files.some((file) => file.endsWith(path.join('lib', 'runRoutes.ts')))).toBe(true);
    expect(files.some((file) => file.includes(`${path.sep}local_modules${path.sep}`))).toBe(true);
  });

  it('finds no call to hasPermission or enoughPermissions', () => {
    expect(findings(), [
      'These call sites use the deprecated synchronous permission API.',
      'Replace them with `await ...checkPermission(token, user)` (or `checkAnyPermission`),',
      'and inside Agentiz go through `lib/access/projectAccess.ts` once that exists.',
      '`hasStaticPermission`/`enoughStaticPermissions` are the legal synchronous escape where',
      'awaiting is impossible — write down why next to the call, and note that a contextual token',
      'is denied there.',
    ].join(' ')).toEqual([]);
  });

  it('would catch one if it appeared', () => {
    // Proves the regex, not the tree: the acceptance criterion is a red test on a deliberately
    // inserted call, and this pins that without leaving a real one in the sources.
    const shapes = [
      'if (!helper.hasPermission(token, user)) return res.sendStatus(403);',
      'const ok = req.adminizer.accessRightsHelper.enoughPermissions([token], user);',
      'runtime.accessRights.hasPermission(token, user)',
      '  hasPermission(tokenId: string, user: User): boolean;',
    ];
    for (const shape of shapes) expect(deprecatedCall.test(shape)).toBe(true);

    const legal = [
      'await adminizer.accessRightsHelper.checkPermission(`create-${name}-model`, user)',
      'accessRightsHelper.hasStaticPermission(token, user)',
      '// hasPermission is deprecated — see the migration plan',
      'async checkPermission(): Promise<boolean> { return true; }',
    ];
    for (const shape of legal) expect(deprecatedCall.test(shape)).toBe(false);
  });
});
