import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import { AGENTIZ_ACCESS_GRAPH, AGENTIZ_GRAPH_KEY, installAgentizAccessGraph } from './accessGraph';
import { AGENTIZ_GRAPH_MODELS, GLOBAL_TOKENS } from './tokens';

/**
 * A sentry over the access-graph declaration, standing where adminizer deliberately does not.
 *
 * Adminizer validates the graph's *structure* at boot and throws on a broken one — a cycle, a path
 * that never reaches the root, a model in two graphs. What it does **not** fail on is the two ways
 * this declaration can rot without any symptom:
 *
 * - a model that still declares `userAccessRelation` while the graph covers it. Adminizer logs
 *   `INVALID CONFIGURATION` per model and starts anyway; behaviour stays correct (the graph wins),
 *   so nothing breaks — the declaration simply stops describing reality, which is worse, because
 *   the next person reads it and believes it;
 * - a model named in `include` that the panel never registered. That is the graph's one fail-soft
 *   branch: a warning at boot and the model left silently outside the boundary.
 *
 * Both are grep-shaped, and a grep-shaped check rides along in the run that is already green or red.
 */
describe('the agentiz access graph', () => {
  const selfPath = fileURLToPath(import.meta.url);
  const repoRoot = path.resolve(path.dirname(selfPath), '../../../..');
  const graph = AGENTIZ_ACCESS_GRAPH as any;

  const skipDirs = new Set(['node_modules', 'dist', 'build', '.git', 'coverage']);
  const sourceFiles = (dir: string): string[] => {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return skipDirs.has(entry.name) ? [] : sourceFiles(full);
      return /\.tsx?$/.test(entry.name) ? [full] : [];
    });
  };

  it('is declared once, at the root of the graph', () => {
    expect(graph).toBeTruthy();
    expect(graph.root).toBe('AgentProject');
    expect(graph.membership).toEqual({ through: 'AgentProjectMember', via: 'user', group: 'group' });
    // Matched as a plain string against the user's global groups, so a typo here is not an error
    // anywhere — it is a support token nobody holds. Registering it is what makes that a test.
    expect(graph.bypassToken).toBe(GLOBAL_TOKENS.projectAdmin);
  });

  it('covers exactly the models the token presets are written against', () => {
    const covered = new Set([graph.root, ...Object.keys(graph.include ?? {})]);
    expect([...covered].sort()).toEqual([...AGENTIZ_GRAPH_MODELS].sort());
  });

  it('gives every non-root model a parent that is itself in the graph', () => {
    const covered = new Set([graph.root, ...Object.keys(graph.include ?? {})]);
    // Parent aliases as the models declare them; the graph derives the parent model from the alias
    // and refuses one that leaves the graph, but it refuses it at boot with a 500 on the first list.
    const parentModel: Record<string, string> = { project: 'AgentProject', task: 'AgentTask', run: 'AgentRun' };
    for (const [model, edge] of Object.entries<any>(graph.include ?? {})) {
      const target = parentModel[edge.parent];
      expect(target, `${model}.${edge.parent} is not a known parent alias`).toBeTruthy();
      expect(covered.has(target), `${model} points at ${target}, which is outside the graph`).toBe(true);
      expect(model).not.toBe(graph.root);
    }
  });


  /**
   * The declaration is handed to a *running* panel rather than written into the root config,
   * because `Adminizer.init()` throws on a root model that is not registered and every Agentiz
   * model arrives after init. That makes the installation itself worth a test: it must land under
   * its own key, leave any other graph alone, and report what it could not find instead of
   * assuming it is there.
   */
  it('installs itself onto a running panel without disturbing another graph', () => {
    const registered = new Set([AGENTIZ_ACCESS_GRAPH.root, 'AgentProjectMember', ...Object.keys(AGENTIZ_ACCESS_GRAPH.include ?? {})]);
    const host = {
      config: { accessGraph: { other: { root: 'Something' } } as Record<string, any> },
      modelHandler: { getResourceRecord: (name: string) => (registered.has(name) ? { name } : undefined) },
    };
    const report = installAgentizAccessGraph(host as any);
    expect(report).toEqual({ missing: [], blocking: [] });
    expect(host.config.accessGraph[AGENTIZ_GRAPH_KEY]).toBe(AGENTIZ_ACCESS_GRAPH);
    expect(host.config.accessGraph.other).toBeTruthy();
  });

  it('names an unregistered root as blocking and an unregistered member as merely missing', () => {
    const host = {
      config: {},
      modelHandler: { getResourceRecord: (name: string) => (name === 'AgentTask' ? { name } : undefined) },
    };
    const report = installAgentizAccessGraph(host as any);
    expect(report.blocking).toEqual(['AgentProject', 'AgentProjectMember']);
    expect(report.missing).toContain('AgentRun');
    expect(report.missing).not.toContain('AgentTask');
  });

  it('leaves no userAccessRelation anywhere in the layers', () => {
    const offenders = sourceFiles(path.join(repoRoot, 'layers'))
      // This file names it in prose, which is the whole point of the rule being written down.
      .filter((file) => file !== selfPath)
      .filter((file) => /userAccessRelation/.test(fs.readFileSync(file, 'utf-8')))
      .map((file) => path.relative(repoRoot, file));
    expect(offenders, 'the graph replaces these; declaring both is a configuration error adminizer only logs').toEqual([]);
  });

  it('registers every model it covers as a panel resource', () => {
    // A model in `include` that nobody registered is the graph's only fail-soft branch: a warning
    // at boot and the model left outside the boundary. `generateAdminizerModelConfig(X)` in the
    // layer's mount is what makes it a resource, so that list is what this reads.
    const index = fs.readFileSync(path.join(repoRoot, 'layers/app-agentiz/index.ts'), 'utf-8');
    const registered = new Set(
      [...index.matchAll(/generateAdminizerModelConfig\((\w+)\)/g)].map((match) => match[1]),
    );
    for (const model of [graph.root, ...Object.keys(graph.include ?? {})]) {
      expect(registered.has(model), `${model} is in the graph but not registered in the panel`).toBe(true);
    }
    // The membership model is not in the graph, but `resolveMembership` looks it up in the very
    // same registry — unregistered, it fails the whole graph, not just itself.
    expect(registered.has('AgentProjectMember')).toBe(true);
  });
});
