# Телеметрия лимитов provider-specific harness'а

Лимит подписки принадлежит аккаунту harness'а, а не одному запуску Agentiz. Поэтому worker
периодически сообщает серверу его состояние отдельно от ACP token usage стадии: это позволяет
панели показывать окна и claim-сервису не выдавать работу подписке, про которую уже известно, что
она исчерпана.

## Граница между worker, core и provider layer

Worker (`worker/src/agentiz_worker/harness_usage.py`) знает только, как получить отчёт там, где
живёт credential. Он передаёт `raw` через `POST /harness-usage`, не переводя названия окон,
проценты или reset timestamp в общий словарь. Пустой либо нераспознанный отчёт вообще не посылается:
иначе сервер создал бы binding для harness'а, которого на машине фактически нет.

Core получает этот запрос в `AgentWorkerApiService.reportHarnessUsage`, находит участника
коллекции `harnessLimitProviders` и передаёт нормализованный snapshot в
`AgentCapacityService.applySnapshot`. Там появляются `AgentHarnessUsageSample` и cached windows
подписки; там же работают общие stop policy, claim gate и повторная постановка отложенного job.
Core намеренно не знает форматов Claude, Codex или будущего провайдера.

Словарь конкретного поставщика находится в отдельном layer: `app-agentiz-claude-limits` и
`app-agentiz-codex-limits` публикуют `HarnessLimitProvider` через `@Collection`. Его
`interpretReport` превращает `raw` в `{ key, label, usedPercent, resetsAt }`, сохраняя неизвестные
поля в `meta`; `classifyFailure` переводит только документированные тексты отказа ACP в
`exhausted` или `throttled`. Обычная ошибка агента не должна быть лимитом только потому, что
рядом встретилось знакомое слово.

## Как добавлять и проверять harness

Новый collector добавляют в `COLLECTORS`, а новый provider — отдельным layer без прямого импорта
из `app-agentiz`. Layer включают в `INIT_APPS_TO_ENABLE`, `tsconfig.json` и
`tsconfig.runtime.json`: последний glob нужен TSX для decorators. Нельзя переносить parsing в
worker: CLI и backend форматы меняются независимо, и server-layer можно обновить без worker
release.

Codex — показательный случай. Worker общается только с публичным `codex app-server --stdio` и
работает с теми же `HOME`/`CODEX_HOME`, что у службы. Он не читает `~/.codex/auth.json`, не делает
HTTP к внутреннему backend и не отправляет credential в sample. `rateLimits` и
`rateLimitsByLimitId` приводятся в generic windows слоем
`layers/app-agentiz-codex-limits/lib/codexLimitProvider.ts`; bucket не связывается с моделью,
поскольку это неустойчивый внешний контракт. API-key режим не образует subscription windows.

При диагностике сначала смотрят, есть ли после одного telemetry interval sample с нужным
`harnessKey`, затем проверяют, что layer смонтирован и его unit tests знают текущую форму raw
ответа. Отсутствие sample при `codex logout`, сети или старом CLI — ожидаемая безопасная деградация:
worker продолжает claim loop и пишет только короткое `usage: could not read ...` предупреждение.
Отказ `usage_limit_exceeded` во время run проверяется отдельно: его должен распознать provider,
после чего job отложится обычным capacity-механизмом.
