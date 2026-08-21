import { randomBytes } from 'crypto';
import express, { type Request, type Response, type Router } from 'express';
import jwt from 'jsonwebtoken';
import type { Model, Sequelize } from 'sequelize';
import { bearerToken, verifyMobileToken } from './mobileAuth';
import { MobileAuthError, MobileAuthService } from '../services/MobileAuthService';

/** The model registered by app-agentiz and rendered by the shared Adminizer UI. */
const ASSISTANT_MODEL_ID = 'agentiz-assistant';
const LAUNCH_TTL_MS = 60_000;

type AdminizerRuntime = {
  jwtSecret: string;
  accessRightsHelper: {
    // build.19 widened this to a promise for some backends; both shapes are accepted here.
    hasPermission(token: string, user: any): boolean | Promise<boolean>;
  };
};

type Launch = { userId: string; expiresAt: number };

/**
 * A process-global registry is intentional: tsx can load a layer through both ESM and CJS graphs.
 * Launch codes are one-use bootstrap credentials, not durable sessions, so in-memory storage is
 * sufficient for the current single-process deployment.
 */
const launchStoreSymbol = Symbol.for('agentiz.mobileAssistantLaunches');
function launches(): Map<string, Launch> {
  const globalStore = globalThis as typeof globalThis & { [launchStoreSymbol]?: Map<string, Launch> };
  return (globalStore[launchStoreSymbol] ??= new Map<string, Launch>());
}

function mobileError(res: Response, error: unknown) {
  const status = (error as { status?: unknown } | null)?.status;
  if (error instanceof MobileAuthError || (typeof status === 'number' && status >= 400 && status < 600)) {
    return res.status(status as number).json({ message: (error as Error).message });
  }
  return res.status(500).json({ message: error instanceof Error ? error.message : String(error) });
}

async function hasAssistantAccess(adminizer: AdminizerRuntime, user: Model): Promise<boolean> {
  return await adminizer.accessRightsHelper.hasPermission(`ai-assistant-${ASSISTANT_MODEL_ID}`, user);
}

async function mobileUserFromBearer(req: Request, sequelize: Sequelize): Promise<Model> {
  const token = bearerToken(req.header('authorization'));
  if (!token) throw new MobileAuthError(401, 'Bearer token is required');
  try {
    return await MobileAuthService.requireUser(sequelize, verifyMobileToken(token).sub);
  } catch (error) {
    if (error instanceof MobileAuthError) throw error;
    throw new MobileAuthError(401, 'Invalid or expired token');
  }
}

function issueAdminizerCookie(res: Response, user: any, adminizer: AdminizerRuntime) {
  // This is deliberately the same signed, HttpOnly cookie Adminizer's own login controller issues.
  // The later AI API requests therefore go through Adminizer's normal req.user and permission logic.
  const token = jwt.sign({
    id: user.get('id'),
    login: user.get('login'),
    isAdministrator: Boolean(user.get('isAdministrator')),
  }, adminizer.jwtSecret, { algorithm: 'HS256', expiresIn: '15d' });
  // The assistant is embedded in an iframe/WebView owned by the mobile application, so on the
  // public HTTPS deployment this is a cross-site navigation. Lax cookies are not sent for the
  // redirected iframe request and Adminizer consequently sees no req.user. CHIPS keeps this
  // cookie isolated per embedding top-level site while allowing it through that iframe.
  const embedded = process.env.NODE_ENV === 'production';
  res.cookie('adminizer_jwt', token, {
    httpOnly: true,
    sameSite: embedded ? 'none' : 'lax',
    secure: embedded,
    partitioned: embedded,
    path: '/',
    maxAge: 1000 * 60 * 60 * 24 * 15,
  });
}

/**
 * WebView login bridge for the exact Adminizer agent UI. The standalone Inertia page is contributed
 * by this layer through `adminizerMiddlewares`; after redirect only Adminizer's HttpOnly cookie remains.
 */
export function createMobileAssistantWebviewRouter(sequelize: Sequelize, adminizer: AdminizerRuntime, routePrefix = '/dashboard'): Router {
  const router = express.Router();

  router.post('/webview-session', async (req, res) => {
    try {
      const user = await mobileUserFromBearer(req, sequelize);
      if (!(await hasAssistantAccess(adminizer, user))) throw new MobileAuthError(403, 'You do not have access to the Agentiz Assistant');

      const store = launches();
      const now = Date.now();
      for (const [code, launch] of store) if (launch.expiresAt <= now) store.delete(code);
      const code = randomBytes(32).toString('base64url');
      store.set(code, { userId: String((user as any).get('id')), expiresAt: now + LAUNCH_TTL_MS });
      res.json({ url: `${req.baseUrl}/webview?code=${encodeURIComponent(code)}`, expiresAt: new Date(now + LAUNCH_TTL_MS).toISOString() });
    } catch (error) {
      mobileError(res, error);
    }
  });

  router.get('/webview', async (req, res) => {
    try {
      const code = typeof req.query.code === 'string' ? req.query.code : '';
      const launch = launches().get(code);
      // Delete before any async operation: a double navigation cannot redeem a launch twice.
      if (code) launches().delete(code);
      if (!launch || launch.expiresAt <= Date.now()) throw new MobileAuthError(401, 'WebView launch link is invalid or expired');
      const user = await MobileAuthService.requireUser(sequelize, launch.userId);
      if (!(await hasAssistantAccess(adminizer, user))) throw new MobileAuthError(403, 'You do not have access to the Agentiz Assistant');
      issueAdminizerCookie(res, user, adminizer);
      res.redirect(303, `${routePrefix}/mobile-assistant`);
    } catch (error) {
      mobileError(res, error);
    }
  });

  return router;
}
