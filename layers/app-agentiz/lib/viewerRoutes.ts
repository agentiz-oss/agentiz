import type { AdminizerRouteMiddleware } from '@nodeknit/app-adminizer';
import { defaultTimezone, isValidTimezone, userTimezoneById } from './userTime';

/**
 * Who is looking at the dashboard, as far as time display cares: one endpoint answering the
 * viewer's IANA timezone. The TSX modules run in the browser and format timestamps client-side;
 * the browser's own zone is wherever the *machine* is, while `UserAP.timezone` is where the
 * *person* says they are — this route is how the modules learn the second. The row is re-read
 * rather than trusted from the session copy: a profile edit must take effect on the next reload,
 * not the next login.
 */
export const viewerRoutes: AdminizerRouteMiddleware[] = [
  {
    route: '/agentiz-viewer',
    method: 'get',
    handler: async (req: any, res: any) => {
      const sessionUser = req.session?.UserAP ?? req.user ?? null;
      const stored = await userTimezoneById(sessionUser?.id);
      const sessionTimezone = isValidTimezone(sessionUser?.timezone) ? sessionUser.timezone : null;
      return res.json({
        data: { timezone: stored ?? sessionTimezone ?? defaultTimezone() },
      });
    },
  },
];
