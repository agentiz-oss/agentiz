import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import cors from 'cors';
import type { Model, Sequelize } from 'sequelize';
import { bearerToken, verifyMobileToken } from './mobileAuth';
import { MobileAuthError, MobileAuthService } from '../services/MobileAuthService';
import { MobileDeviceService } from '../services/MobileDeviceService';
import { MobileInteractionService } from '../services/MobileInteractionService';
import { MobilePushService } from '../services/MobilePushService';
import { MobileProjectService } from '../services/MobileProjectService';
import { MobileRunService } from '../services/MobileRunService';
import { MobileTaskService } from '../services/MobileTaskService';
import type { AgentRunInteractionAction } from '../../app-agentiz/types/agentiz';

/** Public base path of the mobile API. Versioned so the app can pin a contract. */
export const MOBILE_API_BASE = '/api/agentiz/mobile/v1';

/** The authenticated UserAP instance is attached here by requireAuth for downstream handlers. */
interface AuthedRequest extends Request {
  mobileUser?: Model;
}

function errorResponse(res: Response, error: unknown) {
  // MobileAuthError and the tracker's TaskServiceError both carry the status they want reported.
  // Matching on the shape rather than the class keeps a validation error from app-agentiz (400,
  // "title is required") from being flattened into a 500 the client cannot act on.
  const status = (error as { status?: unknown } | null)?.status;
  if (error instanceof MobileAuthError || (typeof status === 'number' && status >= 400 && status < 600)) {
    return res.status(status as number).json({ message: (error as Error).message });
  }
  return res.status(500).json({ message: error instanceof Error ? error.message : String(error) });
}

/**
 * The mobile API is mounted on the root Express app, not through Adminizer's `adminizerMiddlewares`
 * collection — the same reasoning as the Worker API (see app-agentiz/lib/workerApiRouter.ts). That
 * collection prefixes every route with `/dashboard`, which would bury a machine-facing endpoint
 * behind the admin panel. Mobile clients carry their own JWT and have nothing to do with admin
 * sessions, so they get their own router.
 */
export function createMobileApiRouter(sequelize: Sequelize): Router {
  const router = express.Router();
  // Bearer-token auth, no cookies: a wildcard CORS origin is safe and lets a browser build of the
  // client call the same API a native build does.
  router.use(cors());
  router.use(express.json({ limit: '1mb' }));

  router.get(['/healthz', '/readyz'], (_req, res) => {
    res.json({ ok: true });
  });

  // Exchange admin credentials for a bearer token. Everything below requires that token.
  router.post('/auth/login', async (req, res) => {
    try {
      const result = await MobileAuthService.login(
        sequelize,
        String(req.body?.login ?? ''),
        String(req.body?.password ?? ''),
      );
      res.json(result);
    } catch (error) {
      errorResponse(res, error);
    }
  });

  const requireAuth = async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const token = bearerToken(req.header('authorization'));
      if (!token) throw new MobileAuthError(401, 'Bearer token is required');
      let payload;
      try {
        payload = verifyMobileToken(token);
      } catch {
        throw new MobileAuthError(401, 'Invalid or expired token');
      }
      req.mobileUser = await MobileAuthService.requireUser(sequelize, payload.sub);
      next();
    } catch (error) {
      errorResponse(res, error);
    }
  };

  router.get('/auth/me', requireAuth, (req: AuthedRequest, res) => {
    res.json({ user: MobileAuthService.toAuthUser(req.mobileUser) });
  });

  // Express types a route parameter as `string | string[]` (a `:id*` pattern can repeat), which no
  // service here accepts. One place to collapse it, rather than a cast at every call site.
  const idOf = (req: AuthedRequest, name = 'id') => String((req.params as Record<string, unknown>)[name] ?? '');

  /**
   * Push registration. The app calls this after it signs in and again whenever the OS hands it a
   * new token, so it is an idempotent upsert keyed by the token itself.
   *
   * `pushEnabled` tells the client whether the server can actually deliver anything — without
   * credentials the endpoint still records tokens (so enabling push later needs no app change) and
   * says so, which is the difference between "не настроено" and "не работает" in the app's settings.
   */
  router.post('/devices', requireAuth, async (req: AuthedRequest, res) => {
    try {
      const userId = Number(MobileAuthService.toAuthUser(req.mobileUser).id);
      const device = await MobileDeviceService.register(userId, {
        token: String(req.body?.token ?? ''),
        platform: String(req.body?.platform ?? ''),
        appVersion: req.body?.appVersion === undefined ? null : String(req.body.appVersion),
        deviceName: req.body?.deviceName === undefined ? null : String(req.body.deviceName),
      });
      res.json({
        data: { id: device.id, platform: device.platform },
        pushEnabled: MobilePushService.configured(),
      });
    } catch (error) {
      errorResponse(res, error);
    }
  });

  /**
   * Signing out: the phone stops being reachable for this user's questions. The token may be given
   * in the path or in the body — an FCM registration token is opaque and long, and putting it in a
   * URL is only safe as long as it happens to contain nothing that needs escaping.
   */
  router.delete(['/devices', '/devices/:token'], requireAuth, async (req: AuthedRequest, res) => {
    try {
      const userId = Number(MobileAuthService.toAuthUser(req.mobileUser).id);
      await MobileDeviceService.unregister(userId, String(req.params.token ?? req.body?.token ?? ''));
      res.json({ ok: true });
    } catch (error) {
      errorResponse(res, error);
    }
  });

  router.get('/projects', requireAuth, async (req: AuthedRequest, res) => {
    try {
      const ownerId = MobileAuthService.toAuthUser(req.mobileUser).id;
      res.json({ data: await MobileProjectService.listForOwner(ownerId) });
    } catch (error) {
      errorResponse(res, error);
    }
  });

  router.get('/projects/:id', requireAuth, async (req: AuthedRequest, res) => {
    try {
      const ownerId = MobileAuthService.toAuthUser(req.mobileUser).id;
      const project = await MobileProjectService.getForOwner(idOf(req), ownerId);
      if (!project) return res.status(404).json({ message: 'Project not found' });
      return res.json({ data: project });
    } catch (error) {
      return errorResponse(res, error);
    }
  });

  /** The signed-in mobile user, recorded as the author of anything they create. */
  const actorOf = (req: AuthedRequest): { id: number | null; name: string } => {
    const user = MobileAuthService.toAuthUser(req.mobileUser) as any;
    const id = Number(user?.id);
    return { id: Number.isFinite(id) ? id : null, name: user?.login ?? 'mobile' };
  };

  const ownerOf = (req: AuthedRequest) => MobileAuthService.toAuthUser(req.mobileUser).id;

  router.get('/projects/:id/tasks', requireAuth, async (req: AuthedRequest, res) => {
    try {
      res.json({ data: await MobileTaskService.listForProject(idOf(req), ownerOf(req)) });
    } catch (error) {
      errorResponse(res, error);
    }
  });

  router.post('/projects/:id/tasks', requireAuth, async (req: AuthedRequest, res) => {
    try {
      const tags = Array.isArray(req.body?.tags) ? req.body.tags.map(String) : [];
      const data = await MobileTaskService.create(
        idOf(req),
        ownerOf(req),
        {
          title: String(req.body?.title ?? ''),
          description: req.body?.description == null ? null : String(req.body.description),
          tags,
        },
        actorOf(req),
      );
      res.status(201).json({ data });
    } catch (error) {
      errorResponse(res, error);
    }
  });

  router.get('/tasks/:id', requireAuth, async (req: AuthedRequest, res) => {
    try {
      res.json({ data: await MobileTaskService.detail(idOf(req), ownerOf(req)) });
    } catch (error) {
      errorResponse(res, error);
    }
  });

  router.post('/tasks/:id/run', requireAuth, async (req: AuthedRequest, res) => {
    try {
      res.status(202).json({ data: await MobileTaskService.run(idOf(req), ownerOf(req)) });
    } catch (error) {
      errorResponse(res, error);
    }
  });

  /**
   * What is running right now across every project the caller owns, plus the last finished runs.
   * The per-task history below answers "how did this task go"; this answers "is anything going on",
   * which the app otherwise could not ask without opening every task in turn.
   */
  router.get('/runs', requireAuth, async (req: AuthedRequest, res) => {
    try {
      res.json({ data: await MobileRunService.board(ownerOf(req)) });
    } catch (error) {
      errorResponse(res, error);
    }
  });

  router.get('/tasks/:id/runs', requireAuth, async (req: AuthedRequest, res) => {
    try {
      res.json({ data: await MobileTaskService.runs(idOf(req), ownerOf(req)) });
    } catch (error) {
      errorResponse(res, error);
    }
  });

  // `logsAfter` / `logsBefore` page the run log without refetching the rest (the patch alone can be
  // megabytes). Absent, the response is the log's tail, which is what a live run needs.
  router.get('/tasks/:taskId/runs/:runId', requireAuth, async (req: AuthedRequest, res) => {
    try {
      const logQuery = {
        after: typeof req.query.logsAfter === 'string' ? req.query.logsAfter : null,
        before: typeof req.query.logsBefore === 'string' ? req.query.logsBefore : null,
        ...(Number(req.query.logLimit) > 0 ? { limit: Number(req.query.logLimit) } : {}),
      };
      res.json({ data: await MobileTaskService.runDetailForTask(String(req.params.taskId), String(req.params.runId), ownerOf(req), logQuery) });
    } catch (error) {
      errorResponse(res, error);
    }
  });

  router.post('/tasks/:taskId/runs/:runId/cancel', requireAuth, async (req: AuthedRequest, res) => {
    try {
      res.json({ data: await MobileTaskService.cancelRun(String(req.params.taskId), String(req.params.runId), ownerOf(req)) });
    } catch (error) {
      errorResponse(res, error);
    }
  });

  /**
   * Everything an agent is currently waiting on, across every project the caller owns. A run in
   * `waiting_input` stays parked until one of these is answered, so the app polls this list the way
   * the dashboard's "Вопросы" page does.
   */
  router.get('/interactions', requireAuth, async (req: AuthedRequest, res) => {
    try {
      res.json({ data: await MobileInteractionService.listPending(ownerOf(req)) });
    } catch (error) {
      errorResponse(res, error);
    }
  });

  /**
   * One question, by the id a push notification carried. Separate from the list because a push may
   * be tapped minutes later: by then the question can already be gone from `/interactions`, and the
   * app still has to show *something* rather than an empty list it cannot explain.
   */
  router.get('/interactions/:id', requireAuth, async (req: AuthedRequest, res) => {
    try {
      res.json({ data: await MobileInteractionService.getForOwner(idOf(req), ownerOf(req)) });
    } catch (error) {
      errorResponse(res, error);
    }
  });

  router.post('/interactions/:id/answer', requireAuth, async (req: AuthedRequest, res) => {
    try {
      const action = String(req.body?.action ?? '') as AgentRunInteractionAction;
      // Only `accept` carries a body; the core service rejects content on decline/cancel, so an
      // empty object must not be smuggled in for them.
      const raw = req.body?.content;
      const content = action === 'accept' && raw && typeof raw === 'object' && !Array.isArray(raw)
        ? raw as Record<string, unknown>
        : null;
      const data = await MobileInteractionService.answer(
        idOf(req),
        ownerOf(req),
        action,
        content,
        actorOf(req),
      );
      res.json({ data });
    } catch (error) {
      errorResponse(res, error);
    }
  });

  router.post('/tasks/:id/comments', requireAuth, async (req: AuthedRequest, res) => {
    try {
      const data = await MobileTaskService.addComment(
        idOf(req),
        ownerOf(req),
        String(req.body?.body ?? ''),
        actorOf(req),
      );
      res.status(201).json({ data });
    } catch (error) {
      errorResponse(res, error);
    }
  });

  return router;
}
