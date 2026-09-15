import type { GitProviderPanel } from '../../app-agentiz/lib/git';
import { DEFAULT_GITHUB_BASE_URL, DEFAULT_GITHUB_SCOPES } from '../types/github';

/**
 * How this layer's half of the shared «Git-провайдеры» screen reads.
 *
 * Contributed as data through app-agentiz's `gitProviderPanels` collection — the core draws the
 * card, the form and the connection list, and knows nothing about GitHub beyond what is written
 * here. Everything platform-shaped that is genuinely different from GitLab is in this object and
 * nowhere else in the panel: the name, where an OAuth App is created, that its identity field is
 * called `clientId`, and the scopes we ask for.
 *
 * No secret is ever part of a descriptor: `clientSecret` is declared as an input, and the value
 * travels one way — into `createOAuthApp` below, and back out only as a mask (`maskModelForUI`).
 *
 * `apiRoute` is also what keeps the OAuth callback where it is. The callback registered in
 * somebody's GitHub application settings is `<prefix>/agentiz-github/oauth/callback`, so this
 * route may not move even though the screen did.
 */
export const githubProviderPanel: GitProviderPanel = {
  provider: 'github',
  title: 'GitHub',
  summary: 'OAuth-приложение GitHub или GitHub Enterprise. Через него авторизуются учётные записи, а уже они зеркалируют репозитории.',
  apiRoute: '/agentiz-github',
  appIdentityField: 'clientId',
  appHint: 'Settings → Developer settings → OAuth Apps в GitHub. Оттуда сюда переносятся Client ID и secret, а Authorization callback URL берётся с карточки приложения ниже.',
  defaultScopes: DEFAULT_GITHUB_SCOPES,
  appFields: [
    { name: 'name', label: 'Название', placeholder: 'GitHub' },
    { name: 'baseUrl', label: 'Адрес GitHub', placeholder: DEFAULT_GITHUB_BASE_URL, hint: 'Для GitHub Enterprise — адрес вашей установки.' },
    { name: 'clientId', label: 'Client ID', required: true },
    { name: 'clientSecret', label: 'Client secret', secret: true, required: true },
    { name: 'redirectUri', label: 'Redirect URI', hint: 'Необязательно: по умолчанию собирается из публичного адреса сервера.' },
  ],
};
