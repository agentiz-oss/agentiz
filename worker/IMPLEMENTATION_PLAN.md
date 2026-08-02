# OpenHands worker для Agentiz: исследование и каркас реализации

Статус: stage-0 spike начат. Дата проверки источников: 2026-08-02.

## 1. Вывод

Предложенный приём жизнеспособен: исполнитель не нужно строить с нуля. `DockerWorkspace`
поднимает контейнер Agent Server, ждёт его готовности и удаляет после выхода из context manager;
`Conversation` для такого workspace автоматически становится `RemoteConversation`, а события
идут по WebSocket. `ACPAgent` официально поддерживает удалённые workspace и позволяет запускать
ACP-совместимый Claude Code, Codex или другой ACP server.

Для Agentiz нужен тонкий Worker Controller вокруг этих компонентов:

```text
Agentiz Control Plane (TypeScript, источник истины по run/stage/job)
       │
       │ authenticated Worker API v1: claim / heartbeat / events / result
       ▼
worker/ (Python controller, без доступа к БД Agentiz)
       │
       ▼
OpenHands DockerWorkspace
       │ запускает и удаляет
       ▼
Agent Server container ── ACPAgent ── ACP server
```

Рекомендуемая граница: одна job соответствует одному `AgentRun`, а один workspace живёт весь
run. Стадии выполняются последовательно в одном checkout, чтобы следующий агент видел реальные
изменения предыдущего. Agentiz остаётся владельцем pipeline spec, очереди, статусов, логов и
final action; worker владеет только sandbox, ACP conversations и сбором результата. Граница между
ними — версионированный Worker API, а не общая схема БД.

## 2. Что подтверждено документацией

- `DockerWorkspace` управляет pull/start/readiness/cleanup контейнера и предоставляет команды и
  файловые операции: [Docker Sandbox](https://docs.openhands.dev/sdk/guides/agent-server/docker-sandbox).
- Удалённая conversation выбирается автоматически, транспорт — HTTP + WebSocket:
  [Agent Server Overview](https://docs.openhands.dev/sdk/guides/agent-server/overview).
- `ACPAgent` работает с `DockerWorkspace`/`APIRemoteWorkspace` и сам запускает ACP subprocess:
  [ACP Agent](https://docs.openhands.dev/sdk/guides/agent-acp).
- Agent Server можно защищать session API key; открывать его наружу без аутентификации нельзя:
  [Agent Server Package](https://docs.openhands.dev/sdk/arch/agent-server).

Поправка к исходной заметке: `ACPAgent(acp_env=...)` уже deprecated и заявлен к удалению в
OpenHands 1.29.0. Секреты следует передавать через `Conversation(..., secrets={...})` либо
`AgentContext.secrets`. Версии Python-пакетов и image Agent Server надо фиксировать вместе, а не
использовать `latest` в production.

## 3. Как это стыкуется с текущим Agentiz

Уже можно переиспользовать:

- `AgentRun.pipelineSnapshot` как неизменяемое описание job;
- заранее созданные `AgentStageExecution` как стадии прогресса;
- `AgentRunLog` как приёмник событий worker;
- `AgentRole` как источник prompt/model/executor config;
- `AgentPipelineService.applyFinalAction()` и `GitProvider` для commit + PR/MR.

Потребуются изменения:

- `runTask` должен создавать run и job в одной транзакции, возвращать `queued` и не ждать
  выполнения в HTTP request;
- stage loop для OpenHands-run переносится в worker или выделяется из текущего синхронного
  `executeRun` в worker; сервер оставляет у себя только state machine и final action;
- `cancelRun` должен записывать cancel command в job; worker получает её в heartbeat/poll и
  останавливает conversation/workspace;
- результат worker должен поддерживать create/update/delete и, при необходимости, бинарные файлы;
  текущий `FileChange { path, content }` умеет только текстовое create/update;
- нужен идемпотентный Worker API handler: повторная доставка event/result не должна повторно
  создать log, commit или PR.

`AgentExecutor` остаётся полезным для `stub` и локальных исполнителей, но один удалённый вызов на
каждую стадию создавал бы новый sandbox и терял рабочее дерево. Поэтому OpenHands worker лучше
подключать на уровне целого run, а не как наивную реализацию одного `AgentExecutor.execute()`.

## 4. Предлагаемая структура

```text
worker/
  README.md
  IMPLEMENTATION_PLAN.md
  pyproject.toml                 # точные версии OpenHands и HTTP client; без DB driver Agentiz
  Dockerfile                    # Worker Controller; Docker daemon остаётся внешним
  src/agentiz_worker/
    main.py                     # startup, shutdown, signals
    config.py                   # env validation, limits, pinned image
    contracts.py                # Job/Event/Result models, schema version
    control_plane_client.py     # Worker API v1: claim, lease, events, result, cancel
    job_runner.py               # lifecycle одной AgentRun job
    workspace.py                # DockerWorkspace/APIRemoteWorkspace factory
    repository.py               # clone/checkout, safe credentials, collect diff
    agent_factory.py            # ACP command allowlist + ACPAgent
    prompt_builder.py           # task + role + prior stage summaries
    event_forwarder.py          # OpenHands events -> нормализованные события
    result_validator.py         # path/diff/test/size policy
    redaction.py                # маскирование secrets в событиях и ошибках
  tests/
    unit/
    integration/
```

## 5. Worker API: обязательная граница control plane

Worker не импортирует TypeScript-модели и не подключается к Postgres Agentiz. Postgres-очередь
остаётся реализацией **внутри** Agentiz: контроллер атомарно создаёт job, claim-ит её, сохраняет
события и применяет result. Это позволяет менять ORM/схему без обновления всех worker-ов и не
выдавать Docker-host машине учётные данные главной БД.

Все маршруты имеют префикс `/api/agentiz/worker/v1`, доступны только worker identity (персональный
токен воркера с ротацией и отзывом; production — дополнительно mTLS или private network) и не
используют браузерную сессию. Identity создаётся в админке (Agentiz → «Воркеры» → «Новый воркер»,
реализовано в `AgentWorkerRegistryService`) по модели GitLab-runner'ов: запись `AgentWorker`
появляется сразу в статусе `active`, её токен показывается один раз, и воркер запускается с ним.
Отдельного enrollment-секрета и шага подтверждения нет: создание записи админом **и есть**
авторизация. `workerId` в теле запроса не принимается — он берётся из аутентифицированной
identity; в каждом запросе обязательны `schemaVersion`, `jobId`, `attempt` и `leaseToken` там, где
job уже claim-нута. JSON ограничен по размеру; stdout, patch и крупные
артефакты передаются ссылкой на artifact store, а не телом события.

| Метод | Назначение | Ответ / обязательная семантика |
|---|---|---|
| `POST /register` | Привязка процесса к identity: worker аутентифицируется **своим** токеном и сообщает стабильный `instanceId`, version, capabilities. Ничего не выдаёт. | Записывает `instanceId`/метаданные и `registeredAt` при первом контакте. Тот же `instanceId` у другого воркера — `409 instance_taken`. |
| `GET /me` | Worker проверяет, что о нём думает сервер (статус, allowlist проектов). | `status`, `allowedProjectIds`. Токен revoked → `401`, paused → job'ы не выдаются. |
| `POST /claims` | Worker запрашивает одну совместимую job, передавая capabilities и свободный slot. | `204` если работы нет; `200` с immutable job snapshot, `attempt`, `leaseToken`, `leaseExpiresAt`, `cancelRequested=false`. Claim атомарен. |
| `POST /jobs/:jobId/heartbeat` | Продлить lease и получить команду control plane. | Возвращает `continue` либо `cancel`; просроченный/чужой lease получает `409` и worker немедленно прекращает sandbox. |
| `POST /jobs/:jobId/events:batch` | Принять нормализованные stage/log/progress события. | `eventId` и `sequence` дедуплицируются; допускается частичный повтор batch. Ответ содержит последний принятый sequence. |
| `POST /jobs/:jobId/secrets` | Выдать только необходимые секреты в краткоживущем envelope. | Доступен лишь holder-у lease; значения не сохраняются в job/log и сразу передаются в `Conversation.secrets`. |
| `POST /jobs/:jobId/result` | Передать terminal result: diff/manifest, validation, summaries и classification. | Идемпотентен по `jobId + attempt + resultId`; сервер валидирует, применяет final action ровно раз и возвращает terminal run state. |
| `POST /jobs/:jobId/release` | Явно освободить job при startup/config error до начала работы. | Сервер назначает retry/backoff либо terminal failure по policy. |
| `GET /healthz`, `GET /readyz` | Проверка control plane для worker deployment. | Не раскрывают job, secret или пользовательские данные. |

Для MVP worker делает long-poll `POST /claims` с коротким server timeout вместо постоянного
polling БД. Heartbeat служит и каналом cancel; отдельный push/WebSocket между сервером и worker
не нужен. UI получает best-effort SSE **только от Agentiz**, после записи событий в его БД.

### 5.1 Что именно меняется в управляющем сервере

Текущий сервер уже имеет доменные модели, но его API ориентирован на UI: `POST /agentiz` с
`_method=runTask` синхронно вызывает `AgentPipelineService.executeRun()`, а `cancelRun()` только
меняет статус. Это нельзя оставить параллельно с worker — два исполнителя смогут обработать один
run. После миграции единственный путь исполнения выглядит так:

| Текущий элемент Agentiz | Изменение для Worker API |
|---|---|
| `AgentPipelineService.createRun()` | В транзакции создаёт `AgentRun`, pending stages и immutable `AgentRunJob` с полным snapshot; затем возвращает queued run. |
| `AgentPipelineService.executeRun()` | Убирается из UI/MCP пути. Его server-only части выделяются в `applyWorkerResult()` и `applyFinalAction()`. |
| `POST /agentiz`, `_method=runTask` и MCP `agentiz.runTask` | Вызывают только create + enqueue; ответ содержит `runId`, `status=queued` и URL/status endpoint. |
| `cancelRun()` | Для pending job снимает её с очереди; для leased/running выставляет durable `cancel_requested_at/reason`. Финальное `cancelled` ставит result/release handler после cleanup worker. |
| `AgentRunJob` (новая внутренняя модель) | Хранит snapshot, priority, attempt, `workerId`, `leaseTokenHash`, `lockedUntil`, `availableAt`, cancel, retry/DLQ и terminal result reference. |
| `AgentRunLog` / `AgentStageExecution` | Обновляются только API handler-ами; добавить `eventId`, `sequence`, source=`worker` и уникальный индекс на event dedup. Клиентский input не может задавать произвольный status. |
| Новый `WorkerApiController` | Единственная точка claim/heartbeat/events/secrets/result/release; проверяет auth, ownership lease, state transition, schema и лимиты до любой записи. |
| Новый `WorkerAuthService` | Раздельные credentials для worker, key id/rotation/revocation и audit. Токен Git пользователя и browser auth никогда не принимаются как worker credential. |

Миграция должна вводиться feature flag-ом `AGENTIZ_WORKER_API_ENABLED`: пока он выключен,
worker routes отвечают `503`, а новые `runTask`/MCP не включаются частично. После включения
синхронный `executeRun` не должен быть доступен ни из HTTP, ни из MCP. Это исключает двойной
commit во время rollout.

### 5.2 Черновой контракт claim response

Claim response содержит данные, достаточные для воспроизводимого запуска, без последующих чтений
worker-ом БД Agentiz:

```json
{
  "schemaVersion": 1,
  "jobId": "run UUID",
  "attempt": 1,
  "leaseToken": "opaque, short-lived",
  "leaseExpiresAt": "2026-07-22T12:00:00Z",
  "repository": {
    "cloneUrl": "https://git.example/group/repo.git",
    "baseRef": "immutable commit SHA"
  },
  "task": { "externalId": "481", "title": "...", "description": "...", "tags": [] },
  "stages": [
    {
      "executionId": "stage UUID",
      "role": "fix",
      "systemPrompt": "...",
      "agent": { "kind": "claude-acp", "model": "..." }
    }
  ],
  "validation": { "commands": ["npm test"], "timeoutSec": 1800 },
  "limits": { "jobTimeoutSec": 3600, "maxOutputBytes": 10485760 }
}
```

Секреты не включать в сохраняемый JSON job. Получать их через `POST /jobs/:jobId/secrets`
непосредственно перед запуском; внутрь OpenHands направлять через
`Conversation.secrets`. В логах хранить только имена секретов, не значения.

Минимальные события: `job.claimed`, `workspace.ready`, `stage.started`, `stage.event`,
`stage.completed`, `validation.completed`, `job.completed`, `job.failed`, `job.cancelled`,
`worker.heartbeat`. Каждое событие несёт `eventId`, `jobId`, `attempt`, timestamp и монотонный
sequence number.

Результат v1:

- финальный commit SHA исходной базы;
- нормализованный список file operations либо patch + manifest;
- stdout/stderr и exit code проверок с ограничением размера;
- summaries и метрики каждой стадии;
- причина завершения и классификация ошибки (`retryable`/`terminal`).

## 6. Жизненный цикл job

1. Claim job атомарно; записать worker id, attempt и lease.
2. Проверить schema version, allowlist image/ACP command и лимиты.
3. Получить временные секреты; не писать их в job/event/log.
4. Создать один `DockerWorkspace` на весь run.
5. Клонировать репозиторий и checkout строго по `baseRef` SHA.
6. Для каждой стадии создать `ACPAgent`/`Conversation`, построить prompt, пересылать события и
   закрыть conversation/agent в `finally`. Рабочее дерево между стадиями сохранить.
7. Выполнить разрешённые validation commands с timeout.
8. Собрать и проверить изменения: запрет выхода из repo, symlink escape, oversized/binary policy,
   protected paths и отсутствие секретов.
9. Опубликовать terminal result и только после подтверждения доставки ack job.
10. В `finally` закрыть workspace и удалить временные credentials.

Agentiz применяет результат, выполняет существующий final action и публикует окончательный
статус. Commit/PR в v1 делает только Agentiz: так повторный запуск worker не создаст второй PR,
а write-токен Git-провайдера не понадобится внутри agent sandbox.

## 7. Очередь и надёжность

Транспорт зафиксирован в [ADR-0001](./ADR-0001-transport.md). Решение — развести его на три
границы:

- **Внутренняя надёжная очередь Agentiz — Postgres, `SELECT … FOR UPDATE SKIP LOCKED`.** Redis в
  зависимостях проекта нет, а Postgres уже источник истины по `AgentRun`. Только API сервера
  обращается к этой таблице: `POST /claims` выполняет claim, heartbeat продлевает lease, а result
  handler в одной транзакции применяет result, меняет run и помечает job. Worker не получает DB
  credentials, а идемпотентность и «ровно один PR» сохраняются.
- **Внешний worker transport — Worker API v1 из §5.** Он скрывает ORM и schema, аутентифицирует
  worker, проверяет lease и даёт серверу возможность менять внутренний transport без релиза worker.
- **Live-события стадий — существующий SSE-канал на пользователя** (тот же паттерн,
  `subscribeUserEvents`), best-effort; источник истины по статусу — терминальный result из очереди.

Требования к надёжному каналу остаются прежними:

- явное поле priority (не отдельные streams);
- lease через `locked_until` + `worker_id`, reclaim фоновым sweep'ом после падения worker;
- heartbeat продлевает lease отдельно от прогресса стадии;
- bounded retries с backoff (`available_at`) и dead-letter (`status='dead'`);
- at-least-once доставка, поэтому все события и финализация идемпотентны;
- `jobId + attempt + resultId` — ключ дедупликации terminal result; `eventId` — ключ дедупликации
  event. Оба ключа и последний sequence хранятся на стороне сервера.

Redis Streams с consumer groups остаётся резервом на случай доказанной потребности в
масштабе/приоритетах/fan-out за пределы одного инстанса (триггеры — §5 ADR), но заранее не
постулируется. Для локального spike допустим in-memory job store за серверным интерфейсом, но
production semantics проверяются через Worker API поверх Postgres-очереди. Python worker никогда
не имеет альтернативного прямого transport-а к production БД.

## 8. Разработка и тестирование из WSL

**Отдельный VPS для разработки не нужен.** Основной локальный контур — один Windows-компьютер:
Agentiz и Python worker работают как процессы внутри WSL 2, а `DockerWorkspace` создаёт Agent
Server-контейнеры в Docker Desktop. Для worker это тот же локальный Docker daemon через
`/var/run/docker.sock`; он не обязан быть установлен как system service или отдельный контейнер.
Именно этот контур должен быть первым поддерживаемым способом разработки.

```text
WSL 2 distribution
  npm run dev  ──────────────── Agentiz :17280
  Python venv: worker --dev ─── Postgres (локальный контейнер)
                 │
                 └──────────── Docker Desktop daemon
                                    └─ одноразовый Agent Server container
                                          └─ ACP server / fixture repository
```

### 8.1 Локальный dev-контур

1. Код репозитория хранить в файловой системе WSL (`~/src/...`), а не в `/mnt/c/...`: это важно
   для скорости bind mount и получения файловых событий контейнерами.
2. В Docker Desktop включить **Use WSL 2 based engine** и интеграцию именно с используемой WSL
   distribution; использовать Linux containers. Не устанавливать второй Docker Engine внутри
   этой distribution одновременно с Docker Desktop.
3. До запуска worker проверить из WSL: `docker version`, `docker run --rm hello-world` и наличие
   доступного Docker socket. Worker подключается к daemon по умолчанию, не по открытому TCP-порту
   Docker API.
4. Запустить Postgres локально (достаточно одного сервиса из `deploy/docker-compose.local.yml`),
   Agentiz — `npm run dev`, worker — из Python virtualenv в режиме watch/restart. На этапе 0–1
   worker **не контейнеризировать**: так быстрее менять Python-код и проще видеть логи; Docker
   используется только для создаваемых им Agent Server sandbox-ов.
5. Использовать отдельную БД, `WORKER_ID=dev-<hostname>` и fixture Git-репозиторий. В локальном
   контуре `finalAction=comment_only` либо mock `GitProvider`; реальный push/PR и production
   токены запрещены.
6. После каждого прогона проверять, что workspace-контейнер исчез. Для отладки можно сохранять
   его по явному `KEEP_WORKSPACE_ON_FAILURE=true`; это значение по умолчанию выключено и не
   допускается в production.

`deploy/docker-compose.local.yml` сейчас содержит legacy service `worker` другого приложения
существующего воркера; его нельзя считать манифестом нового OpenHands worker. В этапе 1 нужно
добавить отдельный минимальный compose profile/файл только для Postgres (и, при необходимости,
Agentiz), не переиспользуя этот service.

### 8.2 Пирамида тестов

| Уровень | Где запускается | Что подтверждает | Реальный Docker/LLM |
|---|---|---|---|
| Unit | WSL, без инфраструктуры | contracts, redaction, prompt, retry/backoff, policy diff/path | Нет |
| Integration | WSL + локальный Postgres | claim/lease/reclaim, result идемпотентность, cancel, маппинг событий | Подменный ACP/Agent Server |
| Sandbox smoke | WSL + Docker Desktop | `DockerWorkspace` lifecycle, readiness, mount, timeout, cleanup | Docker; безопасная детерминированная ACP fixture |
| E2E | WSL + Docker Desktop + fixture repo | две стадии, validation, diff, SSE, cancel, crash recovery | Docker; модель только при наличии отдельного dev credential |
| Staging | отдельная Linux VM/host | production runtime и security assumptions | Docker/rootless или `APIRemoteWorkspace` |

Smoke- и E2E-тесты не должны зависеть от публичной задачи или настоящего PR. Fixture repository
создаётся/копируется локально, задача разрешает лишь предсказуемую правку (например, изменить
один тестовый файл), а ACP server для CI заменяется deterministic fake. Реальный Claude/Codex
ACP прогон — отдельный opt-in smoke с ограниченным dev-секретом и лимитом стоимости.

Обязательные сценарии перед merge этапов 1–3: успешный run; ошибка ACP; timeout; cancel во время
стадии; `SIGKILL` worker с последующим reclaim; повторная доставка final result; cleanup после
ошибки; блокировка symlink/path escape и секрета в событии. После TypeScript-изменений запускать
`npm run build`; Python-набор запускать отдельно из worker virtualenv.

### 8.3 Когда нужен отдельный Linux host

VPS/staging нужен **не** для ежедневной разработки, а до первого production rollout и при
изменениях, затрагивающих runtime/sandbox. На нём проверить: версию Docker и pinned images,
рестарт daemon/worker, лимиты CPU/RAM/disk, сетевой egress policy, доступ к Git/secret provider,
orphan reaper и отсутствие внешне опубликованного Docker socket/Agent Server. Если production
worker будет жить на отдельной машине, он подключается только к её локальному daemon или к
аутентифицированному `APIRemoteWorkspace`; подключать dev-WSL к production Docker daemon нельзя.

Docker socket даёт фактически привилегированный доступ к машине. Поэтому даже локальный контур
использует только доверенные fixture jobs, а production — выделенный worker host, отдельные
credentials и по возможности rootless Docker/remote workspace. WSL удобен для функциональной
проверки, но не является доказательством production isolation.

Справка: [Docker Desktop WSL 2 backend](https://docs.docker.com/desktop/features/wsl/),
[рекомендации по файловой системе WSL](https://docs.docker.com/desktop/features/wsl/best-practices/).

## 9. Этапы реализации

### Этап 0 — технический spike

- Зафиксировать совместимые версии `openhands-*`, Agent Server image по digest и ACP npm packages.
- Поднять `DockerWorkspace`, выполнить одну безопасную ACP-задачу в fixture repository.
- Описать и автоматизировать WSL preflight (`docker version`, socket, Linux containers) и локальный
  smoke; проверить cleanup контейнера после success, error и cancel.
- Проверить события, timeout, cancel, cleanup контейнера и redaction секрета.
- Проверить Claude ACP и Codex ACP отдельно: команды, auth, model selection, exit behavior.
- Измерить cold start, RAM/disk и объём событий.

Критерий выхода: воспроизводимый script + таблица подтверждённых API; никаких `latest`.

#### Реализованный минимальный контур

`worker/src/agentiz_worker/main.py` проверяет machine-to-machine границу (`register → claim →
events → result`) и запускает `ACPAgent` через OpenHands. Pipeline stage выбирает только
расположение workspace: `runtime.mode: "host"` даёт локальный `Conversation`,
`runtime.mode: "docker"` — `DockerWorkspace`. ACP-команда остаётся свойством `AgentRole.config`
(`acpCommand`) и не дублируется между стадиями. Версии фиксируются в `pyproject.toml`:
`openhands-sdk==1.40.0` и `openhands-workspace==1.40.0`; Docker image передаётся только digest-ом
через `AGENTIZ_OPENHANDS_SERVER_IMAGE`. Команда локальной проверки — в `README.md`.

### Этап 1 — protocol и skeleton worker

- Добавить OpenAPI 3.1 document + JSON Schema fixtures для Worker API; генерировать/проверять
  TypeScript и Pydantic contracts из одного источника, а не поддерживать две ручные копии.
- В Agentiz добавить внутренние модели/migration `agent_run_jobs`, `agent_run_event_dedup` и
  `agent_run_result_dedup`, API authentication и handlers claim/heartbeat/events/result/release.
- Реализовать в Python API client, config, health/readiness и graceful shutdown; не добавлять
  DB driver Agentiz в зависимости worker.
- Реализовать один job/одна стадия/один workspace без commit/push через API.
- Добавить unit tests для contract validation, prompt и redaction.

### Этап 2 — интеграция Agentiz

- Разделить `createRun`, transactional enqueue и API result handler; удалить путь, в котором
  `runTask` вызывает `executeRun` в HTTP/MCP request.
- Сделать `runTask` быстрым асинхронным endpoint.
- Маппить worker events в `AgentRunLog` и статусы `AgentStageExecution` только после проверки
  worker auth, lease и sequence.
- Расширить file operation contract и безопасно передать его в `GitProvider`.
- Добавить idempotency table/fields, secret envelope и реальную отмену через heartbeat command.

### Этап 3 — полный pipeline

- Несколько стадий в одном workspace, политика `onFail`, previous summaries.
- Validation commands и result policy.
- Existing `comment_only`/`commit_and_pr` final actions после успешного результата.
- Интеграционный тест: issue -> queued run -> worker -> diff -> commit -> PR/MR mock.

### Этап 4 — production hardening

- Concurrency semaphore, resource quotas, job/stage/command timeout.
- Lease renewal, retry/DLQ, crash recovery и orphan container reaper.
- Метрики queue lag/job duration/failures/resources и structured logging.
- Защищённый Docker socket/rootless runtime либо переход на `APIRemoteWorkspace`.
- Image allowlist, network egress policy, dependency/cache strategy и audit trail.

## 10. Риски и вопросы до кодирования

1. **Docker socket.** Worker с доступом к host Docker daemon имеет высокий уровень привилегий;
   контейнер Agent Server нельзя считать единственной границей безопасности.
2. **ACP auto-approval.** OpenHands автоматически подтверждает permission requests ACP server;
   допустимы только доверенные и зафиксированные команды/images.
3. **Формат изменений.** Нужно решить поддержку delete/rename/mode/binary до интеграции с текущим
   `GitProvider`.
4. **Отмена.** Недостаточно сменить статус в БД: нужен signal к активной conversation и
   гарантированный cleanup workspace.
5. **Секреты.** Нужен короткий TTL, redaction и запрет попадания токена в git remote, patch и
   conversation persistence.
6. **Размер job.** Большие логи/patch нельзя хранить прямо в Redis; нужен object storage либо
   лимитированный артефактный backend.
7. **Conversation strategy.** По умолчанию отдельная conversation на стадию в общем workspace;
   reuse одной conversation между разными ролями требует отдельного эксперимента.
8. **Kubernetes.** `DockerWorkspace` внутри Pod потребует Docker daemon/socket. Для Kubernetes
   целевая схема — `APIRemoteWorkspace` или Agent Server непосредственно в отдельном Pod.

## 11. Definition of Done для первого рабочего MVP

- Нажатие Run возвращает `queued` без ожидания agent execution.
- Worker получает работу, lease, cancel и terminal result только через authenticated Worker API;
  у него нет credentials к Postgres Agentiz.
- Один worker безопасно claim-ит run, выполняет две стадии в одном workspace и шлёт live events.
- Падение worker приводит к reclaim либо terminal failure без двойного commit/PR.
- Cancel останавливает активную задачу и удаляет workspace.
- Секреты отсутствуют в Redis payload, БД-логах, stdout и результирующем diff.
- Тестовая правка проходит validation и публикуется существующим `GitProvider` ровно один раз.
- Unit/integration tests worker зелёные; после TypeScript-изменений проходят `npm run build` и
  релевантные тесты Agentiz.
- Локальный WSL smoke подтверждает lifecycle контейнера, а staging-проверка подтверждает целевой
  Linux runtime до включения worker для реальных репозиториев.
