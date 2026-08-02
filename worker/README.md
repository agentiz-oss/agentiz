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

Создайте worker в панели Agentiz и включите `AGENTIZ_WORKER_API_ENABLED=true` у сервера. Затем:

```bash
export AGENTIZ_WORKER_API_URL=http://localhost:17280/api/agentiz/worker/v1
export AGENTIZ_WORKER_TOKEN='token-shown-once-in-the-panel'
export AGENTIZ_WORKER_ID="dev-$(hostname)"
export AGENTIZ_WORKER_WORKSPACE="$PWD/../fixture-repo"
export AGENTIZ_OPENHANDS_SERVER_IMAGE='ghcr.io/openhands/agent-server:1.40.0-python-amd64@sha256:b2326ac6d444f3f80f2fa3260ab21653a9b6dfd02d5331643921428d79b87cc6'
agentiz-worker --once
```

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

Запуск оформляется systemd unit с environment file, в котором лежат `AGENTIZ_WORKER_API_URL`,
`AGENTIZ_WORKER_TOKEN`, `AGENTIZ_WORKER_ID`, `AGENTIZ_WORKER_WORKSPACE` и закреплённый
`AGENTIZ_OPENHANDS_SERVER_IMAGE`. Готовые шаблоны: [environment file](deploy/agentiz-worker.env.example)
и [systemd unit](deploy/agentiz-worker.service). Установить их можно так:

```bash
sudo install -D -m 600 deploy/agentiz-worker.env.example /etc/agentiz-worker.env
sudo install -D -m 644 deploy/agentiz-worker.service /etc/systemd/system/agentiz-worker.service
sudo systemctl daemon-reload
sudo systemctl enable --now agentiz-worker
```

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
