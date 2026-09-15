# Ревизия интерфейса Agentiz в Adminizer

> **Это ревизия состояния «до», снятая 8 сентября 2026, и она такой и остаётся.**
> Описанные здесь экраны, адреса (`/dashboard/agentiz-runs`, `/dashboard/agentiz-tasks`, …) и
> модули заменены переносом панели на адресное дерево `/agentiz`; старые адреса живы как `302`.
> Ценность этого текста — в том, **от чего** отталкивалось решение: он называет каждую находку
> с файлом и строкой, и по нему видно, что именно чинилось. Переснимать его не стали намеренно:
> опись нынешнего интерфейса устареет ровно так же с первой следующей фичей, а объяснение,
> которое не устаревает, живёт в [`../guides/panel-ui.md`](../guides/panel-ui.md) — туда и надо
> идти за тем, как панель устроена сегодня.

Полная структурная ревизия всех экранов, которые app-agentiz (и провайдерские слои
`app-agentiz-github-integration` / `app-agentiz-gitlab-integration` / `app-agentiz-mobile-api`)
добавляют в панель Adminizer — сделана как подготовка к переразбивке интерфейсов. Цель: собрать
в одном месте, **что где находится**, какие переходы куда ведут, из какого файла и каких классов
собран каждый экран, и что в текущей раскладке мешает работать — чтобы дальше перекладывать
интерфейс осознанно, а не заново открывая каждый файл.

## Как это сделано

Живой `npm run dev` (порт 17280, sqlite `.tmp/app-db.sqlite`, те же сиды, что при обычной
локальной разработке), Playwright поверх системного `/usr/bin/chromium` (MCP-плейрайт был занят
другими параллельными сессиями на этой машине — использован `node_modules/playwright` напрямую,
скрипты не сохранены в репозитории, это разовый разведочный код). Каждый экран открыт живым
логином (`admin`, локальный пароль пересоздан на этот сеанс — см. ниже), со скриншотом
(`screenshots/*.png`, полная страница) и с дампом Inertia-пропсов страницы (`<script
data-page="app">` — component/props/menu), а не только чтением исходников: там, где скриншот
и код расходились (см. `08-generic-crud-models.md` про `Repo Config`/`Secrets`), в тексте отмечено
явно. Дальше по каждому экрану прочитан исходный `.tsx` — какой хук/эндпоинт дёргает, какие
классы задают раскладку, какие кнопки что делают.

**Как повторить**, если понадобится: локальный admin-пароль хранится хешем
(`password-hash`, формат `sha1$salt$iterations$hash`) от `login + password + AP_PASSWORD_SALT`;
соль в этом окружении — `FIXTURE` (см. `AGENTS.md`/память про "соль FIXTURE для локального
входа"). Обычный `ADMIN_CREDS` из `.env` — это прод-креды панели, к локальному sqlite отношения
не имеют. Проще всего сгенерировать новый хеш через `password-hash` и записать его в таблицу
`userap` (sqlite, `.tmp/app-db.sqlite`) — так и было сделано для этой ревизии.

## Файлы

- [`00-overview.md`](00-overview.md) — стек, как страница попадает в панель (Inertia + один JS per
  module), полное дерево меню (JSON, а не то, что видно на глаз — часть пунктов открывается только
  переходом изнутри других страниц, в меню их нет), общая раскладка/сайдбар, как всё это авторизуется.
- [`01-project-hub-and-tasks.md`](01-project-hub-and-tasks.md) — `/dashboard/agentiz` (хаб проекта)
  и `/dashboard/agentiz-tasks` (трекер задач с деталями, комментариями, ручным запуском).
- [`02-runs-and-interactions.md`](02-runs-and-interactions.md) — `/dashboard/agentiz-runs` (лента
  запусков), деталь запуска (стадии/логи/дифф/ревью воркспейса) и `/dashboard/agentiz-interactions`
  («Нужен ответ»).
- [`03-pipelines.md`](03-pipelines.md) — `/dashboard/agentiz-pipelines` (редактор пайплайна проекта:
  роли, ACP-агенты, стадии, хуки).
- [`04-workers.md`](04-workers.md) — `/dashboard/agentiz-workers` (воркеры, лимиты harness,
  подписки).
- [`05-members-and-notifications.md`](05-members-and-notifications.md) — `/dashboard/agentiz-members`
  и `/dashboard/agentiz-notifications` + переиспользуемая секция настройки уведомлений.
- [`06-repositories-and-git-integrations.md`](06-repositories-and-git-integrations.md) —
  `/dashboard/agentiz-repos`, `/dashboard/agentiz-github`, `/dashboard/agentiz-gitlab`.
- [`07-workflows-canvas.md`](07-workflows-canvas.md) — `/dashboard/workflows` и
  `/dashboard/workflow` (React Flow канвас движка `@nodeknit/app-workflow`).
- [`08-generic-crud-models.md`](08-generic-crud-models.md) — необёрнутые модели Adminizer
  (`AgentProject`, `AgentRole`, `PipelineSpec`, `AgentRun`, …), которые видны в меню, но не имеют
  своего экрана — их редактируют через типовой CRUD-конструктор панели.
- [`09-findings-for-redesign.md`](09-findings-for-redesign.md) — что именно мешает при
  переразбивке: несогласованность дизайн-системы, дублирование, узкие места навигации — с
  конкретными файлами и строками.

Скриншоты лежат в [`screenshots/`](screenshots/), по одному на экран, имя файла = слаг раздела.
