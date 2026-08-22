# Ассистент в панели: карта и разбор проблем

Ассистент — единственная часть дашборда, которая собрана из **двух репозиториев** и уезжает в
прод **двумя независимыми релизами**. Из-за этого почти любая его поломка выглядит одинаково
(«окно белое» / «не вводятся символы»), а причина каждый раз в другом слое. Этот файл — карта
слоёв и порядок, в котором их надо исключать.

Смежное: [развёртывание и диагностика production](../deploy-debug-guide.md) — там про сервер и
воркер; здесь только про UI ассистента.

## 1. Из чего он состоит

| слой | что делает | где лежит |
| --- | --- | --- |
| UI ассистента | сам чат: тред, композер, `/`-команды, markdown | `adminizer`, `src/assets/js/ai-assistant/agent/` (точка входа `index.tsx`) |
| хост в браузере | правая шторка дашборда, лениво грузит бандл | `adminizer`, `src/assets/js/components/ai-assistant/AiAssistantPanel.tsx` |
| хост для приложения | полноэкранная страница, грузит **тот же** бандл | `agentiz`, `layers/app-agentiz-mobile-api/adminizer/modules/MobileAssistant.tsx` |
| маршрут страницы | `/dashboard/mobile-assistant`, отдаёт Inertia-компонент `module` | `agentiz`, `layers/app-agentiz-mobile-api/index.ts` (`adminizerMiddlewares`) |
| вход из приложения | одноразовый код → cookie `adminizer_jwt` → редирект на страницу | `agentiz`, `layers/app-agentiz-mobile-api/lib/mobileAssistantWebviewRouter.ts` |
| модель/навыки | что ассистент умеет отвечать про Agentiz | `agentiz`, `layers/app-agentiz/lib/ai/AgentizAssistantService.ts`, `agentSkills.ts` |
| история диалогов | таблица + кэш под синхронный контракт adminizer | `agentiz`, `layers/app-agentiz/lib/ai/assistantConversationHistory.ts` |

`/prj/agentiz/adminizer` — симлинк на чекаут adminizer; правки UI делаются там, а не в
`node_modules`.

Важное про React: бандл ассистента **не содержит своей копии React**. В
`vite.config.ai-assistant.ts` react/react-dom/jsx-runtime заалиасены на шимы
(`react-global-shim.js` и соседние), которые читают `window.React` панели. Поэтому «две копии
React» из-за ассистента возникнуть не могут — но могут из-за главного бандла, см. §3.

## 2. Как бандл попадает на страницу

Точек загрузки три, и все три указывают **литеральный путь** — vite их не переписывает:

```
AiAssistantPanel.tsx   →  ${routePrefix}/assets/ai-assistant/agent.es.js?v=${window.adminizerVersion}
MobileAssistant.tsx    →  ${routePrefix}/assets/ai-assistant/agent.es.js?v=${window.adminizerVersion}
control-paths.ts       →  ${routePrefix}/assets/controls/${name}.es.js?v=${window.adminizerVersion}
```

`window.adminizerVersion` пишет сервер в `adminizer/src/system/bindInertia.ts` из
`helpers/assetVersionHelper.ts` (реальная версия пакета). Серверный аналог для контролов —
`withAssetVersion()` в `helpers/inertiaAddHelper.ts`.

**Не используйте здесь `__APP_VERSION__`.** Это константа, которую vite вшивает на этапе сборки, а
`publish.yml` бампает версию **после** `npm run build`, уже в `./dist/package.json`. То есть
`__APP_VERSION__` навсегда равен версии из репозитория и между релизами не меняется.

## 3. Раздача ассетов: что хэшируется, а что нет

| бандл | конфиг | имя точки входа | чанки | как бастится кэш |
| --- | --- | --- | --- | --- |
| главный `app-*.js` | `adminizer/vite.config.ts` | `[name]-[hash].js` | хэшированные, **импортируют точку входа обратно** | хэшем в имени (через `manifest.json`) |
| `agent.es.js` | `adminizer/vite.config.ai-assistant.ts` | стабильное | нет вовсе (самодостаточен) | `?v=` |
| `controls/*.es.js` | `adminizer/vite.config.controls.ts` | стабильное | есть, обратных импортов нет | `?v=` |
| `dist/modules/*.js` | `agentiz/vite.config.ts` | стабильное | есть, обратных импортов нет | **ничем** (см. §6) |

Правило, из которого всё следует:

> Идентичность ES-модуля — это полный URL **вместе с query**. Точку входа, в которую её собственные
> чанки импортируют обратно по голому имени, кэш-бастить query **нельзя**: `app.js?v=1` и `app.js`
> станут двумя модулями, страница получит две копии React и умрёт на первом же хуке ленивого чанка.
> Такую точку входа бастим только хэшем в имени. Query — только для самодостаточного бандла.

Смена имени собранного ассета — это изменение **контракта**, а не только вывода сборки.
Потребителей три, и они в разных местах:

1. `manifest.json` → `bindInertia` (главный бандл);
2. захардкоженные `import()` (§2);
3. проверки в `agentiz/Dockerfile` — preflight «entry не ссылается на отсутствующие чанки»
   читает имя из манифеста; если вписать имя руками, оно упадёт на `ENOENT` при первом же
   переименовании и уронит сборку образа.

## 4. Цепочка релиза

Две независимые ветки доставки — половина проблем именно здесь:

```
adminizer (ветка alpha)
  push → .github/workflows/publish.yml → npm publish --tag alpha (5.0.0-build.N)
     ↓
agentiz: local_modules/app-adminizer/package.json  ← пин версии (это git-сабмодуль!)
  npm install → package-lock.json
     ↓
push в main → .github/workflows/container.yml → образ → прод
```

Чтобы пин доехал, нужны **оба** коммита: внутри сабмодуля и указатель на него в agentiz. Проверка:

```bash
git -C local_modules/app-adminizer show HEAD:package.json | grep '"adminizer"'
git ls-tree HEAD local_modules/app-adminizer            # SHA должен совпасть
git -C local_modules/app-adminizer branch -r --contains <SHA>   # сабмодуль запушен?
python3 -c "import json;d=json.load(open('package-lock.json'));print([v['version'] for k,v in d['packages'].items() if k=='node_modules/adminizer'])"
```

Реестр npm показывает новую версию **не сразу**: `npm publish` пишет «Your package is being
processed and may take a few minutes». Смотреть надо в лог CI (`+ adminizer@5.0.0-build.N`), а не
в `npm view` — там до десяти минут висят закэшированные метаданные.

## 5. Диагностика: что смотреть и в каком порядке

Сначала — что на проде вообще крутится, иначе можно час читать код, которого там нет:

```bash
source .env
curl -s -H "X-Mcp-Key: $MCP_KEY" -d '{}' https://agentiz.m42.cx/mcp/call/agentiz.overview \
  | python3 -c "import json,sys;s=json.load(sys.stdin)['result']['server'];print(s['gitSha'],s['buildTime'])"
gh run list --limit 5          # сборка образа могла упасть — прод тогда со старым кодом
curl -s -L https://agentiz.m42.cx/dashboard | grep -oE 'assets/app[^"]*\.js|adminizerVersion = "[^"]*"'
```

Затем — в браузере, на `/dashboard` и на `/dashboard/mobile-assistant`:

```js
const n = performance.getEntriesByType('resource').map(e => e.name);
({
  version: window.adminizerVersion,
  entry: n.filter(x => /assets\/app[-.]/.test(x)),      // должен быть РОВНО один
  agent: n.filter(x => /agent\.es\.js/.test(x)),        // и здесь ровно один
  rootLen: document.getElementById('app')?.innerHTML.length,   // 0 = рут упал
})
```

| что видно | причина | куда смотреть |
| --- | --- | --- |
| `#app` пустой, `Maximum update depth exceeded` / `Cannot read properties of null (reading 'useState')` | две копии React | сколько раз запрошена точка входа; в стеке будут **два разных URL одного файла** |
| точка входа запрошена дважды (с query и без) | query навесили на code-split entry | `bindInertia`, `entryFileNames` в главном конфиге |
| `adminizerVersion = ""` | `getAssetVersion()` не нашёл `package.json` | корень **опубликованного** пакета — это `dist/`, до `package.json` оттуда `../`, а не `../../` |
| `agent.es.js` без `?v=` | выполнилась старая закэшированная копия хоста | §6 |
| 404 на `agent.es.js` | ассистента собрали **до** главного бандла | §6 |
| «No AI models are available for your account» | не зарегистрирован `AgentizAssistantService` | нужен `MCP_ENABLED=true`: слой требует и `app-adminizer`, и `app-mcp` |
| панель открывается, но пустая | ошибка внутри бандла | консоль; sourcemap на проде нет — воспроизводить локально |

Если рут падает, а ключи снапшота при этом попарно равны и отличается только ссылка — это
`getSnapshot`, возвращающий каждый раз новый объект (так выглядел баг `LazyMemoizeSubject` в
`@assistant-ui/core` 0.2.23).

## 6. Грабли, каждая из которых уже стоила времени

**Порядок сборки ассетов в adminizer.** Главный `vite build` чистит `dist/assets`
(`emptyOutDir` по умолчанию), а конфиг ассистента стоит с `emptyOutDir: false`. Собирать только в
таком порядке, иначе `agent.es.js` исчезает и панель отдаёт 404:

```bash
npx vite build                                      # главный — первым
npx vite build --config vite.config.controls.ts
npx vite build --config vite.config.ai-assistant.ts
```

**`copy:backend` стирает `dist/*`.** Поэтому в `npm run build` он идёт первым. Если правили только
backend и не хотите потерять собранные ассеты — вызывайте
`npx tsc -p src/tsconfig.json && node ./scripts/appendJsExtension.js` напрямую.

**Локальный `dist/modules` не пересобирается сам.** Правка
`layers/*/adminizer/modules/*.tsx` локально не видна, пока не выполнить `npm run build:vite`:
сервер отдаёт `dist/modules`, а не исходник. На прод это не влияет — `dist/` в `.gitignore`, а
Dockerfile собирает модули сам.

**`dist/modules/*.js` раздаются с `max-age` ~7 часов и без хэша в имени.** Логика кэш-бастинга
живёт **внутри** этих файлов, поэтому уже установленный WebView со старым `MobileAssistant.js`
продолжает запрашивать старый `agent.es.js`, пока кэш не протухнет. Для чистой установки всё
правильно. Если это мешает — лечится либо `no-cache` на `/dashboard/modules/*`, либо хэшем в имени
через манифест.

**`package-lock.json` в adminizer не трекается** (в отличие от agentiz). Версии зависимостей
плавают на публикации — именно так в пакет однажды приехала несовместимая пара
`@assistant-ui/react` + `react-markdown`. Фиксирует только диапазон в `package.json`.

**`npm install` в adminizer — только с `--legacy-peer-deps`** (репозиторий на TS ^6,
`@typescript-eslint` требует `<6.0.0`; конфликт предсуществующий).

**Зависимости agentiz ставятся npm-ом, не yarn 4.** Berry **копирует** `file:`-зависимости вместо
симлинка, пакет уходит из-под `local_modules/**` в `tsconfig.runtime.json`, tsx перестаёт применять
`experimentalDecorators` и падают все слои. Проверка: `test -L node_modules/@nodeknit/app-adminizer`.

## 7. Локальный запуск для проверки UI

```bash
# adminizer со своей фикстурой
cd /prj/adminizer && npm run start          # http://localhost:3000/adminizer

# agentiz на чистой БД (ассистент требует MCP)
DB_STORAGE=/tmp/agentiz-fresh.sqlite MCP_ENABLED=true \
  OPENHARNESS_API_KEY=dummy-local-test-key PORT=17280 npm run dev
```

`state: 'ready'` у `AgentizAssistantService` — это просто `Boolean(process.env.OPENHARNESS_API_KEY)`,
ключ не валидируется. Фиктивного ключа достаточно, чтобы смонтировался `ChatSession` — то есть
чтобы проверить **загрузку и ввод**. Реальную отправку сообщения так не проверить.
