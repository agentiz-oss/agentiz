import { AbstractApp, AppManager, Collection, CollectionHandler } from '@nodeknit/app-manager';
import type { Migration } from '@nodeknit/app-manager';
import { AdminizerRouteMiddleware, AppAdminizer, generateAdminizerModelConfig } from '@nodeknit/app-adminizer';
import { AppMCP } from '@nodeknit/app-mcp';
import { AgentizAssistantService } from './lib/ai/AgentizAssistantService';
import { buildAgentizAgentSkills } from './lib/ai/agentSkills';
import cron, { type ScheduledTask } from 'node-cron';
import { migrations } from './migrations';
import { AgentProject } from './models/AgentProject';
import { AgentRole } from './models/AgentRole';
import { PipelineSpec } from './models/PipelineSpec';
import { AgentTask } from './models/AgentTask';
import { AgentRun } from './models/AgentRun';
import { AgentStageExecution } from './models/AgentStageExecution';
import { AgentRunLog } from './models/AgentRunLog';
import { AgentRunJob } from './models/AgentRunJob';
import { AgentRunEventDedup } from './models/AgentRunEventDedup';
import { AgentRunResultDedup } from './models/AgentRunResultDedup';
import { AgentWorker } from './models/AgentWorker';
import { AgentTaskSource } from './models/AgentTaskSource';
import { AgentTaskComment } from './models/AgentTaskComment';
import { AgentGitConnection } from './models/AgentGitConnection';
import { AgentRepository } from './models/AgentRepository';
import { AgentProjectRepository } from './models/AgentProjectRepository';
import { AgentRunDiff } from './models/AgentRunDiff';
import { AgentJobReaperService } from './services/AgentJobReaperService';
import { AgentWorkerQueueService } from './services/AgentWorkerQueueService';
import { AgentWorkerRegistryService } from './services/AgentWorkerRegistryService';
import { GitSyncService } from './services/GitSyncService';
import { TaskSourceSyncService } from './services/TaskSourceSyncService';
import { RepositoryResolverService } from './services/RepositoryResolverService';
import {
    createGitProvider,
    githubProviderAdapter,
    registerTaskGitProviderResolver,
    registerTaskRepositoryResolver,
    unregisterTaskGitProviderResolver,
    unregisterTaskRepositoryResolver,
} from './lib/git';
import type { GitProviderAdapter } from './lib/git';
import { GitProviderCollectionHandler } from './lib/git/GitProviderCollection';
import { githubIssuesTaskManagerAdapter } from './lib/taskManager/GitHubIssuesTaskManager';
import { TaskManagerCollectionHandler } from './lib/taskManager/TaskManagerCollection';
import type { TaskManagerAdapter } from './lib/taskManager';
import { maskProjectForUI, restoreMaskedSecrets } from './lib/secrets';
import { taskRoutes } from './lib/taskRoutes';
import { repositoryRoutes } from './lib/repositoryRoutes';
import { pipelineRoutes } from './lib/pipelineRoutes';
import { workerRoutes } from './lib/workerRoutes';
import { runRoutes } from './lib/runRoutes';
import { createWorkerApiRouter, WORKER_API_BASE } from './lib/workerApiRouter';
import { agentizMcpTools } from './mcp/agentizTools';
import type { IMcpTool } from '@nodeknit/app-mcp';

/** Sync cadence for every active project. Per-project pollIntervalSec is honoured inside the tick. */
const SYNC_CRON = process.env.AGENTIZ_SYNC_CRON ?? '*/10 * * * *';

export class AppAgentiz extends AbstractApp {
    appId: string = 'app-agentiz';
    name: string = 'App Agentiz';

    private syncTask: ScheduledTask | null = null;

    @Collection
    migrations: Migration[] = migrations.umzug;

    @Collection
    models: any[] = [
        AgentProject,
        AgentRole,
        PipelineSpec,
        AgentTask,
        AgentRun,
        AgentStageExecution,
        AgentRunLog,
        AgentRunJob,
        AgentRunEventDedup,
        AgentRunResultDedup,
        AgentWorker,
        AgentTaskSource,
        AgentTaskComment,
        AgentGitConnection,
        AgentRepository,
        AgentProjectRepository,
        AgentRunDiff,
    ];

    @Collection
    mcpTools: IMcpTool[] = agentizMcpTools;

    /**
     * Git hosting adapters. app-agentiz owns the collection and the abstraction, every concrete
     * platform is contributed by a layer — GitHub below, GitLab by app-agentiz-gitlab-integration.
     */
    @CollectionHandler('gitProviders')
    gitProvidersHandler = new GitProviderCollectionHandler();

    @Collection
    gitProviders: GitProviderAdapter[] = [githubProviderAdapter];

    /**
     * Remote task/project management systems. Separate from `gitProviders` on purpose: a project
     * may read its tasks from Jira and push its code to GitLab, so "where tasks come from" and
     * "where code lives" are independent extension points. app-agentiz ships the GitHub Issues
     * adapter; GitLab comes from app-agentiz-gitlab-integration, Jira/YouTrack/… from their own
     * layers.
     */
    @CollectionHandler('taskManagers')
    taskManagersHandler = new TaskManagerCollectionHandler();

    @Collection
    taskManagers: TaskManagerAdapter[] = [githubIssuesTaskManagerAdapter];

    @Collection
    adminizerMiddlewares: AdminizerRouteMiddleware[] = [
        // The built-in task tracker and task-source management live in lib/taskRoutes.ts.
        ...taskRoutes,
        // Connections, mirrored repositories and project links — shared by every platform.
        ...repositoryRoutes,
        // ACP-agent assignment and pipeline-spec editing.
        ...pipelineRoutes,
        // Worker fleet: registration, tokens, allowlists.
        ...workerRoutes,
        // One run's stages, logs and diff.
        ...runRoutes,
        {
            route: '/agentiz',
            method: 'get',
            handler: async (req, res) => {
                const method = req.query._method as string | undefined;

                if (method === 'getProjects') {
                    const projects = await AgentProject.findAll({ order: [['createdAt', 'DESC']] });
                    return res.json({ data: projects.map(maskProjectForUI) });
                }

                if (method === 'getProjectStats') {
                    const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : '';
                    if (!projectId) return res.status(400).json({ message: 'projectId is required' });

                    const [taskRows, runRows, pipelineCount, workers] = await Promise.all([
                        AgentTask.findAll({
                            where: { projectId },
                            attributes: ['status', [AgentTask.sequelize!.fn('COUNT', '*'), 'count']],
                            group: ['status'],
                            raw: true,
                        }) as unknown as Promise<Array<{ status: string; count: string }>>,
                        AgentRun.findAll({
                            where: { projectId },
                            attributes: ['status', [AgentRun.sequelize!.fn('COUNT', '*'), 'count']],
                            group: ['status'],
                            raw: true,
                        }) as unknown as Promise<Array<{ status: string; count: string }>>,
                        PipelineSpec.count({ where: { projectId } }),
                        AgentWorkerRegistryService.list(),
                    ]);

                    // A worker is not scoped to a project until an allowlist says so, so "workers
                    // available here" counts an empty allowlist (= every project) as included.
                    const projectWorkers = workers.filter(
                        (worker) => !worker.allowedProjectIds || worker.allowedProjectIds.length === 0
                            || worker.allowedProjectIds.includes(projectId),
                    );
                    const onlineWorkers = projectWorkers.filter(
                        (worker) => worker.status === 'active' && worker.contactState() === 'online',
                    ).length;

                    const recentRuns = await AgentRun.findAll({
                        where: { projectId },
                        order: [['createdAt', 'DESC']],
                        limit: 8,
                    });

                    return res.json({
                        data: {
                            tasksByStatus: Object.fromEntries(taskRows.map((row) => [row.status, Number(row.count)])),
                            runsByStatus: Object.fromEntries(runRows.map((row) => [row.status, Number(row.count)])),
                            pipelineCount,
                            workers: { total: projectWorkers.length, online: onlineWorkers },
                            recentRuns: recentRuns.map((run) => run.toJSON()),
                        },
                    });
                }

                return req.Inertia.render({
                    component: 'module',
                    props: {
                        moduleComponent: '/dashboard/modules/AgentizHome.js',
                    },
                });
            },
        },
        {
            route: '/agentiz',
            method: 'post',
            handler: async (req, res) => {
                try {
                    const method = req.body?._method as string | undefined;

                    if (method === 'testConnection') {
                        const projectId = String(req.body?.projectId ?? '');
                        const project = await AgentProject.findByPk(projectId);
                        if (!project) return res.status(404).json({ message: 'Project not found' });
                        const provider = createGitProvider(project);
                        const ok = await provider.testConnection();
                        return res.json({ data: { ok } });
                    }

                    if (method === 'updateProjectSecrets') {
                        const projectId = String(req.body?.projectId ?? '');
                        const project = await AgentProject.findByPk(projectId);
                        if (!project) return res.status(404).json({ message: 'Project not found' });
                        // Sending back SECRET_MASK means "keep what is stored" — see lib/secrets.ts.
                        const secrets = restoreMaskedSecrets(req.body?.secrets, project.secrets);
                        await project.update({ secrets });
                        return res.json({ data: maskProjectForUI(project) });
                    }

                    if (method === 'syncProject') {
                        const projectId = String(req.body?.projectId ?? '');
                        if (!projectId) return res.status(400).json({ message: 'projectId is required' });
                        const result = await GitSyncService.syncProject(projectId);
                        // One "синхронизировать" action covers everything wired to the project:
                        // its own repository plus every configured task manager.
                        const sources = await TaskSourceSyncService.syncProject(projectId);
                        return res.json({ data: { ...result, sources } });
                    }

                    if (method === 'syncAll') {
                        const results = await GitSyncService.syncAllActiveProjects();
                        return res.json({ data: results });
                    }

                    return res.status(400).json({ message: `Unknown _method: ${method ?? '(none)'}` });
                } catch (error: any) {
                    return res.status(400).json({ message: error?.message ?? String(error) });
                }
            },
        },
    ];

    constructor(appManager: AppManager) {
        super(appManager);
    }

    async mount(): Promise<void> {
        // Models are registered by _mount() after the constructor runs, so the UserAP
        // association and Adminizer configs are wired here.
        AgentProject.associate(this.appManager.sequelize);

        const configs = [
            generateAdminizerModelConfig(AgentProject),
            generateAdminizerModelConfig(AgentRole),
            generateAdminizerModelConfig(PipelineSpec),
            generateAdminizerModelConfig(AgentTask),
            generateAdminizerModelConfig(AgentRun),
            generateAdminizerModelConfig(AgentStageExecution),
            generateAdminizerModelConfig(AgentRunLog),
            generateAdminizerModelConfig(AgentRunJob),
            generateAdminizerModelConfig(AgentWorker),
            generateAdminizerModelConfig(AgentTaskSource),
            generateAdminizerModelConfig(AgentTaskComment),
            generateAdminizerModelConfig(AgentGitConnection),
            generateAdminizerModelConfig(AgentRepository),
            generateAdminizerModelConfig(AgentProjectRepository),
            generateAdminizerModelConfig(AgentRunDiff),
        ].map((item) => ({ appId: this.appId, item }));
        await this.appManager.collectionStorage.append('adminizerModelConfigs', configs);

        // "Which repository does this task belong to" is now a core question: the link lives in
        // agentiz_project_repositories, and provider layers only supply tokens and adapters. A
        // project with no links at all resolves to null here and falls back to its own repoConfig.
        registerTaskGitProviderResolver(this.appId, (task, project) =>
            RepositoryResolverService.resolveProvider(task, project),
        );
        registerTaskRepositoryResolver(this.appId, (task, project) =>
            RepositoryResolverService.resolveRepository(task, project),
        );

        // Mounted on the root app, outside Adminizer's /dashboard prefix: workers are machines with
        // their own bearer tokens, not admin sessions. See lib/workerApiRouter.ts.
        this.appManager.app.use(WORKER_API_BASE, createWorkerApiRouter());
        console.log(`[AppAgentiz] worker API mounted at ${WORKER_API_BASE}`);

        AgentWorkerQueueService.start();
        // Runs whether or not the in-process drainer does: with the remote Worker API enabled the
        // drainer is off, and that is exactly when leases get abandoned.
        AgentJobReaperService.start();

        if (process.env.AGENTIZ_SYNC_ENABLED === 'true') {
            this.syncTask = cron.schedule(SYNC_CRON, () => {
                void GitSyncService.syncAllActiveProjects().catch((error) => {
                    console.error('[AppAgentiz] scheduled sync failed:', error);
                });
                // Configured task managers are pulled on the same cadence. TaskSourceSyncService
                // collects its errors per source instead of throwing, so one broken source cannot
                // stop the others.
                void TaskSourceSyncService.syncAllActiveProjects().catch((error) => {
                    console.error('[AppAgentiz] scheduled task-source sync failed:', error);
                });
            });
            console.log(`[AppAgentiz] tracker sync scheduled: ${SYNC_CRON}`);
        } else {
            console.log('[AppAgentiz] tracker sync disabled (set AGENTIZ_SYNC_ENABLED=true to enable)');
        }

        // app-adminizer and app-mcp are both declared appDependencies above, so both are already
        // mounted by the time this runs. The panel itself is entirely built into adminizer 5's
        // aiAssistant module; this only supplies the model + the MCP tool bridge.
        // AppManager.getApp() looks apps up by class name, but AppStorage is keyed by appId, so
        // it never finds anything here — go straight to appStorage with the real key instead.
        const adminizerApp = this.appManager.appStorage.get('app-adminizer')?.appInstance as AppAdminizer | undefined;
        const mcpApp = this.appManager.appStorage.get('app-mcp')?.appInstance as AppMCP | undefined;
        if (adminizerApp && mcpApp) {
            // Adminizer 5.0.0-build.12 ships read/update data skills but no create; add it here
            // until a build that ships create_model_record itself lands (then `add()` below would
            // throw on the duplicate id, which is exactly the signal to delete this).
            for (const skill of buildAgentizAgentSkills(adminizerApp.adminizer)) {
                try {
                    adminizerApp.adminizer.aiAssistantAgentSkillHandler.add(skill, this.appId);
                } catch (error) {
                    console.warn(`[AppAgentiz] agent skill "${skill.id}" is already provided by adminizer, keeping the built-in one`);
                }
            }
            adminizerApp.adminizer.aiAssistantHandler.registerModel(
                new AgentizAssistantService(mcpApp, this.appManager),
                this.appId,
            );
            console.log('[AppAgentiz] Agentiz Assistant registered with the Adminizer AI panel');
        } else {
            console.warn('[AppAgentiz] app-adminizer or app-mcp instance not found; Agentiz Assistant not registered');
        }
    }

    async unmount(): Promise<void> {
        if (this.syncTask) {
            this.syncTask.stop();
            this.syncTask = null;
        }
        unregisterTaskGitProviderResolver(this.appId);
        unregisterTaskRepositoryResolver(this.appId);
        AgentWorkerQueueService.stop();
        AgentJobReaperService.stop();
    }
}

export default AppAgentiz;
