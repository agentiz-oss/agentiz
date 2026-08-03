# Agentiz Worker

Эта папка содержит stage-0 spike отдельного Python worker на базе OpenHands Software Agent SDK.
Он не имеет доступа к БД Agentiz: регистрируется и получает run только через Worker API.

## Что проверяет spike

Один и тот же `ACPAgent` запускается в двух режимах, заданных в pipeline stage:

```json
{
  "order": 1,
  "role": "fix",
  "agentRoleKey": "codex",
  "runtime": { "mode": "host" }
}
```

или:

```json
"runtime": { "mode": "docker" }
```

Команда ACP находится в `AgentRole.config`, а не в pipeline: например
`{ "executor": "openhands-acp", "acpCommand": ["npx", "-y", "@agentclientprotocol/claude-agent-acp"] }`.
`host` передаёт checkout в `Conversation` напрямую. `docker` передаёт `DockerWorkspace`; SDK сам
создаёт Agent Server container, ждёт его готовности и удаляет в `finally`. Worker не вызывает
`docker run` сам.

Для детерминированного stage-0 smoke без LLM допустим только fixture executor:
`{ "executor": "bash-fixture", "bashCommand": ["bash", "-lc", "date -u +%Y-%m-%dT%H:%M:%SZ"] }`.
В режиме `docker` эта команда выполняется через `DockerWorkspace.execute_command()` внутри
Agent Server container; в `host` — в fixture checkout воркера.

## Установка на worker-host

Нужны Python 3.11+, Node/npm и доступный Docker daemon для режима `docker`. Создать virtualenv,
установить worker и убедиться, что Docker доступен:

```bash
cd worker
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -e .
docker version
docker run --rm hello-world
```

В production Worker API уже доступен на `https://agentiz.m42.cx`. Настройка не требует
переменных окружения: профиль, включая токен, хранится в
`~/.config/agentiz/worker.json` с правами `0600`.

```bash
agentiz-worker configure
# 1) выберите Agentiz production или 2) укажите свой сервер;
# в панели выбранного сервера создайте «Новый воркер» и вставьте показанный токен.
agentiz-worker run --once
```

Рабочую директорию вручную выбирать не нужно: настройщик создаёт
`~/.local/share/agentiz-worker/workspace`. В текущем stage-0 она нужна только для host-mode
исполнителя; будущий clone/checkout будет подготавливать её автоматически для каждой job.

Запись воркера создаётся в панели, а не самим клиентом: она выдаёт одноразовый **токен**,
не только ID. Сервер по этому токену сам связывает процесс с созданным воркером.

`--once` полезен для проверки регистрации и одной job. Первый запуск `docker` скачает образ
примерно на несколько гигабайт. Образ намеренно указан digest-ом, а не mutable `latest`.

В stage-0 не реализованы clone/checkout, diff, validation, secrets endpoint и cancel: это следующие
пункты плана. Для локального опыта используйте отдельный fixture checkout и dev credentials.

## Дистрибуция

Worker распространяется двумя эквивалентными способами. Для разработки и небольшого выделенного
host используйте wheel; для развёртывания — controller image. В обоих вариантах worker получает
только `AGENTIZ_WORKER_TOKEN`; доступ к Postgres ему не нужен.

### Wheel

Собрать wheel на CI/release-машине и положить его в приватный package registry или приложить к
релизу:

```bash
cd worker
python3 -m pip install build
python3 -m build
# получаем dist/agentiz_worker-0.0.1-py3-none-any.whl
```

На worker-host:

```bash
python3 -m venv /opt/agentiz-worker/venv
/opt/agentiz-worker/venv/bin/pip install agentiz_worker-0.0.1-py3-none-any.whl
```

После успешной проверки создайте постоянную пользовательскую systemd-службу:

```bash
agentiz-worker install-service
systemctl --user status agentiz-worker
```

Команда создаёт `~/.config/systemd/user/agentiz-worker.service`, включает и запускает службу.
Она читает только профиль текущего пользователя, поэтому токен не передаётся через environment
и не оказывается в unit-файле. Чтобы она продолжала работать после logout/reboot, включите linger
один раз от имени администратора: `sudo loginctl enable-linger $USER`.

### ACP: Codex или Claude

В панели Agentiz в разделе «ACP-агенты и пайплайн» выберите для роли **Codex** или **Claude**.
Панель сохранит только публичную команду ACP-адаптера в `AgentRole.config`; ключи моделей остаются
исключительно на машине воркера.

Основной вариант — войти по подписке один раз под **тем же Unix-пользователем**, который запускает
`agentiz-worker.service`. ACP-адаптеры увидят локальную сессию и будут использовать лимиты подписки:

- **Codex**: выполните `codex login` (на headless-хосте доступен `codex login --device-auth`) и
  завершите вход в ChatGPT. Сессия сохраняется в `~/.codex/`.
- **Claude**: установите Claude Code, выполните `claude` и завершите browser login в аккаунт с
  Pro/Max/Team/Enterprise-подпиской. Сессия хранится локально для этого пользователя.

API-ключи остаются только запасным вариантом для сервисных аккаунтов. Если они нужны, сохраните
ключ в `~/.config/agentiz/worker.env` с правами `0600`; служба автоматически читает этот файл:

```dotenv
# Codex ACP: @agentclientprotocol/codex-acp
OPENAI_API_KEY=...

# Claude ACP: @agentclientprotocol/claude-agent-acp
# ANTHROPIC_API_KEY=...
```

Для Claude оставьте только `ANTHROPIC_API_KEY`, для Codex — только `OPENAI_API_KEY` (либо
`CODEX_API_KEY`). Затем перезапустите пользовательскую службу воркера. У worker-host должны быть
Node.js/npm и доступ в сеть: ACP-адаптеры запускаются через `npx`.

### Controller image

Собрать и опубликовать версионный образ, например `registry.example/agentiz-worker:0.0.1`:

```bash
docker build -t registry.example/agentiz-worker:0.0.1 worker
docker push registry.example/agentiz-worker:0.0.1
```

На выделенном worker-host controller запускается так; Docker socket необходим только потому, что
`DockerWorkspace` создаёт отдельный Agent Server sandbox:

```bash
docker run --rm --name agentiz-worker \
  --env-file /etc/agentiz-worker.env \
  --mount type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock \
  --mount type=bind,src=/srv/agentiz-fixtures,dst=/workspace \
  -e AGENTIZ_WORKER_WORKSPACE=/workspace \
  registry.example/agentiz-worker:0.0.1
```

Docker socket фактически даёт привилегии хоста: этот вариант только для выделенной доверенной
машины. В production образ controller-а и `AGENTIZ_OPENHANDS_SERVER_IMAGE` публикуются по
версии и потребляются по digest; теги служат только удобной меткой.

### GitHub Actions release artifact

Тег `worker` либо `worker-v*` (например, `worker-v0.0.1`) запускает workflow
`Build worker release artifacts`. Он не публикует образ наружу: в run Actions сохраняются два
скачиваемых artifact-а — Python wheel и OCI-архив controller image. На целевом host образ можно
загрузить командой `docker load -i agentiz-worker-worker-v0.0.1.oci.tar`, а wheel установить из
того же artifact-а. Это позволяет сначала раздать worker в закрытую сеть, не открывая registry.

Основной документ: [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md).
