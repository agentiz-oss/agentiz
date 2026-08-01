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
import { AgentJobReaperService } from './services/AgentJobReaperService';
import { AgentPipelineService } from './services/AgentPipelineService';
import { AgentWorkerApiService } from './services/AgentWorkerApiService';
import { AgentWorkerQueueService } from './services/AgentWorkerQueueService';
import { AgentWorkerRegistryService, WorkerRegistryError } from './services/AgentWorkerRegistryService';
import { GitSyncService } from './services/GitSyncService';
import { TaskSourceSyncService } from './services/TaskSourceSyncService';
import { assertValidSpec, PipelineSpecError } from './services/PipelineSpecResolver';
import { createGitProvider, githubProviderAdapter } from './lib/git';
import type { GitProviderAdapter } from './lib/git';
import { GitProviderCollectionHandler } from './lib/git/GitProviderCollection';
import { githubIssuesTaskManagerAdapter } from './lib/taskManager/GitHubIssuesTaskManager';
import { TaskManagerCollectionHandler } from './lib/taskManager/TaskManagerCollection';
import { taskManagerTitle, type TaskManagerAdapter } from './lib/taskManager';
import { maskProjectForUI, maskWorkerForUI, restoreMaskedSecrets } from './lib/secrets';
import { taskRoutes } from './lib/taskRoutes';
import { createWorkerApiRouter, WORKER_API_BASE } from './lib/workerApiRouter';
import { agentizMcpTools } from './mcp/agentizTools';
import type { IMcpTool } from '@nodeknit/app-mcp';

/** Sync cadence for every active project. Per-project pollIntervalSec is honoured inside the tick. */
const SYNC_CRON = process.env.AGENTIZ_SYNC_CRON ?? '*/10 * * * *';

/**
 * Base URL a worker should dial. Behind a proxy the request host is the internal one, so an
 * explicitly configured public origin always wins — the panel pastes this into a copyable command.
 */
function workerApiUrl(req: any): string {
    const configured = process.env.AGENTIZ_PUBLIC_URL?.replace(/\/+$/, '');
    const origin = configured || `${req.protocol}://${req.get('host')}`;
    return `${origin}${WORKER_API_BASE}`;
}

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
        {
            route: '/agentiz',
            method: 'get',
            handler: async (req, res) => {
                const method = req.query._method as string | undefined;

                if (method === 'getProjects') {
                    const projects = await AgentProject.findAll({ order: [['createdAt', 'DESC']] });
                    return res.json({ data: projects.map(maskProjectForUI) });
                }

                if (method === 'getTasks') {
                    const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : '';
                    const where = projectId ? { projectId } : {};
                    const tasks = await AgentTask.findAll({
                        where,
                        order: [['updatedAt', 'DESC']],
                        limit: 200,
                    });
                    // sourceTitle resolves the adapter key to its human name, so the list can say
                    // which task manager each task arrived from.
                    return res.json({
                        data: tasks.map((task) => ({
                            ...task.toJSON(),
                            sourceTitle: taskManagerTitle(task.sourceType),
                        })),
                    });
                }

                if (method === 'getRuns') {
                    const taskId = typeof req.query.taskId === 'string' ? req.query.taskId : '';
                    if (!taskId) return res.status(400).json({ message: 'taskId is required' });
                    const runs = await AgentRun.findAll({
                        where: { taskId },
                        order: [['createdAt', 'DESC']],
                        limit: 100,
                    });
                    return res.json({ data: runs.map((run) => run.toJSON()) });
                }

                if (method === 'getWorkers') {
                    const workers = await AgentWorkerRegistryService.list();
                    return res.json({
                        data: workers.map(maskWorkerForUI),
                        // The panel prints a ready-to-run register command, so it needs the URL the
                        // worker will actually dial — the public origin when one is configured.
                        meta: {
                            workerApiEnabled: AgentWorkerApiService.isEnabled(),
                            workerApiUrl: workerApiUrl(req),
                        },
                    });
                }

                if (method === 'getRunDetails') {
                    const runId = typeof req.query.runId === 'string' ? req.query.runId : '';
                    if (!runId) return res.status(400).json({ message: 'runId is required' });
                    const run = await AgentRun.findByPk(runId);
                    if (!run) return res.status(404).json({ message: 'Run not found' });
                    const stages = await AgentStageExecution.findAll({
                        where: { runId },
                        order: [['stageIndex', 'ASC']],
                    });
                    const logs = await AgentRunLog.findAll({
                        where: { runId },
                        order: [['createdAt', 'ASC']],
                        limit: 500,
                    });
                    return res.json({
                        data: {
                            run: run.toJSON(),
                            stages: stages.map((stage) => stage.toJSON()),
                            logs: logs.map((log) => log.toJSON()),
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

                    if (method === 'runTask') {
                        const taskId = String(req.body?.taskId ?? '');
                        if (!taskId) return res.status(400).json({ message: 'taskId is required' });
                        const run = await AgentPipelineService.runTask(taskId, 'manual');
                        return res.json({ data: run.toJSON() });
                    }

                    if (method === 'cancelRun') {
                        const runId = String(req.body?.runId ?? '');
                        if (!runId) return res.status(400).json({ message: 'runId is required' });
                        const run = await AgentPipelineService.cancelRun(runId);
                        return res.json({ data: run.toJSON() });
                    }

                    if (method === 'createWorker') {
                        try {
                            const actor = (req as any).session?.UserAP?.login ?? (req as any).user?.login ?? 'admin';
                            const projectIds = Array.isArray(req.body?.allowedProjectIds)
                                ? req.body.allowedProjectIds.map((id: unknown) => String(id))
                                : null;
                            const created = await AgentWorkerRegistryService.create({
                                name: String(req.body?.name ?? ''),
                                allowedProjectIds: projectIds,
                                createdBy: String(actor),
                            });
                            // The token leaves the server exactly once, here: only its hash is stored.
                            return res.json({
                                data: {
                                    worker: maskWorkerForUI(created.worker),
                                    token: created.token,
                                    workerApiUrl: workerApiUrl(req),
                                },
                            });
                        } catch (error) {
                            if (error instanceof WorkerRegistryError) {
                                return res.status(error.status).json({ message: error.message, code: error.code });
                            }
                            throw error;
                        }
                    }

                    if (method === 'pauseWorker' || method === 'resumeWorker' || method === 'revokeWorker'
                        || method === 'deleteWorker' || method === 'rotateWorkerToken' || method === 'setWorkerProjects') {
                        const workerId = String(req.body?.workerId ?? '');
                        if (!workerId) return res.status(400).json({ message: 'workerId is required' });
                        const reason = typeof req.body?.reason === 'string' ? req.body.reason : null;
                        const projectIds = Array.isArray(req.body?.allowedProjectIds)
                            ? req.body.allowedProjectIds.map((id: unknown) => String(id))
                            : undefined;
                        try {
                            if (method === 'pauseWorker') {
                                return res.json({ data: maskWorkerForUI(await AgentWorkerRegistryService.pause(workerId, reason)) });
                            }
                            if (method === 'resumeWorker') {
                                return res.json({ data: maskWorkerForUI(await AgentWorkerRegistryService.resume(workerId)) });
                            }
                            if (method === 'revokeWorker') {
                                return res.json({ data: maskWorkerForUI(await AgentWorkerRegistryService.revoke(workerId, reason)) });
                            }
                            if (method === 'deleteWorker') {
                                await AgentWorkerRegistryService.remove(workerId);
                                return res.json({ data: { deleted: true } });
                            }
                            if (method === 'setWorkerProjects') {
                                const worker = await AgentWorkerRegistryService.setAllowedProjects(workerId, projectIds ?? null);
                                return res.json({ data: maskWorkerForUI(worker) });
                            }
                            // The rotated token is returned exactly once: it is stored only as a hash.
                            const rotated = await AgentWorkerRegistryService.rotateToken(workerId);
                            return res.json({
                                data: {
                                    worker: maskWorkerForUI(rotated.worker),
                                    token: rotated.token,
                                    workerApiUrl: workerApiUrl(req),
                                },
                            });
                        } catch (error) {
                            if (error instanceof WorkerRegistryError) {
                                return res.status(error.status).json({ message: error.message, code: error.code });
                            }
                            throw error;
                        }
                    }

                    if (method === 'validateSpec') {
                        try {
                            assertValidSpec(req.body?.spec);
                            return res.json({ data: { valid: true } });
                        } catch (error) {
                            if (error instanceof PipelineSpecError) {
                                return res.status(400).json({ message: error.message, errors: error.errors });
                            }
                            throw error;
                        }
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
        ].map((item) => ({ appId: this.appId, item }));
        await this.appManager.collectionStorage.append('adminizerModelConfigs', configs);

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
        AgentWorkerQueueService.stop();
        AgentJobReaperService.stop();
    }
}

export default AppAgentiz;
