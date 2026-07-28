import { AbstractApp, AppManager, Collection } from '@nodeknit/app-manager';
import type { Migration } from '@nodeknit/app-manager';
import { AdminizerRouteMiddleware, generateAdminizerModelConfig } from '@nodeknit/app-adminizer';
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
import { AgentPipelineService } from './services/AgentPipelineService';
import { AgentWorkerApiService, WorkerApiError } from './services/AgentWorkerApiService';
import { AgentWorkerQueueService } from './services/AgentWorkerQueueService';
import { GitSyncService } from './services/GitSyncService';
import { assertValidSpec, PipelineSpecError } from './services/PipelineSpecResolver';
import { createGitProvider } from './lib/git';
import { maskProjectForUI, restoreMaskedSecrets } from './lib/secrets';
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
    ];

    @Collection
    mcpTools: IMcpTool[] = agentizMcpTools;

    @Collection
    adminizerMiddlewares: AdminizerRouteMiddleware[] = [
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
                    return res.json({ data: tasks.map((task) => task.toJSON()) });
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
                        return res.json({ data: result });
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
        {
            route: '/api/agentiz/worker/v1',
            method: 'get',
            handler: async (req, res, next) => {
                if (req.path.endsWith('/healthz') || req.path.endsWith('/readyz')) {
                    return res.json({ ok: true, workerApiEnabled: AgentWorkerApiService.isEnabled() });
                }
                return next();
            },
        },
        {
            route: '/api/agentiz/worker/v1',
            method: 'post',
            handler: async (req, res, next) => {
                try {
                    const base = '/api/agentiz/worker/v1';
                    const baseIndex = req.path.indexOf(base);
                    const relativePath = baseIndex >= 0 ? req.path.slice(baseIndex + base.length) || '/' : req.path;
                    const auth = req.header('authorization') ?? '';

                    if (relativePath === '/claims') {
                        const claim = await AgentWorkerApiService.claim(req.body, auth);
                        if (!claim) return res.status(204).send();
                        return res.json(claim);
                    }

                    const heartbeat = relativePath.match(/^\/jobs\/([^/]+)\/heartbeat$/);
                    if (heartbeat) {
                        return res.json(await AgentWorkerApiService.heartbeat(heartbeat[1], req.body, auth));
                    }

                    const events = relativePath.match(/^\/jobs\/([^/]+)\/events:batch$/);
                    if (events) {
                        return res.json(await AgentWorkerApiService.recordEvents(events[1], req.body, auth));
                    }

                    const result = relativePath.match(/^\/jobs\/([^/]+)\/result$/);
                    if (result) {
                        return res.json(await AgentWorkerApiService.applyResult(result[1], req.body, auth));
                    }

                    const release = relativePath.match(/^\/jobs\/([^/]+)\/release$/);
                    if (release) {
                        return res.json(await AgentWorkerApiService.release(release[1], req.body, auth));
                    }

                    return next();
                } catch (error) {
                    if (error instanceof WorkerApiError) {
                        return res.status(error.status).json({ message: error.message });
                    }
                    return res.status(500).json({ message: error instanceof Error ? error.message : String(error) });
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
        ].map((item) => ({ appId: this.appId, item }));
        await this.appManager.collectionStorage.append('adminizerModelConfigs', configs);

        AgentWorkerQueueService.start();

        if (process.env.AGENTIZ_SYNC_ENABLED === 'true') {
            this.syncTask = cron.schedule(SYNC_CRON, () => {
                void GitSyncService.syncAllActiveProjects().catch((error) => {
                    console.error('[AppAgentiz] scheduled sync failed:', error);
                });
            });
            console.log(`[AppAgentiz] tracker sync scheduled: ${SYNC_CRON}`);
        } else {
            console.log('[AppAgentiz] tracker sync disabled (set AGENTIZ_SYNC_ENABLED=true to enable)');
        }
    }

    async unmount(): Promise<void> {
        if (this.syncTask) {
            this.syncTask.stop();
            this.syncTask = null;
        }
        AgentWorkerQueueService.stop();
    }
}

export default AppAgentiz;
