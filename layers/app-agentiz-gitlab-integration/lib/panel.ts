import type { GitProviderPanel } from '../../app-agentiz/lib/git';
import { DEFAULT_GITLAB_BASE_URL, DEFAULT_GITLAB_SCOPES } from '../types/gitlab';

/**
 * How this layer's half of the shared «Git-провайдеры» screen reads. The GitLab twin of
 * `app-agentiz-github-integration/lib/panel.ts`, and the differences between the two files are
 * exactly the differences between the platforms: an application is created in a different place,
 * its identity field is `applicationId` rather than `clientId`, and the scopes are GitLab's own.
 *
 * Contributed through app-agentiz's `gitProviderPanels` collection, so neither the core nor the
 * GitHub layer imports this one. No secret is part of a descriptor — `clientSecret` is an input
 * whose value only ever travels into `createOAuthApp` and comes back masked.
 *
 * `apiRoute` stays put whatever happens to the screen: `<prefix>/agentiz-gitlab/oauth/callback` is
 * registered inside somebody's GitLab application and a redirect there would break it.
 */
export const gitlabProviderPanel: GitProviderPanel = {
  provider: 'gitlab',
  title: 'GitLab',
  summary: 'OAuth-приложение gitlab.com или своей установки GitLab. Через него авторизуются учётные записи, а уже они зеркалируют репозитории.',
  apiRoute: '/agentiz-gitlab',
  appIdentityField: 'applicationId',
  appHint: 'User / Group / Admin → Applications в GitLab. Оттуда сюда переносятся Application ID и secret, а Redirect URI берётся с карточки приложения ниже.',
  defaultScopes: DEFAULT_GITLAB_SCOPES,
  appFields: [
    { name: 'name', label: 'Название', placeholder: 'GitLab' },
    { name: 'baseUrl', label: 'Адрес GitLab', placeholder: DEFAULT_GITLAB_BASE_URL, hint: 'Для своей установки — её адрес.' },
    { name: 'applicationId', label: 'Application ID', required: true },
    { name: 'clientSecret', label: 'Secret', secret: true, required: true },
    { name: 'redirectUri', label: 'Redirect URI', hint: 'Необязательно: по умолчанию собирается из публичного адреса сервера.' },
  ],
};
