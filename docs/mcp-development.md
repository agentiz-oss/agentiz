# Разработка MCP-инструментов в Agentiz

## Карта реализации

Основные файлы:

| Файл | Ответственность |
| --- | --- |
| `local_modules/app-mcp/src/AppMCP.ts` | Включение endpoint, встроенные tools, Express middleware |
| `local_modules/app-mcp/src/McpServer.ts` | Registry, авторизация, каталог групп и HTTP-вызовы |
| `local_modules/app-mcp/src/McpToolHandler.ts` | Прием коллекции `mcpTools` из других layers |
| `local_modules/app-mcp/src/types.ts` | Контракты `IMcpTool` и `IMcpContext` |
| `layers/app-agentiz/mcp/agentizTools.ts` | Agentiz read-only tools и отдельные actions |
| `layers/app-agentiz/mcp/agentizManagementTools.ts` | Управляемые CRUD/worker mutations |
| `layers/app-agentiz/index.ts` | Публикация `agentizMcpTools` через `@Collection` |
| `local_modules/app-adminizer/src/mcp/userTool.ts` | Инструмент управления пользователями Adminizer |

Регистрация проходит через коллекции App Manager:

```text
layer: @Collection mcpTools
             │
             ▼
app-mcp: @CollectionHandler("mcpTools")
             │
             ▼
McpToolHandler.process() → McpServer.register()
             │
             ├── GET /mcp и /mcp/group/:group
             └── POST /mcp/call/:toolName
```

`appDependencies` заставляет App Manager смонтировать `app-mcp` до `app-agentiz`. Поэтому handler
коллекции уже готов, когда Agentiz публикует свои tools. Коллекция также поддерживает обратный
порядок: новый handler обрабатывает ранее накопленные элементы.

Встроенные `health`, `system.listApps` и `system.toggleApp` регистрируются самим `AppMCP`, а tools
прикладных layers должны приходить через `mcpTools`, без прямого импорта layer-to-layer.

## Контракт инструмента

```ts
interface IMcpTool {
  name: string;
  description: string;
  group?: string;
  groupDescription?: string;
  shortDescription?: string;
  mode: "public" | "protected";
  inputSchema?: Record<string, unknown>;
  handler: (params: unknown, context: IMcpContext) => Promise<unknown>;
}
```

Требования к полям:

- `name` глобально уникально во всем процессе. Используйте namespace layer, например
  `agentiz.taskDetails`.
- `group` — область progressive discovery. Без него tool попадет в `general`.
- `groupDescription` достаточно указать на первом tool группы; registry сохраняет первое
  непустое описание.
- `shortDescription` — одна строка для компактного каталога. Если поле пропущено, registry берет
  первое предложение `description` и обрезает его до 140 символов.
- `mode` почти всегда должен быть `protected`. `public` допустим только для данных, безопасных без
  авторизации.
- `inputSchema` описывает JSON-тело, но сейчас не исполняет валидацию.
- `handler` должен валидировать `params` в runtime и возвращать JSON-сериализуемое значение.
- `context.appManager` дает доступ к общему App Manager; `context.req` присутствует при HTTP-вызове,
  но отсутствует при in-process-вызове и типизирован как `unknown`.

Повторная регистрация одного имени перезаписывает предыдущий tool с предупреждением. Это нельзя
использовать как механизм override: при последующем unmount одного layer `unregister(name)` может
удалить tool другого layer. Имена должны быть действительно уникальными.

## Добавление инструмента Agentiz

### 1. Выберите группу и владельца логики

- Чистое чтение и диагностика: группа `agentiz`, файл `agentizTools.ts`.
- Любое изменение данных, синхронизация, запуск или отмена: группа `agentiz-actions`.
- CRUD business-records по возможности добавляйте как новую entity/operation в
  `agentizManagementTools.ts`, а не как дублирующий endpoint.
- Изменение сущности с инвариантами должно идти через domain service. Например, токены и статусы
  воркеров меняет `AgentWorkerRegistryService`, а не прямой `Model.update()`.

Не добавляйте постоянный mutation tool ради однократного ремонта данных. Такой ремонт должен быть
идемпотентной migration.

### 2. Опишите tool

Минимальный read-only пример:

```ts
const taskDetailsTool: IMcpTool = {
  name: 'agentiz.taskDetails',
  group: 'agentiz',
  shortDescription: 'Returns one task without project credentials.',
  description: 'Returns one Agentiz task by id. Secrets are never included.',
  mode: 'protected',
  inputSchema: {
    type: 'object',
    required: ['taskId'],
    additionalProperties: false,
    properties: {
      taskId: { type: 'string' },
    },
  },
  async handler(params) {
    const payload = objectParams(params);
    const taskId = stringParam(payload, 'taskId');
    if (!taskId) throw new Error('taskId:string is required');

    const task = await AgentTask.findByPk(taskId);
    if (!task) throw new Error(`AgentTask ${taskId} not found`);
    return taskTeaser(task);
  },
};
```

Schema и runtime-проверка намеренно дублируют обязательность `taskId`: первая помогает клиенту
сформировать запрос, вторая реально защищает handler.

Для action явно опишите побочный эффект в `description`. Опасные необратимые операции должны
требовать `confirm: true`. Там, где возможно, сделайте повторный вызов идемпотентным или возвращайте
`changed: false`.

### 3. Добавьте tool в экспортируемую коллекцию

Tool не регистрируется только из-за объявления в файле. Добавьте его в массив:

```ts
export const agentizMcpTools: IMcpTool[] = [
  // ...
  taskDetailsTool,
];
```

`AppAgentiz` уже публикует этот массив:

```ts
@Collection
mcpTools: IMcpTool[] = agentizMcpTools;
```

### 4. Ограничьте и очистите результат

- Для list tools задавайте default/max `limit`; текущая convention Agentiz — 50/200.
- Не возвращайте токены, credentials, необработанные secrets, IP и job snapshots с содержимым
  задач.
- Используйте существующие `mask*ForUI` helpers и teaser-функции.
- Большие payloads делайте opt-in, как `includePayloads` в `agentiz.runDetails`.
- Не возвращайте Sequelize instance целиком, если его поля не были явно проверены.

## Добавление MCP tools из нового layer

Новый layer не должен импортировать `AppAgentiz` и менять его registry напрямую. Добавьте
зависимость и опубликуйте собственную коллекцию:

```json
{
  "appDependencies": {
    "app-mcp": "*"
  }
}
```

```ts
import { AbstractApp, Collection } from '@nodeknit/app-manager';
import type { IMcpTool } from '@nodeknit/app-mcp';

export class AppExample extends AbstractApp {
  readonly appId = 'app-example';
  readonly name = 'Example';

  @Collection
  mcpTools: IMcpTool[] = [exampleStatusTool];

  async mount(): Promise<void> {}
  async unmount(): Promise<void> {}
}
```

Новый layer также нужно включить в `INIT_APPS_TO_ENABLE` и добавить его glob одновременно в
`tsconfig.json` и `tsconfig.runtime.json`. Иначе TSX может загрузить файл без
`experimentalDecorators` и упасть во время старта.

Если tool расширяет данные другого layer, используйте отдельную коллекцию/handler как extension
point. Прямые cross-layer imports в Agentiz запрещены архитектурой приложения.

## Добавление новой группы

Новая группа оправдана, если у нее самостоятельная область ответственности, которую клиенту не
нужно загружать вместе с существующими схемами. Для первого tool задайте оба поля:

```ts
group: 'example',
groupDescription: 'Inspect Example integration state.',
```

Не создавайте новую группу только ради одного action, если он естественно относится к
`agentiz-actions`. Название группы стабильно и входит в discovery API, поэтому его переименование
ломает клиентов.

## Изменение самого `app-mcp`

`local_modules/app-mcp` — отдельный git submodule. Меняйте его только для общей инфраструктуры:
нового transport, общей авторизации, schema validation, нового формата каталога или встроенного
system tool. Прикладной Agentiz tool должен оставаться в `layers/app-agentiz`.

После изменения submodule соберите и подготовьте пакет:

```bash
cd local_modules/app-mcp
npm run build
npm run package:prepare
cd ../..
npm run build
```

Проверяйте отдельно состояние корневого репозитория и submodule. Публикация/commit выполняются
только по явному запросу владельца репозитория.

### In-process API требует доработки

HTTP registry работает, но в текущем source tree `AppMCP.server` объявлен `private`, а
`McpServer` не предоставляет публичные `listGroups()`/`listTools()`. Одновременно
`AgentizAssistantService` обращается к этим членам как к публичному API; `npm run build` сообщает
об этом как минимум ошибками доступа к `server`. Не расширяйте этот неформальный доступ.

Правильное продолжение — добавить в `AppMCP` стабильный public facade для:

- компактного списка групп;
- полного списка tools выбранной группы;
- in-process-вызова tool.

При этом facade либо должен принимать авторизованный principal, либо явно оставаться низкоуровневым,
а каждый consumer обязан проверять права до вызова. Текущий `McpServer.callTool()` сам не применяет
`mode: protected`; проверка ключа существует только в HTTP middleware.

## Проверка изменения

### Статическая проверка

После TypeScript-изменений:

```bash
npm run build
```

Если baseline уже содержит чужие ошибки, сохраните исходный вывод и убедитесь, что новый файл не
добавил ошибок. Не исправляйте несвязанные проблемы в том же изменении.

### Локальная проверка endpoint

Запустите сервер с `MCP_ENABLED=true` и отдельным тестовым `MCP_ADMIN_KEY`:

```bash
npm run dev
```

В другом terminal:

```bash
MCP_URL=http://127.0.0.1:17280/mcp

curl -sS "$MCP_URL"
curl -sS -H "X-Mcp-Key: $MCP_ADMIN_KEY" "$MCP_URL"
curl -sS -H "X-Mcp-Key: $MCP_ADMIN_KEY" "$MCP_URL/group/agentiz"
curl -sS -X POST \
  -H "X-Mcp-Key: $MCP_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '<valid-json-body>' \
  "$MCP_URL/call/<tool-name>"
```

Проверьте:

1. Без ключа видны только public tools.
2. С ключом новый tool виден в правильной группе и его schema полна.
3. Protected-вызов без ключа возвращает `401`.
4. Валидный запрос возвращает ограниченный и очищенный результат.
5. Невалидные типы, пустые строки, неизвестные ID и превышенный limit обрабатываются явно.
6. Для mutation проверены no-op/retry, `confirm` и доменные инварианты.
7. После unmount/remount tool не исчезает и не конфликтует по имени.

После развертывания снова получите каталог production endpoint: наличие tool в локальном исходнике
не доказывает, что нужный образ уже запущен. Полный цикл описан в
[руководстве по развертыванию](./deploy-debug-guide.md).

## Что улучшать в framework дальше

Если MCP surface продолжит расти, приоритетны следующие общие улучшения:

1. Публичный типизированный facade `AppMCP` для in-process consumers.
2. Реальная валидация `inputSchema` до `handler` и отдельный ответ `400` для ошибок клиента.
3. Типизированный request/principal вместо `req?: unknown` и единая авторизация HTTP/in-process.
4. Тесты registry: collision, visibility, group discovery, auth и unmount.
5. Адаптер стандартного Model Context Protocol, если понадобится совместимость с готовыми
   JSON-RPC/Streamable HTTP MCP-клиентами.
6. Версионирование transport/схем и стабильная классификация ошибок.

Эти изменения относятся к `app-mcp`; новый прикладной tool не должен ждать их и может быть
добавлен через существующую коллекцию при соблюдении ограничений выше.
