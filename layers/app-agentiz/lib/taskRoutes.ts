import fs from 'fs';
import type { AdminizerRouteMiddleware } from '@nodeknit/app-adminizer';
import { AgentProject } from '../models/AgentProject';
import { AgentTask } from '../models/AgentTask';
import { AgentTaskAttachment } from '../models/AgentTaskAttachment';
import { AgentTaskSource } from '../models/AgentTaskSource';
import { AgentPipelineService } from '../services/AgentPipelineService';
import { AgentTaskService, TaskServiceError } from '../services/AgentTaskService';
import { TaskSourceSyncService } from '../services/TaskSourceSyncService';
import { describeTaskManagers, getTaskManagerAdapter } from '../lib/taskManager';
import {
  AttachmentError,
  attachmentDiskPath,
  deleteAttachment,
  describeAttachment,
  readBodyWithLimit,
  storeAttachment,
} from './taskAttachments';
import { maskTaskSourceForUI, restoreMaskedTaskSourceSecrets } from './secrets';
import { describeRunOverride, normalizeRunOverride } from './harnessCatalog';
import { guardProject, requirePanelUser, panelActor, requestAccessCache } from './access/panelGuard';
import { projectIdsForUser } from './access/projectAccess';
import { PROJECT_TOKENS } from './access/tokens';
import { AgentRun } from '../models/AgentRun';
import { AgentTaskComment } from '../models/AgentTaskComment';
import type { AgentRunExecutorOverride } from '../types/agentiz';

/** Whoever is driving the admin panel — recorded as the author of manual changes. */
function actorOf(req: any): { id: number | null; name: string } {
  const user = req.session?.UserAP ?? req.user ?? null;
  return {
    id: typeof user?.id === 'number' ? user.id : null,
    name: user?.login ?? user?.fullName ?? 'admin',
  };
}

function errorResponse(res: any, error: unknown) {
  if (error instanceof TaskServiceError || error instanceof AttachmentError) {
    return res.status(error.status).json({ message: error.message });
  }
  return res.status(400).json({ message: error instanceof Error ? error.message : String(error) });
}

/** True for content a browser may render inline off our origin. Everything else downloads. */
function isInlineSafe(mimeType: string | null): boolean {
  return !!mimeType && (/^image\/(png|jpeg|gif|webp|avif|bmp)$/.test(mimeType) || mimeType === 'application/pdf');
}

/**
 * Every endpoint in this file checks the session and the project itself: the
 * `adminizerMiddlewares` dispatcher runs **before** Adminizer's auth and permission policies, so
 * without these calls a JSON route under `/dashboard` decides nothing at all. `requirePanelUser`
 * is the authentication half, `guardProject` the authorisation half — both in
 * `lib/access/panelGuard.ts`, so the panel and the mobile API cannot drift apart.
 *
 * A task, a comment, an attachment and a source are all reached through their project: the id the
 * caller sent is resolved to a project first, and the right is checked on that. Which token an
 * endpoint names is written out per endpoint rather than derived, so a new one has to choose.
 */
async function guardTask(req: any, res: any, taskId: string, token: string): Promise<AgentTask | null> {
  const task = await AgentTask.findByPk(taskId);
  // A task in a project the caller cannot see answers 404 through `guardProject`, which is the
  // same answer a task that does not exist gets — the API never confirms an id.
  if (!task) {
    res.status(404).json({ message: 'Task not found' });
    return null;
  }
  return (await guardProject(req, res, task.projectId, token)) ? task : null;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Splits a submitted flat form into `config` and `secrets` using the adapter's own field list.
 *
 * Which keys are secret is the adapter's decision, not the core's: a Jira source needs an API
 * token, a Redmine one an API key. Anything the adapter did not declare is kept in config, so a
 * newer adapter's extra fields survive an older UI.
 */
function splitByAdapterFields(
  type: string,
  values: Record<string, unknown>,
): { config: Record<string, unknown>; secrets: Record<string, unknown> } {
  const adapter = getTaskManagerAdapter(type);
  const secretKeys = new Set(
    (adapter?.configFields ?? []).filter((field) => field.kind === 'secret').map((field) => field.key),
  );
  const config: Record<string, unknown> = {};
  const secrets: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values ?? {})) {
    if (secretKeys.has(key)) secrets[key] = value;
    else config[key] = value;
  }
  return { config, secrets };
}

/**
 * The built-in task tracker's HTTP surface, mounted under Adminizer's prefix at
 * `/dashboard/agentiz-tasks`. Read operations go through GET `?_method=`, writes through POST
 * `_method`, matching the convention the rest of the Agentiz admin pages already use.
 */
export const taskRoutes: AdminizerRouteMiddleware[] = [
  /**
   * Attachment upload. Its own route, listed before the generic `/agentiz-tasks` handlers because
   * the dispatcher runs every prefix match in registration order and this one must win.
   *
   * The file arrives as the raw request body (`application/octet-stream`, name/task in the query),
   * not as multipart: the panel's global body parsers only touch JSON and urlencoded, so the
   * stream reaches this handler untouched and no multipart dependency is needed. One file per
   * request — the UI loops, which also gives it per-file progress for free.
   */
  {
    route: '/agentiz-tasks/attachments',
    method: 'post',
    handler: async (req, res) => {
      try {
        const taskId = str(req.query?.taskId);
        const fileName = str(req.query?.fileName);
        if (!taskId) return res.status(400).json({ message: 'taskId query parameter is required' });
        if (!fileName) return res.status(400).json({ message: 'fileName query parameter is required' });
        if (!await guardTask(req, res, taskId, PROJECT_TOKENS.taskWrite)) return undefined;
        const task = await AgentTask.findByPk(taskId);
        if (!task) return res.status(404).json({ message: 'Task not found' });

        const contentType = str(req.headers?.['content-type']).split(';')[0].trim().toLowerCase();
        const content = await readBodyWithLimit(req);
        const actor = actorOf(req);
        const attachment = await storeAttachment({
          taskId,
          fileName,
          // The browser sends the file's own type; a generic octet-stream means "unknown".
          mimeType: contentType && contentType !== 'application/octet-stream' ? contentType : null,
          content,
          uploadedById: actor.id,
          uploadedByName: actor.name,
        });
        // The thread records the upload the same way it records every manual change — and through
        // the conversation snapshot this line is also how a run learns a file appeared mid-thread.
        await AgentTaskService.addComment(taskId, {
          authorKind: 'system',
          authorName: actor.name,
          authorId: actor.id,
          body: `Прикреплён файл «${attachment.fileName}» (${attachment.sizeBytes} байт)`,
          meta: { kind: 'attachment.added', attachmentId: attachment.id },
        });
        return res.json({ data: describeAttachment(attachment) });
      } catch (error) {
        return errorResponse(res, error);
      }
    },
  },
  {
    route: '/agentiz-tasks',
    method: 'get',
    handler: async (req, res) => {
      try {
        const method = str(req.query._method);
        if (!requirePanelUser(req, res)) return undefined;

        if (method === 'getFilters') {
          return res.json({ data: await AgentTaskService.filterOptions() });
        }

        if (method === 'getTasks') {
          const assigneeRaw = req.query.assigneeId;
          const requested = str(req.query.projectId);
          if (requested && !await guardProject(req, res, requested, PROJECT_TOKENS.read)) return undefined;
          const result = await AgentTaskService.list({
            projectId: requested || undefined,
            // No project asked for means "everything I can see", not "everything": the panel's
            // own generic CRUD is filtered by the access graph, but this endpoint reads Sequelize
            // directly and the graph never sees it.
            projectIds: requested
              ? undefined
              : await projectIdsForUser(panelActor(req), PROJECT_TOKENS.read, requestAccessCache(req)),
            status: str(req.query.status) || undefined,
            priority: str(req.query.priority) || undefined,
            sourceType: str(req.query.sourceType) || undefined,
            search: str(req.query.search) || undefined,
            tag: str(req.query.tag) || undefined,
            assigneeId:
              assigneeRaw === undefined || assigneeRaw === ''
                ? undefined
                : assigneeRaw === 'none'
                  ? null
                  : Number(assigneeRaw),
            limit: req.query.limit ? Number(req.query.limit) : undefined,
            offset: req.query.offset ? Number(req.query.offset) : undefined,
          });
          return res.json({ data: result.items, meta: { total: result.total } });
        }

        if (method === 'getTask') {
          const taskId = str(req.query.taskId);
          if (!taskId) return res.status(400).json({ message: 'taskId is required' });
          if (!await guardTask(req, res, taskId, PROJECT_TOKENS.read)) return undefined;
          return res.json({ data: await AgentTaskService.details(taskId) });
        }

        if (method === 'getTaskManagers') {
          return res.json({ data: describeTaskManagers() });
        }

        if (method === 'downloadAttachment') {
          const attachmentId = str(req.query.attachmentId);
          if (!attachmentId) return res.status(400).json({ message: 'attachmentId is required' });
          const attachment = await AgentTaskAttachment.findByPk(attachmentId);
          if (!attachment) return res.status(404).json({ message: 'Attachment not found' });
          if (!await guardTask(req, res, attachment.taskId, PROJECT_TOKENS.read)) return undefined;
          const diskPath = attachmentDiskPath(attachment);
          if (!fs.existsSync(diskPath)) return res.status(404).json({ message: 'Attachment file is missing on disk' });
          // `inline=1` is how the UI shows thumbnails; anything not image/pdf still downloads.
          const inline = str(req.query.inline) === '1' && isInlineSafe(attachment.mimeType);
          res.setHeader('Content-Type', inline ? attachment.mimeType! : 'application/octet-stream');
          res.setHeader('X-Content-Type-Options', 'nosniff');
          res.setHeader('Content-Length', String(attachment.sizeBytes));
          res.setHeader(
            'Content-Disposition',
            `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(attachment.fileName)}`,
          );
          fs.createReadStream(diskPath).pipe(res);
          return undefined;
        }

        if (method === 'getSources') {
          const projectId = str(req.query.projectId);
          if (projectId && !await guardProject(req, res, projectId, PROJECT_TOKENS.read)) return undefined;
          const visible = projectId
            ? [projectId]
            : await projectIdsForUser(panelActor(req), PROJECT_TOKENS.read, requestAccessCache(req));
          const sources = await AgentTaskSource.findAll({
            where: { projectId: visible },
            order: [['createdAt', 'ASC']],
          });
          return res.json({
            data: sources.map((source) => ({
              ...maskTaskSourceForUI(source),
              // A source whose layer is not mounted must be visible as broken, not silently idle.
              available: Boolean(getTaskManagerAdapter(source.type)),
              typeTitle: getTaskManagerAdapter(source.type)?.title ?? source.type,
            })),
          });
        }

        return req.Inertia.render({
          component: 'module',
          props: {
            moduleComponent: '/dashboard/modules/AgentizTasks.js',
          },
        });
      } catch (error) {
        return errorResponse(res, error);
      }
    },
  },
  {
    route: '/agentiz-tasks',
    method: 'post',
    handler: async (req, res) => {
      try {
        const method = str(req.body?._method);
        const actor = actorOf(req);
        if (!requirePanelUser(req, res)) return undefined;

        if (method === 'createTask') {
          if (!await guardProject(req, res, str(req.body?.projectId), PROJECT_TOKENS.taskWrite)) return undefined;
          return res.json({
            data: await AgentTaskService.create(
              {
                projectId: str(req.body?.projectId),
                title: str(req.body?.title),
                description: str(req.body?.description),
                tags: Array.isArray(req.body?.tags) ? req.body.tags.map(String) : undefined,
                priority: str(req.body?.priority) || undefined,
              },
              actor,
            ),
          });
        }

        if (method === 'updateTask') {
          const taskId = str(req.body?.taskId);
          if (!taskId) return res.status(400).json({ message: 'taskId is required' });
          if (!await guardTask(req, res, taskId, PROJECT_TOKENS.taskWrite)) return undefined;
          const patch: Record<string, unknown> = {};
          for (const key of ['status', 'priority', 'title', 'description'] as const) {
            if (req.body?.[key] !== undefined) patch[key] = str(req.body[key]);
          }
          if (req.body?.tags !== undefined) {
            patch.tags = Array.isArray(req.body.tags) ? req.body.tags.map(String) : [];
          }
          if (req.body?.assigneeId !== undefined) {
            patch.assigneeId = req.body.assigneeId === null || req.body.assigneeId === ''
              ? null
              : Number(req.body.assigneeId);
          }
          return res.json({ data: await AgentTaskService.update(taskId, patch as any, actor) });
        }

        if (method === 'addComment') {
          const taskId = str(req.body?.taskId);
          if (!taskId) return res.status(400).json({ message: 'taskId is required' });
          if (!await guardTask(req, res, taskId, PROJECT_TOKENS.taskWrite)) return undefined;
          return res.json({
            data: await AgentTaskService.addComment(taskId, {
              // The UI can only ever post as a human; agent comments are written by runs.
              authorKind: 'human',
              authorName: actor.name,
              authorId: actor.id,
              body: str(req.body?.body),
            }),
          });
        }

        if (method === 'deleteAttachment') {
          const attachmentId = str(req.body?.attachmentId);
          if (!attachmentId) return res.status(400).json({ message: 'attachmentId is required' });
          const attachment = await AgentTaskAttachment.findByPk(attachmentId);
          if (!attachment) return res.status(404).json({ message: 'Attachment not found' });
          if (!await guardTask(req, res, attachment.taskId, PROJECT_TOKENS.taskWrite)) return undefined;
          const taskId = attachment.taskId;
          const fileName = attachment.fileName;
          await deleteAttachment(attachment);
          await AgentTaskService.addComment(taskId, {
            authorKind: 'system',
            authorName: actor.name,
            authorId: actor.id,
            body: `Удалён файл «${fileName}»`,
            meta: { kind: 'attachment.deleted', attachmentId },
          });
          return res.json({ data: { deleted: true } });
        }

        if (method === 'publishComment') {
          const commentId = str(req.body?.commentId);
          if (!commentId) return res.status(400).json({ message: 'commentId is required' });
          const comment = await AgentTaskComment.findByPk(commentId);
          if (!comment) return res.status(404).json({ message: 'Comment not found' });
          if (!await guardTask(req, res, comment.taskId, PROJECT_TOKENS.taskWrite)) return undefined;
          return res.json({ data: await AgentTaskService.pushCommentUpstream(commentId) });
        }

        if (method === 'pullComments') {
          const taskId = str(req.body?.taskId);
          if (!taskId) return res.status(400).json({ message: 'taskId is required' });
          if (!await guardTask(req, res, taskId, PROJECT_TOKENS.taskWrite)) return undefined;
          return res.json({ data: await AgentTaskService.pullComments(taskId) });
        }

        if (method === 'runTask') {
          const taskId = str(req.body?.taskId);
          if (!taskId) return res.status(400).json({ message: 'taskId is required' });
          if (!await guardTask(req, res, taskId, PROJECT_TOKENS.runOperate)) return undefined;
          let override: AgentRunExecutorOverride | null;
          try {
            override = normalizeRunOverride(req.body);
          } catch (error) {
            return res.status(400).json({ message: error instanceof Error ? error.message : String(error) });
          }
          const run = await AgentPipelineService.runTask(taskId, 'manual', { executorOverride: override });
          await AgentTaskService.addComment(taskId, {
            authorKind: 'system',
            authorName: actor.name,
            authorId: actor.id,
            runId: run.id,
            body: `Запущен пайплайн${describeRunOverride(override)}, run ${run.id}`,
            meta: { kind: 'run.started', runId: run.id, executorKey: override?.executorKey ?? null, override },
          });
          return res.json({ data: run.toJSON() });
        }

        if (method === 'cancelRun') {
          const runId = str(req.body?.runId);
          if (!runId) return res.status(400).json({ message: 'runId is required' });
          const run = await AgentRun.findByPk(runId);
          if (!run) return res.status(404).json({ message: 'Run not found' });
          if (!await guardProject(req, res, run.projectId, PROJECT_TOKENS.runOperate)) return undefined;
          return res.json({ data: (await AgentPipelineService.cancelRun(runId)).toJSON() });
        }

        // ---- task sources ------------------------------------------------------------------

        if (method === 'createSource') {
          const projectId = str(req.body?.projectId);
          const type = str(req.body?.type);
          const name = str(req.body?.name);
          if (!projectId || !type || !name) {
            return res.status(400).json({ message: 'projectId, type and name are required' });
          }
          if (!await guardProject(req, res, projectId, PROJECT_TOKENS.projectConfigure)) return undefined;
          if (!(await AgentProject.findByPk(projectId))) {
            return res.status(404).json({ message: 'Project not found' });
          }
          if (!getTaskManagerAdapter(type)) {
            return res.status(400).json({ message: `No task manager adapter for "${type}" is mounted` });
          }
          const { config, secrets } = splitByAdapterFields(type, req.body?.values ?? {});
          const source = await AgentTaskSource.create({
            projectId,
            name,
            type,
            config,
            secrets,
            isActive: req.body?.isActive !== false,
            syncComments: Boolean(req.body?.syncComments),
            lastSyncedAt: null,
            lastError: null,
          });
          return res.json({ data: maskTaskSourceForUI(source) });
        }

        if (method === 'updateSource') {
          const sourceId = str(req.body?.sourceId);
          const source = await AgentTaskSource.findByPk(sourceId);
          if (!source) return res.status(404).json({ message: 'Source not found' });
          if (!await guardProject(req, res, source.projectId, PROJECT_TOKENS.projectConfigure)) return undefined;
          const { config, secrets } = splitByAdapterFields(source.type, req.body?.values ?? {});
          await source.update({
            name: str(req.body?.name) || source.name,
            config: Object.keys(config).length ? config : source.config,
            // A submitted mask means "keep the stored secret" — see lib/secrets.ts.
            secrets: restoreMaskedTaskSourceSecrets(secrets, source.secrets),
            isActive: req.body?.isActive !== undefined ? Boolean(req.body.isActive) : source.isActive,
            syncComments:
              req.body?.syncComments !== undefined ? Boolean(req.body.syncComments) : source.syncComments,
          });
          return res.json({ data: maskTaskSourceForUI(source) });
        }

        if (method === 'deleteSource') {
          const sourceId = str(req.body?.sourceId);
          const source = await AgentTaskSource.findByPk(sourceId);
          if (!source) return res.status(404).json({ message: 'Source not found' });
          if (!await guardProject(req, res, source.projectId, PROJECT_TOKENS.projectConfigure)) return undefined;
          await source.destroy();
          return res.json({ data: { deleted: true } });
        }

        if (method === 'testSource') {
          const sourceId = str(req.body?.sourceId);
          const source = sourceId ? await AgentTaskSource.findByPk(sourceId) : null;
          if (!source) return res.status(404).json({ message: 'Source not found' });
          if (!await guardProject(req, res, source.projectId, PROJECT_TOKENS.projectConfigure)) return undefined;
          return res.json({ data: { ok: await TaskSourceSyncService.testSource(sourceId) } });
        }

        if (method === 'syncSource') {
          const sourceId = str(req.body?.sourceId);
          const source = sourceId ? await AgentTaskSource.findByPk(sourceId) : null;
          if (!source) return res.status(404).json({ message: 'Source not found' });
          if (!await guardProject(req, res, source.projectId, PROJECT_TOKENS.projectConfigure)) return undefined;
          return res.json({ data: await TaskSourceSyncService.syncSource(sourceId) });
        }

        if (method === 'syncProjectSources') {
          const projectId = str(req.body?.projectId);
          if (!await guardProject(req, res, projectId, PROJECT_TOKENS.projectConfigure)) return undefined;
          return res.json({ data: await TaskSourceSyncService.syncProject(projectId) });
        }

        return res.status(400).json({ message: `Unknown _method: ${method || '(none)'}` });
      } catch (error) {
        return errorResponse(res, error);
      }
    },
  },
];
