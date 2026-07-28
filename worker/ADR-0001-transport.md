# ADR-0001: Транспорт очереди между Agentiz и OpenHands worker

- Статус: **Proposed** (ожидает решения перед этапом 2 из [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md))
- Дата: 2026-07-22
- Контекст решения: раздел 7 плана оставлял выбор транспорта открытым и по умолчанию называл Redis Streams.

## 1. Контекст

Worker (Python) исполняет `AgentRun` в OpenHands-sandbox, Agentiz (TypeScript) — источник
истины по run/stage и владелец final action (commit/PR). Worker не имеет доступа к БД Agentiz:
между ними нужен versioned API, который умеет:

- надёжно **раздавать job** воркерам (claim, lease, reclaim после падения);
- нести **терминальный result** ровно один раз (at-least-once доставка + идемпотентность);
- передавать **live-события** стадий на UI;
- поддерживать **cancel** активной job;
- retry с backoff и dead-letter;
- работать между **Python и TypeScript**.

### Факты об инфраструктуре (проверено 2026-07-22)

- Agentiz уже зависит от **Postgres** (`pg`, `sequelize-typescript`) и от `sqlite3` для локали.
  `AgentRun` / `AgentStageExecution` / `AgentRunLog` уже хранятся в этой БД.
- **Redis и брокеров сообщений в зависимостях проекта нет.**
- В экосистеме уже есть **устоявшийся паттерн worker-очереди на Postgres**: смежное приложение
  (`Task` model, worker-каналы, cancel/expire) с **единым SSE-каналом на пользователя**
  (`GET /integrations?_method=subscribeUserEvents`, событие `task_update`) для live-логов.

Ключевое следствие: «добавить Redis» — это не нейтральный выбор, а новая инфраструктурная
зависимость со своим deployment/persistence/failover, тогда как надёжный store у нас уже есть,
и он же — источник истины по run.

## 2. Критерии решения

1. **Идемпотентность и «ровно один PR».** at-least-once + повторная доставка не должны создавать
   второй commit/PR.
2. **Единый источник истины.** Меньше систем, между которыми надо согласовывать состояние.
3. **Минимум новой инфраструктуры** и эксплуатационной нагрузки.
4. **Кросс-язычность** Python ↔ TypeScript.
5. **Соответствие существующим конвенциям** кодовой базы.
6. **Достаточная пропускная способность** — профиль нагрузки — единицы долгоживущих job, а не
   тысячи сообщений в секунду.

## 3. Рассмотренные варианты

| # | Вариант | Новая инфра | Идемпотентность | Live-события | Вердикт |
|---|---------|-------------|-----------------|--------------|---------|
| 1 | **Postgres-очередь** (`FOR UPDATE SKIP LOCKED`) | нет | транзакция с run — почти бесплатно | нужен отдельный push-канал | **выбран** |
| 2 | Redis Streams + consumer groups | Redis + persistence-политика | всё равно на стороне Postgres → 2 источника | тот же Redis (pub/sub) | резерв под масштаб |
| 3 | Postgres-очередь + Redis только pub/sub | Redis (некритичная роль) | Postgres | Redis pub/sub | компромисс, если SSE мало |
| 4 | RabbitMQ / NATS JetStream | отдельный брокер-сервис | Postgres | брокер | оверкилл для MVP |
| 5 | HTTP/gRPC pull за интерфейсом | нет | Postgres | polling/SSE | только локальный spike |

Отклонены сразу: **Kafka** (не тот класс задач: стрим-аналитика, не job-очередь с per-job cancel),
**BullMQ** (Node-only — отвалится Python-воркер), **cloud-managed** (SQS и т.п. — привязка к облаку,
deployment пока не зафиксирован).

## 4. Решение

Развести транспорт по **двум осям**, которые план объединял в одну:

### 4.1 Внутренняя очередь Agentiz → **Postgres, `SELECT … FOR UPDATE SKIP LOCKED`**

Postgres — внутренняя реализация control plane, а не транспорт, к которому подключается Python
worker. Только Agentiz использует Sequelize/SQL и DB credentials. Worker обращается к
`/api/agentiz/worker/v1` с service identity; API выполняет claim/lease/result-транзакции ниже.

- Таблица job (условно `agent_run_job`) с полями `status`, `attempt`, `worker_id`, `locked_until`,
  `available_at`, `dead` — по образцу существующей `Task`-модели смежного приложения.
- **Claim**: `SELECT … FOR UPDATE SKIP LOCKED LIMIT 1` внутри транзакции, проставить `worker_id` и
  `locked_until = now() + lease`.
- **Lease/reclaim**: фоновый sweep возвращает в очередь job, у которых `locked_until < now()`.
- **Heartbeat** воркера продлевает `locked_until` отдельно от прогресса стадии.
- **Retry/DLQ**: `attempt++` с backoff через `available_at`; исчерпание → `status='dead'`.
- **Идемпотентность бесплатно**: применение result, запись статуса run и пометка job `done`
  происходят **в одной транзакции** с `AgentRun`. Ключ дедупликации — `jobId + attempt`.
  Повторная доставка того же result не создаёт второй commit/PR, потому что final action
  выполняет Agentiz под тем же транзакционным замком.
- Python-сторона не использует `asyncpg`/`psycopg` или обёртки очереди: она использует HTTP client
  Worker API. Самописный слой на SKIP LOCKED остаётся только в TypeScript control plane.

### 4.2 Внешний transport worker → **Worker API v1**

- `POST /claims`, heartbeat, batch events, secret envelope, terminal result и release — полный
  контракт описан в §5 [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md).
- API аутентифицирует worker, проверяет `leaseToken` и schema version, лимитирует payload и
  дедуплицирует `eventId`/`resultId`.
- Long-poll claim + heartbeat cancel достаточно для MVP; ни DB polling, ни WebSocket от worker
  к серверу не требуются.

### 4.3 Live-события стадий → **существующий SSE-канал на пользователя**

- Переиспользовать этот паттерн: worker шлёт нормализованные события в Agentiz
  (через тот же надёжный канал либо лёгкий `POST /events`), Agentiz раскладывает их в
  `AgentRunLog` и ретранслирует в SSE-поток владельца run.
- Live-события — **best-effort**: единственный источник истины по статусу — терминальный result
  из Postgres-очереди. UI не должен полагаться на SSE как на надёжный канал.
- Прямой WebSocket от `RemoteConversation` OpenHands остаётся деталью воркера и **не** является
  каналом «worker → Agentiz»; наружу на UI идёт только нормализованный SSE.

### 4.4 Transport за интерфейсом

Весь transport-код worker прячется за HTTP client интерфейсом, чтобы на этапе 0 можно было гонять
fake control plane, а production-семантику проверять через Worker API поверх Postgres-очереди.

## 5. Когда пересматривать (триггеры для Redis Streams)

Вариант 2/3 (добавить Redis) оправдан, только если на этапе 0/1 подтвердится:

- потребность в **приоритетах/маршрутизации** между многими воркерами и сервисами;
- пропускная способность, при которой polling Postgres становится узким местом;
- нужен fan-out live-событий за пределы одного Agentiz-инстанса.

До появления такого доказательства масштаб не постулируем — это прямая рекомендация раздела 7 плана.

## 6. Последствия

**Плюсы:** ноль новой инфраструктуры; один источник истины; worker не получает доступ к главной
БД; идемпотентность и «ровно один PR»
получаются из транзакционности почти даром; согласуется с уже используемым паттерном;
кросс-язычность через стабильный HTTP contract.

**Минусы / что принять осознанно:** polling добавляет latency (смягчается `LISTEN/NOTIFY` или
коротким интервалом — для долгих job несущественно); при реальном росте нагрузки Postgres-очередь
уступит Redis (принимаем, пересмотр по триггерам из §5); большие patch/логи в БД-строке хранить
нельзя — нужен отдельный артефактный backend (уже отмечено как риск 9.6 плана, решается отдельно).

## 7. Открытые вопросы (до реализации §4)

- Схема таблицы job и её связь с `AgentRun` (внешний ключ vs. отдельная таблица).
- Точная OpenAPI-схема, auth-механизм (service token vs. mTLS) и расположение Worker API
  (основной сервер vs. private listener).
- Persistence больших артефактов (patch/логи) — object storage vs. лимитированный backend.
- Политика `LISTEN/NOTIFY` vs. polling-интервал и её влияние на нагрузку БД.
