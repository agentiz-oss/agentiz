import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@nodeknit/app-adminizer', () => ({
  AdminizerField: (): PropertyDecorator => (_target: object, _key: string | symbol): void => {},
  AdminizerModel: (): ClassDecorator => (_target: Function): void => {},
}));
import { Sequelize } from 'sequelize-typescript';
import * as agentizModels from '../models';
import { AgentGitConnection } from '../models/AgentGitConnection';
import { AgentProject } from '../models/AgentProject';
import { AgentProjectRepository } from '../models/AgentProjectRepository';
import { AgentRepository } from '../models/AgentRepository';
import { registerGitConnectionAuthority, unregisterGitConnectionAuthority } from '../lib/git/connections';
import { detachedWorkSettled } from '../lib/detachedWork';
import { agentizRepositoryMcpTools } from './agentizRepositoryTools';

const listTool = agentizRepositoryMcpTools.find((tool) => tool.name === 'agentiz.repositories')!;
const manageTool = agentizRepositoryMcpTools.find((tool) => tool.name === 'agentiz.manageRepositories')!;
const call = async (tool: typeof listTool, params: Record<string, unknown>): Promise<any> =>
  (tool.handler as (params: unknown) => Promise<unknown>)(params);

/**
 * The situation these tools exist for: an agent has just run `gh repo create acme/fresh --push` on
 * the worker, so the platform has the repository and our mirror does not. Linking it by the name
 * the agent printed must see it without a trip to the panel.
 */
describe('agentiz repository MCP tools', () => {
  let sequelize: Sequelize;
  let project: AgentProject;
  let connection: AgentGitConnection;
  let platform: string[];
  const syncCalls: string[] = [];

  beforeAll(async () => {
    sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false, models: Object.values(agentizModels) as any[] });
  });

  beforeEach(async () => {
    await sequelize.sync({ force: true });
    syncCalls.length = 0;
    platform = ['acme/old'];
    project = await AgentProject.create({ name: 'Fresh', slug: 'fresh', ownerId: 1 } as any);
    connection = await AgentGitConnection.create({
      provider: 'github', username: 'acme', status: 'active', secrets: { accessToken: 'tok' },
    } as any);
    registerGitConnectionAuthority({
      provider: 'github',
      authScheme: 'token',
      accessToken: async () => 'tok',
      // A stand-in for the mirror: whatever the "platform" holds right now becomes AgentRepository rows.
      syncRepositories: async (conn) => {
        syncCalls.push(conn.id);
        let created = 0;
        for (const path of platform) {
          const [, wasCreated] = await AgentRepository.findOrCreate({
            where: { connectionId: conn.id, pathWithNamespace: path },
            defaults: {
              connectionId: conn.id, provider: 'github', externalRepoId: path, pathWithNamespace: path,
              owner: path.split('/')[0], repo: path.split('/')[1], cloneUrl: `https://github.com/${path}.git`,
              defaultBranch: 'main',
            } as any,
          });
          if (wasCreated) created += 1;
        }
        return { connectionId: conn.id, fetched: platform.length, created, updated: 0, errors: [] };
      },
    });
    await call(manageTool, { operation: 'sync' });
  });

  afterEach(async () => {
    await detachedWorkSettled();
    unregisterGitConnectionAuthority('github');
  });

  afterAll(async () => {
    await sequelize.close();
  });

  it('links a repository the mirror has not seen yet by owner/name, syncing once', async () => {
    platform.push('acme/Fresh');
    syncCalls.length = 0;

    const result = await call(manageTool, {
      operation: 'link', projectId: project.id, pathWithNamespace: 'ACME/fresh.git', isPrimary: true,
    });

    expect(result.synced).toBe(true);
    expect(syncCalls).toEqual([connection.id]);
    expect(result.repository.pathWithNamespace).toBe('acme/Fresh');
    const link = await AgentProjectRepository.findByPk(result.link.id);
    expect(link).toMatchObject({ projectId: project.id, connectionId: connection.id, provider: 'github', role: 'both', isPrimary: true });
  });

  it('does not sync when the repository is already mirrored', async () => {
    syncCalls.length = 0;
    const result = await call(manageTool, { operation: 'link', projectId: project.id, pathWithNamespace: 'acme/old' });
    expect(result.synced).toBe(false);
    expect(syncCalls).toEqual([]);
  });

  it('says plainly when no connection sees the repository', async () => {
    await expect(call(manageTool, { operation: 'link', projectId: project.id, pathWithNamespace: 'someone/else' }))
      .rejects.toThrow(/not_found: no connection sees repository someone\/else even after a sync/);
  });

  it('refuses a duplicate link and an unknown role', async () => {
    await call(manageTool, { operation: 'link', projectId: project.id, pathWithNamespace: 'acme/old' });
    await expect(call(manageTool, { operation: 'link', projectId: project.id, pathWithNamespace: 'acme/old' }))
      .rejects.toThrow(/conflict/);
    platform.push('acme/other');
    await expect(call(manageTool, { operation: 'link', projectId: project.id, pathWithNamespace: 'acme/other', role: 'owner' }))
      .rejects.toThrow(/invalid: role must be one of/);
  });

  it('updates and unlinks by project + repository, unlink only with confirm', async () => {
    const { link, repository } = await call(manageTool, { operation: 'link', projectId: project.id, pathWithNamespace: 'acme/old' });

    const updated = await call(manageTool, { operation: 'updateLink', linkId: link.id, role: 'target', syncIssues: false });
    expect(updated.link).toMatchObject({ role: 'target', syncIssues: false, isActive: true });

    await expect(call(manageTool, { operation: 'unlink', projectId: project.id, repositoryId: repository.id }))
      .rejects.toThrow(/confirm:true/);
    const removed = await call(manageTool, { operation: 'unlink', projectId: project.id, repositoryId: repository.id, confirm: true });
    expect(removed.unlinked).toBe(true);
    expect(await AgentProjectRepository.count()).toBe(0);
  });

  it('lists connections without their secrets, and a project\'s links', async () => {
    await call(manageTool, { operation: 'link', projectId: project.id, pathWithNamespace: 'acme/old' });
    const view = await call(listTool, { projectId: project.id });
    expect(view.connections).toHaveLength(1);
    expect(view.connections[0]).toMatchObject({ id: connection.id, hasSecrets: true, authorityMounted: true, repositoryCount: 1 });
    expect(view.connections[0].secrets).toBeUndefined();
    expect(view.repositories.map((r: any) => r.pathWithNamespace)).toEqual(['acme/old']);
    expect(view.projectLinks).toHaveLength(1);
    expect(view.projectLinks[0].repository.pathWithNamespace).toBe('acme/old');
  });
});
