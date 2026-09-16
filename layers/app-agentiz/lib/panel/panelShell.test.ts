import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@nodeknit/app-adminizer', () => ({
  AdminizerField: (): PropertyDecorator => (_target: object, _key: string | symbol): void => {},
  AdminizerModel: (): ClassDecorator => (_target: Function): void => {},
}));
vi.mock('./menu', () => ({
  buildAgentizMenu: vi.fn(async () => [{ id: 'agentiz-overview', title: 'Обзор' }]),
  buildAgentizBrand: vi.fn(async () => ({ brand: 'Agentiz', section: [{ id: 'agentiz-switch-all' }] })),
  buildAgentizSections: vi.fn(() => ({ 'Моя работа': { icon: 'inbox', order: 10 } })),
}));
import { buildAgentizBrand, buildAgentizMenu } from './menu';
import { isPageRequest, panelShell, redirectToLogin } from './panelShell';

/**
 * The shell is one middleware on every request under the panel prefix, so what has to stay true
 * is mostly about what it leaves alone: a request that is not a page, a request without a session,
 * an address our own render already serves. The two things it does are pinned as exactly two
 * observable effects — a `302` to the overview from the root, and shared props elsewhere.
 */
describe('panelShell', () => {
  const session = { user: { id: 7, login: 'u7' }, session: { UserAP: { id: 7, login: 'u7' } } };

  function request(path: string, extra: Record<string, unknown> = {}) {
    const shareProps = vi.fn();
    const req: any = {
      method: 'GET',
      path,
      originalUrl: path,
      query: {},
      headers: { accept: 'text/html,application/xhtml+xml' },
      adminizer: { config: { routePrefix: '/dashboard', auth: { enable: true } } },
      Inertia: { shareProps },
      ...extra,
    };
    const res: any = { redirect: vi.fn(), headersSent: false };
    const next = vi.fn();
    return { req, res, next, shareProps };
  }

  beforeEach(() => {
    vi.mocked(buildAgentizMenu).mockClear();
    vi.mocked(buildAgentizBrand).mockClear();
  });

  it('sends the panel root to the overview when there is a session', async () => {
    const { req, res, next } = request('/dashboard', session);
    await panelShell(req, res, next);
    expect(res.redirect).toHaveBeenCalledWith(302, '/dashboard/agentiz');
    expect(next).not.toHaveBeenCalled();
  });

  it('treats the root with a trailing slash the same way', async () => {
    const { req, res, next } = request('/dashboard/', session);
    await panelShell(req, res, next);
    expect(res.redirect).toHaveBeenCalledWith(302, '/dashboard/agentiz');
    expect(next).not.toHaveBeenCalled();
  });

  it('leaves the root to adminizer without a session, so the login form is what answers', async () => {
    const { req, res, next, shareProps } = request('/dashboard');
    await panelShell(req, res, next);
    expect(res.redirect).not.toHaveBeenCalled();
    expect(shareProps).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("shares our sidebar and switcher on the panel's own pages", async () => {
    const { req, res, next, shareProps } = request('/dashboard/model/User', session);
    await panelShell(req, res, next);
    expect(res.redirect).not.toHaveBeenCalled();
    expect(shareProps).toHaveBeenCalledTimes(1);
    expect(shareProps.mock.calls[0][0]).toEqual({
      menu: [{ id: 'agentiz-overview', title: 'Обзор' }],
      menuSections: { 'Моя работа': { icon: 'inbox', order: 10 } },
      brand: 'Agentiz',
      section: [{ id: 'agentiz-switch-all' }],
    });
    expect(buildAgentizMenu).toHaveBeenCalledWith(req, null);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('shares nothing under /agentiz — the render builds the context-dependent menu itself', async () => {
    for (const path of ['/dashboard/agentiz', '/dashboard/agentiz/p/demo/tasks']) {
      const { req, res, next, shareProps } = request(path, session);
      await panelShell(req, res, next);
      expect(shareProps).not.toHaveBeenCalled();
      expect(buildAgentizMenu).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalledTimes(1);
    }
  });

  it('does not share on an address that merely starts with the letters', async () => {
    const { req, res, next, shareProps } = request('/dashboard/agentiz-other', session);
    await panelShell(req, res, next);
    expect(shareProps).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('costs nothing on a request that is not a page', async () => {
    const cases = [
      request('/dashboard/agentiz', { ...session, query: { _method: 'getInbox' } }),
      request('/dashboard/model/User', { ...session, method: 'POST' }),
      request('/dashboard/model/User', { ...session, headers: { accept: 'application/json' } }),
      request('/dashboard', { ...session, headers: { accept: '*/*' } }),
    ];
    for (const { req, res, next, shareProps } of cases) {
      await panelShell(req, res, next);
      expect(res.redirect).not.toHaveBeenCalled();
      expect(shareProps).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalledTimes(1);
    }
    expect(buildAgentizMenu).not.toHaveBeenCalled();
  });

  it('counts an Inertia visit as a page whatever its Accept says', () => {
    const { req } = request('/dashboard/model/User', { headers: { 'x-inertia': 'true', accept: '*/*' } });
    expect(isPageRequest(req)).toBe(true);
  });

  it("falls back to the panel's own sidebar when the menu cannot be built", async () => {
    vi.mocked(buildAgentizMenu).mockRejectedValueOnce(new Error('db down'));
    const { req, res, next, shareProps } = request('/dashboard/model/User', session);
    await panelShell(req, res, next);
    expect(shareProps).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('with the panel auth switched off, everybody has a session', async () => {
    const { req, res, next } = request('/dashboard', {
      adminizer: { config: { routePrefix: '/dashboard', auth: { enable: false } } },
    });
    await panelShell(req, res, next);
    expect(res.redirect).toHaveBeenCalledWith(302, '/dashboard/agentiz');
  });
});

describe('redirectToLogin', () => {
  it("sends to adminizer's login form with the page to come back to", () => {
    const res: any = { redirect: vi.fn() };
    redirectToLogin({
      originalUrl: '/dashboard/agentiz/p/demo/tasks?tab=open',
      adminizer: { config: { routePrefix: '/dashboard' } },
    }, res);
    expect(res.redirect).toHaveBeenCalledWith(
      302,
      '/dashboard/model/User/login?redirectTo=%2Fdashboard%2Fagentiz%2Fp%2Fdemo%2Ftasks%3Ftab%3Dopen',
    );
  });
});
