# Проект с нуля через MCP: папка, репозиторий, первая задача

Весь путь от «ничего нет» до «агент коммитит в свой репозиторий» проходится через MCP
(`/mcp/call/<tool>`), без панели. Ни одного специального «bootstrap»-механизма для этого нет, и это
сделано намеренно: проект собирается из тех же сущностей, что и любой другой, а единственный шаг,
которого сервер сделать не может, — **создать репозиторий на платформе** — выполняет агент на
воркере через `gh`, как обычную работу.

## Почему репозиторий создаёт агент, а не сервер

У сервера есть OAuth-токен подключения GitHub, и формально он мог бы вызвать `POST /user/repos`.
Но тогда репозиторий появится на GitHub, а в папке на воркере не будет ни git, ни remote, ни
первого коммита — это всё равно пришлось бы делать на машине воркера. Агент в пайплайне
`worker_workspace` уже сидит в нужной папке и умеет выполнять команды, поэтому «git init + первый
коммит + `gh repo create --source . --push`» — это просто задача для него. Сервер после этого
делает то, что умеет только он: **видит** репозиторий (синк подключения) и **привязывает** его к
проекту.

Следствие, о котором надо помнить: `gh` на воркере работает под учёткой, залогиненной на этой
машине, а Agentiz видит репозитории под учёткой своего подключения (`AgentGitConnection`). Если это
разные аккаунты и подключение не видит организацию, куда агент опубликовал репозиторий, привязка
ответит `not_found: no connection sees repository … even after a sync`.

## Порядок

1. **Проект, роли, пайплайны** — `agentiz.manage` (`entity: project | role | pipelineSpec`).
   Форму `spec` читать через `agentiz.pipelineSpecSchema`. Нужны два пайплайна на одну и ту же
   абсолютную папку одного воркера (`source.kind: "worker_workspace"`, `source.workspace.workerId`,
   `source.workspace.path`; все стадии `runtime.mode: "host"`):
   - *bootstrap*: `createIfMissing: true`, `finalAction: { type: "none" }`. Без `commit` сервер не
     заводит proposal, а значит воркер **не** делает git-preflight (`workspace_git.preflight`
     вызывается только при proposal) — папка может быть пустой и вообще не репозиторием;
   - *рабочий*: `finalAction: { type: "commit", ... }`. Он уже требует настоящий checkout.
2. **Воркер** — `agentiz.manageWorker`: `setAllowedProjects`, `setWorkspaces` (папка с
   `projectId` — тогда её смогут назвать только пайплайны этого проекта, см.
   `lib/workspaceOwnership.ts`) и `setGitPushRoots` или `git.pushEnabled` на декларации — право
   пушить никогда не живёт в спеке.
3. **Задача на bootstrap** — `agentiz.manage` (`entity: task`, `pipelineSpecId` бутстрап-пайплайна),
   затем `agentiz.runTask`. В тексте задачи попросить: `git init -b main`, закоммитить всё,
   `gh repo create <owner>/<name> --private --source . --push`, `gh auth setup-git`. Последнее не
   формальность: рабочий пайплайн начинает с `git ls-remote` от имени процесса воркера, и без
   credential helper'а он упадёт на старте, хотя `gh` минуту назад всё запушил.
   Ход смотреть через `agentiz.runDetails`.
4. **Привязка** — `agentiz.manageRepositories`
   `{ "operation": "link", "projectId": …, "pathWithNamespace": "<owner>/<name>", "isPrimary": true }`.
   Если зеркало ещё не знает этот путь, инструмент один раз синхронизирует подключения
   (`syncIfMissing`, по умолчанию включено) и только потом сдаётся. Вебхук ставится сам — его ведут
   хуки модели `AgentProjectRepository`, а не инструмент (см.
   [`repository-events.md`](./repository-events.md)).
5. **Обычные задачи** на рабочем пайплайне. Если в нём закреплён `source.repositoryId`, воркер ещё
   и сверит, что `origin` папки указывает на тот же репозиторий (`_verify_remote`).

## Где что лежит

- MCP-инструменты репозиториев: `layers/app-agentiz/mcp/agentizRepositoryTools.ts`
  (`agentiz.repositories` — чтение, `agentiz.manageRepositories` — `sync` / `link` / `updateLink` /
  `unlink`).
- Сама логика привязки, общая с экраном репозиториев панели (`lib/repositoryRoutes.ts`):
  `layers/app-agentiz/lib/git/projectRepositoryLinks.ts`. Новый способ привязать репозиторий должен
  идти через неё, иначе MCP и панель начнут создавать разные строки.
- Создание папки воркером: `resolve_workdir` в `worker/src/agentiz_worker/main.py`.

## Как понять, что сломалось

| Симптом | Где |
| --- | --- |
| bootstrap-запуск упал с `job workspace directory does not exist` | в спеке нет `createIfMissing: true` |
| `link` → `not_found … even after a sync` | `gh` опубликовал под аккаунтом/организацией, которых не видит подключение; `agentiz.repositories` покажет, какие подключения есть |
| `link` → `ambiguous` | репозиторий виден через два подключения — передать `connectionId` |
| рабочий запуск упал на preflight | папка грязная, HEAD не на ветке или нет git-доступа у пользователя воркера — лестница проверок в `AGENTS.md`, раздел «The worker-side preflight ladder» |
