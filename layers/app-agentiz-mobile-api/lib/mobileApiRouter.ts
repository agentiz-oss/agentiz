import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import cors from 'cors';
import type { Model, Sequelize } from 'sequelize';
import { bearerToken, verifyMobileToken } from './mobileAuth';
import { MobileAuthError, MobileAuthService } from '../services/MobileAuthService';
import { MobileProjectService } from '../services/MobileProjectService';

/** Public base path of the mobile API. Versioned so the app can pin a contract. */
export const MOBILE_API_BASE = '/api/agentiz/mobile/v1';

/** The authenticated UserAP instance is attached here by requireAuth for downstream handlers. */
interface AuthedRequest extends Request {
  mobileUser?: Model;
}

function errorResponse(res: Response, error: unknown) {
  if (error instanceof MobileAuthError) {
    return res.status(error.status).json({ message: error.message });
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
      const project = await MobileProjectService.getForOwner(req.params.id, ownerId);
      if (!project) return res.status(404).json({ message: 'Project not found' });
      res.json({ data: project });
    } catch (error) {
      errorResponse(res, error);
    }
  });

  return router;
}
