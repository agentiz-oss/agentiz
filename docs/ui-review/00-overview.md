# Обзор: стек, загрузка, меню, общая раскладка

> **Состояние «до»: 8 сентября 2026.** Описанные здесь экраны и адреса заменены переносом
> панели на дерево `/agentiz` — читайте это как исходные данные того решения, а не как описание
> нынешней панели. Как она устроена сейчас — [`../guides/panel-ui.md`](../guides/panel-ui.md).

## Стек панели

Adminizer (`@nodeknit/app-adminizer`, версия видна в `window.adminizerVersion` —
`5.1.0-build.25` на момент ревизии) — это одна React-SPA на Inertia.js: сервер отдаёт
`{"component": "...", "props": {...}}`, клиент рендерит соответствующий React-компонент.
Разметка — shadcn/ui поверх Tailwind (`data-slot="button"`, `class="bg-primary text-primary-foreground
h-9 px-4 py-2 ..."` и т.п. — видно уже на форме логина), тема light/dark переключается кнопкой в
шапке, есть toast (`sonner`), общий ассистент (иконка звёздочки в шапке — `AppAiAssistantContext`,
это отдельная тема, не часть этой ревизии), колокольчик уведомлений (`dashboardNotifications.ts`,
см. `AGENTS.md`).

Экраны, которые добавляет **Agentiz** (а не типовой CRUD Adminizer), — это не часть Adminizer,
а **модули**: отдельные React-компоненты, зарегистрированные Inertia-страницей `component:
"module"` с одним пропом `moduleComponent: "/dashboard/modules/<Имя>.js"`. Каждый такой `.tsx`
собирается `vite.config.ts` в отдельный ES-модуль (`dist/modules/<Имя>.js`, `lib.entry` — список
входов), и **все** они:

- пишут свою разметку заново, каждый своими руками — **ни один не импортирует shadcn/ui**
  (`@/components/ui/button` и т.д. проверено `grep` по всем `layers/*/adminizer/modules/*.tsx` —
  ноль совпадений), хотя `vite.config.ts` явно **готов** их отдать: `viteExternalsPlugin`
  прописывает `@/components/ui/button|card|dialog|input|label|select|tabs|textarea` на глобальный
  `UIComponents`, то есть подключить их — это буквально один `import`, а не отдельная сборка.
  Сейчас же — сырые `<button className="rounded border px-3 py-1.5 text-sm font-medium">`,
  свои цвета статусов (`Badge` со своей палитрой в каждом файле), свой `<select>`. Разница видна
  сразу на скриншотах: страница логина/список моделей выглядят как один продукт (скруглённые
  инпуты, тени, `focus-visible` кольца), экраны Agentiz — как другой (плоские рамки, системный
  `<select>`). Подробнее — [`09-findings-for-redesign.md`](09-findings-for-redesign.md).
- сами тянут данные: `axios` прямо в компоненте (`axios.get('/dashboard/agentiz-tasks', {params:
  {...}})` и т.п.), без общего API-клиента, без React Query/SWR — свой `useState`/`useEffect`
  и своя функция `reload()` в каждом файле.
- используют `react/jsx-runtime`, подменённый на `jsxRuntimeShim.ts`, чтобы не тащить второй React
  в бандл (все модули работают в React самой панели, а не в своей копии) — актуально, если
  переезжать на другую сборку/раскладку компонентов: react должен остаться внешним (`external:
  ['react', 'react-dom', ...]` в `vite.config.ts`).

Список входов `vite.config.ts` — это и есть полный список кастомных модулей Agentiz:

| Модуль | Файл | Экран |
| --- | --- | --- |
| `AgentizHome` | `layers/app-agentiz/adminizer/modules/AgentizHome.tsx` | `/dashboard/agentiz` |
| `AgentizTasks` | `.../AgentizTasks.tsx` | `/dashboard/agentiz-tasks` |
| `AgentizPipelines` | `.../AgentizPipelines.tsx` | `/dashboard/agentiz-pipelines` |
| `AgentizWorkers` | `.../AgentizWorkers.tsx` | `/dashboard/agentiz-workers` |
| `AgentizRuns` | `.../AgentizRuns.tsx` | `/dashboard/agentiz-runs` |
| `AgentizRunDetail` | `.../AgentizRunDetail.tsx` | `/dashboard/agentiz-runs?runId=...` |
| `AgentizInteractions` | `.../AgentizInteractions.tsx` | `/dashboard/agentiz-interactions` |
| `AgentizRepositories` | `.../AgentizRepositories.tsx` | `/dashboard/agentiz-repos` |
| `AgentizMembers` | `.../AgentizMembers.tsx` | `/dashboard/agentiz-members` |
| `AgentizNotifications` | `.../AgentizNotifications.tsx` | `/dashboard/agentiz-notifications` |
| `AgentizGithub` | `layers/app-agentiz-github-integration/adminizer/modules/AgentizGithub.tsx` | `/dashboard/agentiz-github` |
| `AgentizGitlab` | `layers/app-agentiz-gitlab-integration/adminizer/modules/AgentizGitlab.tsx` | `/dashboard/agentiz-gitlab` |
| `MobileAssistant` | `layers/app-agentiz-mobile-api/adminizer/modules/MobileAssistant.tsx` | вебвью (см. `mobileAssistantWebviewRouter.ts`), не часть обычной навигации панели |
| `WorkflowList` / `WorkflowEditor` | `node_modules/@nodeknit/app-workflow/adminizer/modules/*` (submodule, не в этом репо) | `/dashboard/workflows`, `/dashboard/workflow` |

`layers/app-agentiz/lib/viewerRoutes.ts` (`/dashboard/agentiz-viewer`) — не экран: это чистый
JSON-эндпоинт (`{"data":{"timezone":"..."}}`), который клиентский код зовёт, чтобы узнать часовой
пояс зрителя (`lib/viewerTime.ts`); открытый напрямую в браузере он просто печатает JSON.

## Как экран попадает под `/dashboard/*`

Все Express-роуты Agentiz регистрируются через `adminizerMiddlewares` — они смонтированы **до**
политик доступа самой Adminizer, поэтому каждый обработчик сам вызывает `requirePanelUser`
(`layers/app-agentiz/lib/access/panelGuard.ts:33`) и при необходимости `guardProject`. Без валидной
сессии панели (`req.session.UserAP` или JWT `req.user`, кука `adminizer_jwt`) любой такой роут,
даже GET-страница, отвечает `401 {"message": "Sign in to the admin panel first"}` **как JSON**, а
не HTML-страницей логина — этим и отличается снимок `/dashboard/agentiz`, снятый без сессии, от
снятого залогиненным (см. историю ревизии/скриншот `00-login.png` в разведочных скриптах — тут не
сохранён, воспроизводится тривиально).

## Дерево меню (боковая панель)

Меню приходит в пропе `menu` каждой Inertia-страницы (плоский список с `section`), не текстом —
что критично: **не все кастомные экраны Agentiz в нём есть**. `/dashboard/agentiz-pipelines`,
`/dashboard/agentiz-workers`, `/dashboard/agentiz-notifications`, `/dashboard/agentiz-repos`,
`/dashboard/agentiz-github`, `/dashboard/agentiz-viewer` в меню **отсутствуют** — на них можно
попасть только переходом с других страниц (в основном с `/dashboard/agentiz`, хаба проекта, у
которого на каждый раздел есть карточка-ссылка, и друг с друга — см. следующие файлы). Это уже
само по себе наблюдение для переразбивки: часть разделов siloed за клик из хаба, и если открыть
их URL напрямую (что делает, например, закладка или мобильный вебвью), обратной ссылки в
сайдбаре нет.

Секция **Agentiz** в развёрнутом виде (порядок — как в `menu`, `accessRightsToken` где есть):

1. `Agentiz` → `/dashboard/agentiz` (иконка `smart_toy`)
2. `Задачи` → `/dashboard/agentiz-tasks` (`checklist`)
3. `Запуски` → `/dashboard/agentiz-runs` (`directions_run`)
4. `Нужен ответ` → `/dashboard/agentiz-interactions` (`live_help`)
5. `Участники` → `/dashboard/agentiz-members` (`group`, токен `agentiz-access`)
6. `Воркфлоу` → `/dashboard/workflows` (`account_tree`)
7. `GitLab-интеграции` → `/dashboard/agentiz-gitlab` (`hub`)
8. — дальше **типовые CRUD-модели** панели, каждая — отдельный пункт со своей иконкой и токеном
   `read-<Model>-model` (полный список и что на них смотреть — [`08-generic-crud-models.md`](08-generic-crud-models.md)):
   `Agentiz Projects`, `Agent Roles`, `Pipeline Specs`, `Agentiz Tasks`, `Agent Runs`,
   `Agent Run Logs`, `Agent Run Jobs`, `Agentiz Workers`, `Task Sources`, `Git Connections`,
   `Repositories`, `Project Repositories`, `Run Diffs`, `Agentiz Harness Subscriptions`,
   `Workspace Proposals`, `GitHub OAuth Apps`, `GitLab OAuth Apps`.

Заметно, что «GitHub-интеграции» (кастомный модуль `AgentizGithub`) **не** в меню, хотя
«GitLab-интеграции» — в меню; так же с `Пайплайны`/`Воркеры`/`Уведомления`/`Репозитории` — их там
просто нет, при том что почти одноимённые CRUD-модели (`Agentiz Workers`, `Repositories`) есть.
Меню — не карта продукта, а исторический список того, что когда добавили.

Секции **Platform** (`Documentation`, `/dashboard/docs`) и **System** (`Users`, `Groups`) — это
общие для всего Adminizer пункты, не относятся к Agentiz.

## Общая раскладка страницы

Слева — коллапсируемый сайдбар (иконка книги в углу шапки сворачивает его в узкую полосу с одними
иконками), сгруппированный по секциям с шевроном (`Agentiz` открывается/закрывается кликом на
заголовок секции, разворачивая список её пунктов). Справа — шапка (иконка ассистента, переключатель
темы, колокольчик, аватар+имя+меню пользователя) и контентная область. У каждого модуля Agentiz —
свой `<h1 className="text-3xl font-bold tracking-tight">` с заголовком раздела и одна строка
описания под ним серым (`text-sm text-muted-foreground`) — это единственный последовательный
паттерн между всеми модулями; всё остальное внутри контентной области у каждого файла своё.

Контент верхнего уровня почти везде — вертикальный стек карточек `rounded-lg border p-4`
(иногда `rounded border p-3`/`p-2` — три чуть разных варианта одного и того же приёма в разных
файлах), без общей сетки/интервалов между модулями.
