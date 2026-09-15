# Модели без своего экрана — типовой CRUD Adminizer

> **Состояние «до»: 8 сентября 2026.** Описанные здесь экраны и адреса заменены переносом
> панели на дерево `/agentiz` — читайте это как исходные данные того решения, а не как описание
> нынешней панели. Как она устроена сейчас — [`../guides/panel-ui.md`](../guides/panel-ui.md).

Часть данных Agentiz видна в панели **только** через типовой конструктор Adminizer (модель
зарегистрирована в `adminizerModelConfigs`, но никакой `AgentizX.tsx` её не подхватывает) — список,
`create`/`edit`-форма, поиск, сортировка, пагинация, всё сгенерировано из декларации модели
(`layers/app-agentiz/index.ts`, дамп конфигурации виден в логе загрузки сервера, DEBUG-строки
`Adminpanel create CRUD routes for ...`).

## Список (17 моделей в меню)

`AgentProject`, `AgentRole`, `PipelineSpec`, `AgentTask`, `AgentRun`, `AgentRunLog`,
`AgentRunJob`, `AgentWorker`, `AgentTaskSource`, `AgentGitConnection`, `AgentRepository`,
`AgentProjectRepository`, `AgentRunDiff`, `AgentHarnessSubscription`, `AgentWorkspaceProposal`,
`GithubOAuthApp`, `GitlabOAuthApp` — каждая со своей иконкой (material-symbols имя, например
`smart_toy` у `AgentProject`, `precision_manufacturing` у `AgentWorker`) и токеном
`read-<Model>-model`.

Из них **пять** дублируют кастомные экраны, показывая сырые данные той же сущности, что и
специализированная страница: `AgentProject` (дублирует часть хаба), `AgentRun`/`AgentRunLog`/
`AgentRunJob` (дублируют деталь запуска), `AgentWorker` (дублирует «Воркеры»),
`AgentRepository`/`AgentProjectRepository`/`AgentGitConnection` (дублируют «Репозитории»),
`AgentWorkspaceProposal` (дублирует блок «Проверка workspace-изменений»). Остальные —
**единственный** способ добраться до данных из UI: `AgentRole`, `PipelineSpec` (!),
`AgentTaskSource`, `AgentRunDiff`, `AgentHarnessSubscription`, `GithubOAuthApp`/`GitlabOAuthApp`.

## Список (`/dashboard/model/AgentProject` как пример)

![Типовой список](screenshots/generic-crud-list.png)

Стандартная таблица Adminizer: кнопки `create`/`Search` сверху, колонки с сортировкой (`↕` на
каждом заголовке), пагинация снизу (`Show N-M of K`, размер страницы `50` по умолчанию, First/
Previous/[номер]/Next/Last). Колонки берутся из `list.fields` конфигурации модели — большинство
Agentiz-моделей прячут технические/JSON-поля из списка (`visible: false` в дампе конфига,
например `AgentProject.repoConfig`/`trackerConfig`/`secrets` не в списке, но `name`/`slug`/
`repoProvider`/`isActive`/`id`/`lastSyncedAt` — да).

## Форма создания/редактирования (`/dashboard/model/AgentProject/add` как пример)

![Типовая форма](screenshots/generic-crud-add.png)

Здесь конструктор показывает **все** поля модели буквально — включая те, что в списке скрыты:
`Repo Config`, `Tracker Config`, `Secrets` рендерятся как полноценный JSON-редактор
(`text`/`tree`/`table`-режимы переключения, drag&drop, история undo/redo — судя по панели
инструментов) вместо человеческого набора полей формы. Для `AgentProject` это значит: чтобы
прописать `{owner, repo}` в `repoConfig` или токен в `secrets` из этой формы, нужно знать точную
форму JSON, которую ожидает `GitProvider`/`lib/secrets.ts` — ни подсказки с примером, ни валидации
под конкретную схему здесь нет (в отличие от кастомных экранов, где то же самое подписано текстом
на русском и предзаполнено выпадающими списками). Реляционные поля (`roles`, `pipelineSpecs`,
`tasks`, `owner`) — виджет `+ Add` с раскрывающимся списком существующих записей по id, без
предпросмотра названия, пока не добавишь.

**Практическое следствие для переразбивки**: `PipelineSpec` — вторая по важности сущность во всём
продукте (спека пайплайна, `AGENTS.md` описывает её на нескольких экранах документации), а её
**единственная** форма редактирования — вот эта голая JSON-таблица, потому что `AgentizPipelines.tsx`
редактирует только *один* `PipelineSpec` проекта через кастомный RPC-эндпоинт, а не через
Adminizer CRUD, и никакой кастомной формы для произвольной записи `PipelineSpec` в панели нет.
Если у проекта заведено больше одного пайплайна (модель это допускает, `AgentPipelineService`
резолвит по `pipelineSpecId` конкретного запуска), редактировать «неглавный» пайплайн можно только
через эту сырую форму или через MCP `agentiz.manage` (см. `AGENTS.md`, "PipelineSpec.spec
валидируется схемой").

Такая же ситуация: `AgentRole` (роли — только сырой CRUD, при том что редактор пайплайна их **читает**
через `<select>`, но не создаёт и не переименовывает), `AgentHarnessSubscription` (тонкая форма
создания есть на «Воркерах», но полный набор полей — только здесь), `AgentTaskSource` (форма
добавления есть на «Задачах», но правка существующей записи — здесь).
