# Настройка push-уведомлений: от пустого аккаунта до пришедшего уведомления

Что настраивается: сервер узнаёт, что агент задал вопрос, и присылает уведомление на телефон
владельца проекта; тап по уведомлению открывает экран этого вопроса.

Дорог две, и они независимы:

```
Android ──FCM-токен──▶ сервер ──▶ FCM (Google) ──▶ телефон
iOS     ──APNs-токен─▶ сервер ──▶ APNs (Apple) ──▶ телефон
```

iOS ходит в Apple **напрямую**, не через FCM: приложение регистрирует «сырой» APNs-токен, и в
iOS-сборке нет ни Firebase SDK, ни CocoaPods. Поэтому Firebase нужен **только для Android**, а
ключ Apple — **только для iOS**. Ни один из них не обязателен: без настроек пуши просто не
отправляются, вопрос всё равно виден в приложении и в дашборде (см. «Если ничего не настроено»).

Всё, что ниже, — одноразовые действия. Порядок частей A и B неважен, делайте нужную.

---

## Часть A. Android: Firebase Cloud Messaging

Нужны два разных артефакта, их постоянно путают:

| Артефакт | Куда | Кому |
| --- | --- | --- |
| `google-services.json` | в мобильное приложение, при сборке | приложению — чтобы получить токен |
| service account JSON | на сервер, в переменную окружения | серверу — чтобы отправлять |

### A1. Проект Firebase

1. https://console.firebase.google.com → **Add project**. Имя любое (например `agentiz`),
   Google Analytics можно отключить — на пуши он не влияет.
2. В проекте: **Build → Cloud Messaging**. Если предложит включить *Firebase Cloud Messaging API
   (V1)* — включить. Legacy-API (server key) нам не нужен вообще, сервер работает по HTTP v1.

### A2. `google-services.json` — для приложения

1. Project settings (шестерёнка) → вкладка **General** → **Your apps** → **Add app** → Android.
2. **Android package name** — точно `com.example.app` (значение `applicationId` в
   `mobile-client/composeApp/build.gradle.kts`). Не совпадёт — токен не выдастся.
   Nickname и SHA-1 можно не заполнять: SHA-1 нужен для Google Sign-In, не для пушей.
3. Скачать `google-services.json` и положить в репозиторий мобильного клиента:

       mobile-client/composeApp/google-services.json

   Файл **не коммитится** (он в `.gitignore`) — это конфиг конкретной инсталляции.
   Проверка: при сборке без него Gradle пишет
   `composeApp: no google-services.json — Android push notifications will be inert in this build`,
   и приложение собирается и работает, только без пушей.

### A3. Service account JSON — для сервера

1. Project settings → вкладка **Service accounts** → **Generate new private key** → **Generate key**.
2. Скачается JSON вида:

   ```json
   {
     "type": "service_account",
     "project_id": "agentiz-xxxxx",
     "private_key_id": "...",
     "private_key": "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n",
     "client_email": "firebase-adminsdk-xxxxx@agentiz-xxxxx.iam.gserviceaccount.com",
     ...
   }
   ```

   Сервер читает из него ровно три поля: `project_id`, `client_email`, `private_key`. Если какого-то
   нет — при первой отправке будет ошибка `service account is missing project_id, client_email or
   private_key`.
3. Положить на сервер вне репозитория и закрыть права:

       sudo install -m 600 -o agentiz -g agentiz ~/Downloads/agentiz-xxxxx.json \
         /etc/agentiz/firebase-service-account.json

4. В `.env` сервера:

       PUSH_PROVIDER=firebase
       AGENTIZ_FCM_SERVICE_ACCOUNT=/etc/agentiz/firebase-service-account.json

   Можно вместо пути положить **сам JSON одной строкой** — переменная принимает и то и другое
   (удобно для Docker/CI, где файла нет). Строку в этом случае обязательно в одинарных кавычках,
   `\n` внутри `private_key` оставить как есть.

Больше для Android ничего не нужно: канал уведомлений (`agentiz-interactions`), запрос разрешения
`POST_NOTIFICATIONS` на Android 13+ и отправка токена на `/devices` уже в приложении.

---

## Часть B. iOS: ключ APNs

Нужен один файл `.p8` и три идентификатора. Всё делается в https://developer.apple.com/account
(нужна роль Account Holder или Admin).

### B1. Ключ APNs (`.p8`)

1. **Certificates, Identifiers & Profiles → Keys → +** (Create a key).
2. Имя любое (`Agentiz APNs`), поставить галку **Apple Push Notifications service (APNs)** →
   Continue → Register.
3. **Download** — файл `AuthKey_XXXXXXXXXX.p8`. **Скачать можно один раз**, второй раз Apple его не
   отдаст; потерян — заводится новый ключ.
4. `XXXXXXXXXX` в имени файла — это **Key ID**, он же показан на странице ключа.

Один ключ работает на все приложения команды и на sandbox, и на production — плодить ключи на
каждое приложение не нужно (лимит: два ключа APNs на аккаунт).

### B2. Три идентификатора

| Что | Где взять | Пример |
| --- | --- | --- |
| Key ID | имя файла `AuthKey_XXXXXXXXXX.p8` или страница ключа | `ABC123DEFG` |
| Team ID | developer.apple.com → Membership details | `5K5GDFV386` |
| Bundle ID | App ID приложения; в этом проекте `BUNDLE_ID` в `mobile-client/.env` | `cx.m42.agentoz` |

Bundle ID должен совпадать **точно** — он уходит в заголовок `apns-topic`, и при расхождении Apple
отвечает `DeviceTokenNotForTopic`.

### B3. Capability у App ID

**Identifiers** → нужный App ID → включить **Push Notifications** → Save. Если App ID создавался
давно, галка может быть снята — без неё устройство не получит токен.
Provisioning profile после изменения capability надо **перевыпустить и пересобрать** приложение
(см. `mobile-client/SECRETS-SETUP.md`).

### B4. Переменные сервера

       sudo install -m 600 -o agentiz -g agentiz ~/Downloads/AuthKey_ABC123DEFG.p8 \
         /etc/agentiz/AuthKey_ABC123DEFG.p8

`.env`:

       AGENTIZ_APNS_KEY=/etc/agentiz/AuthKey_ABC123DEFG.p8
       AGENTIZ_APNS_KEY_ID=ABC123DEFG
       AGENTIZ_APNS_TEAM_ID=5K5GDFV386
       AGENTIZ_APNS_BUNDLE_ID=cx.m42.agentoz
       AGENTIZ_APNS_ENV=production

Все четыре — **вместе**: при неполном наборе сервер пишет в лог
`APNs is half-configured; push to iOS stays off` и iOS-пуши остаются выключены, вместо того чтобы
падать на отправке. Как и с FCM, `AGENTIZ_APNS_KEY` принимает и путь, и сам PEM строкой.

**`AGENTIZ_APNS_ENV` — самая частая причина «токен есть, пуш не доходит».** Сборка из Xcode
(development-профиль) регистрируется в **sandbox**, сборка из TestFlight/App Store — в
**production**, и это разные серверы Apple с разными токенами. Токен из development-сборки,
отправленный на production-хост, получает `BadDeviceToken`. Для отладочных сборок:

       AGENTIZ_APNS_ENV=sandbox

---

## Часть B½. Установка настроек без правки `.env` — через MCP

Всё, что выше кладётся в `.env`, можно вместо этого установить на работающем сервере. Настройка
ляжет в таблицу `settings` app-manager (это его штатный механизм настроек, не отдельная таблица
пушей); рестарт не нужен — следующее уведомление уходит уже с новыми кредами.

Когда это нужно: `.env` за деплоем, а креды получены сейчас; или надо быстро переключить провайдера
и вернуть обратно.

**Переменная окружения приоритетнее.** Это правило app-manager (`SettingStorage.get` сначала
смотрит в `process.env`), и это же — главный подвох: если ключ есть в `.env`, то установленное
через MCP значение сохранится, но **не будет действовать**, пока переменную оттуда не уберут.
Молча это не происходит: и `agentiz.pushSettings`, и ответ самой установки помечают такую настройку
`shadowedByEnvironment: true` и кладут предупреждение в `warnings`.

Посмотреть, что настроено (значения секретов **не возвращаются никогда**, только «есть/нет»):

```bash
source .env
curl -s -H "X-Mcp-Key: $MCP_KEY" -H 'Content-Type: application/json' \
  -d '{}' https://agentiz.m42.cx/mcp/call/agentiz.pushSettings
```

В ответе для каждой настройки — `source`: `environment` (из `.env`, и оно в силе), `settings`
(установлена здесь) или `unset`. Плюс `pushEnabled` и `warnings` — конфигурации, которые сохранены,
но доставить ничего не смогут: выбран `gateway` без URL, заполнены не все четыре `AGENTIZ_APNS_*`,
значение перекрыто переменной окружения.

Установить (`settings` — объект; `null` в значении **удаляет** настройку, и она возвращается к
переменной окружения, а не к «выключено»):

```bash
# сервисный аккаунт Firebase — самим JSON или путём к файлу
curl -s -H "X-Mcp-Key: $MCP_KEY" -H 'Content-Type: application/json' \
  -d "{\"settings\":{\"AGENTIZ_FCM_SERVICE_ACCOUNT\":$(jq -Rs . < firebase-service-account.json)}}" \
  https://agentiz.m42.cx/mcp/call/agentiz.managePushSettings

# переключить на шлюз
curl -s -H "X-Mcp-Key: $MCP_KEY" -H 'Content-Type: application/json' \
  -d '{"settings":{"PUSH_PROVIDER":"gateway","PUSH_GATEWAY_URL":"http://push-gateway:3000","PUSH_GATEWAY_API_KEY":"push_sk_..."}}' \
  https://agentiz.m42.cx/mcp/call/agentiz.managePushSettings

# ключ APNs — содержимым .p8 или путём
curl -s -H "X-Mcp-Key: $MCP_KEY" -H 'Content-Type: application/json' \
  -d "{\"settings\":{\"AGENTIZ_APNS_KEY\":$(jq -Rs . < AuthKey_ABC123DEFG.p8),\"AGENTIZ_APNS_KEY_ID\":\"ABC123DEFG\",\"AGENTIZ_APNS_TEAM_ID\":\"5K5GDFV386\",\"AGENTIZ_APNS_BUNDLE_ID\":\"cx.m42.agentoz\",\"AGENTIZ_APNS_ENV\":\"production\"}}" \
  https://agentiz.m42.cx/mcp/call/agentiz.managePushSettings

# вернуться к тому, что написано в .env
curl -s -H "X-Mcp-Key: $MCP_KEY" -H 'Content-Type: application/json' \
  -d '{"settings":{"PUSH_PROVIDER":null}}' https://agentiz.m42.cx/mcp/call/agentiz.managePushSettings
```

Значения проверяются **до** записи: `PUSH_PROVIDER` только `firebase`/`gateway`, service account —
что это JSON с `project_id`/`client_email`/`private_key` (или существующий файл), URL — что это
http/https, Key ID и Team ID — что это 10-символьные идентификаторы Apple, `.p8` — что это PEM или
существующий файл. Если в одном вызове несколько настроек и хоть одна не прошла — **не применяется
ни одна**: наполовину применённая смена кредов хуже отклонённой.

**Прочитать записанный секрет нельзя ничем** — ни этим инструментом, ни через админку; потеряли,
устанавливайте заново. Одно предостережение: app-manager при сохранении настройки пишет в свой лог
строку `Setting saved in database: <ключ>: <значение>`, то есть сам секрет попадает в лог
приложения. Файлы логов надо считать настолько же чувствительными, насколько и креды.

## Часть C. Что где лежит в итоге

| Файл / переменная | Где | Что сломается без него |
| --- | --- | --- |
| `mobile-client/composeApp/google-services.json` | в дереве сборки Android | Android-приложение не получит FCM-токен |
| `AGENTIZ_FCM_SERVICE_ACCOUNT` | `.env` сервера | сервер не сможет отправить в FCM (Android молчит) |
| `AGENTIZ_APNS_KEY` + `_KEY_ID` + `_TEAM_ID` + `_BUNDLE_ID` | `.env` сервера | iOS-пуши выключены |
| `AGENTIZ_APNS_ENV` | `.env` сервера | пуши уходят «не на тот» APNs (см. B4) |
| `PUSH_PROVIDER` | `.env` сервера | по умолчанию `firebase` |

Ни один из этих файлов не коммитится. Полный список переменных с дефолтами —
`layers/app-agentiz-mobile-api/README.md`, шаблон — `.env.example`. Любая из переменных может быть
установлена и через настройки app-manager (часть B½) — но переменная окружения
имеет приоритет; что именно сейчас в силе, показывает `agentiz.pushSettings`.

---

## Часть D. Вариант без Firebase-ключей на сервере: push-gateway

Если Firebase-креды не должны лежать на этом сервере (несколько инсталляций, одна учётка Google),
их держит отдельный сервис `push-gateway`, а бэкенд знает только URL и API-ключ:

       PUSH_PROVIDER=gateway
       PUSH_GATEWAY_URL=http://push-gateway:3000
       PUSH_GATEWAY_API_KEY=push_sk_...

`AGENTIZ_FCM_SERVICE_ACCOUNT` в этом случае из `.env` убирается совсем — service account из части
A3 переезжает в конфиг шлюза (`FIREBASE_SERVICE_ACCOUNT`). Тело запроса к FCM при этом не меняется
ни на байт, так что переключение туда-обратно — это правка `.env` и рестарт, приложение
пересобирать не надо. iOS не затрагивается вообще: APNs-токены в шлюз не ходят.

Части A1–A2 (проект Firebase и `google-services.json`) нужны всё равно — без них Android-приложению
неоткуда взять токен.

---

## Часть E. Проверка, от старта сервера до уведомления на экране

1. **Сервер видит креды.** В логе при старте:

       [app-agentiz-mobile-api] push notifications enabled via firebase, apns

   `(unconfigured)` рядом с именем провайдера — переменные не доехали. Проверить, что процесс
   перезапущен и читает тот `.env`, который правили.

2. **Приложение получило токен и отдало его.** Войти в приложение, разрешить уведомления. Запрос
   `POST /api/agentiz/mobile/v1/devices` должен ответить `pushEnabled: true`:

       curl -s -X POST https://agentiz.m42.cx/api/agentiz/mobile/v1/devices \
         -H "Authorization: Bearer <токен из /auth/login>" -H 'Content-Type: application/json' \
         -d '{"token":"<push-токен>","platform":"android"}'

   `pushEnabled: false` — сервер не настроен (шаг 1); токен при этом всё равно сохраняется.

3. **У проекта есть владелец.** Уведомление адресуется `AgentProject.ownerId`. Проект без
   владельца не уведомляет никого — это не ошибка, а правило видимости.

4. **Дождаться настоящего вопроса**: запустить задачу пайплайном, где стадия задаёт вопрос
   (`waiting_input`). Уведомление приходит в момент создания вопроса, один раз.

5. **Тап открывает вопрос.** В payload лежит `data.type = "interaction"` и `interactionId` —
   именно по ним приложение строит переход.

Если уведомление не пришло, а вопрос в приложении виден — ищите в логе сервера строку вида
`push to android device failed: <reason>` и смотрите таблицу ниже.

---

## Что означают ошибки доставки

Сервер сводит ответы обоих сервисов к четырём причинам:

| reason | Что произошло | Что делать |
| --- | --- | --- |
| `invalid-token` | FCM `UNREGISTERED` / APNs `BadDeviceToken`, `Unregistered`, `DeviceTokenNotForTopic` | ничего: строка устройства удаляется сама, приложение зарегистрирует новый токен. Если это повторяется у всех iOS — почти наверняка `AGENTIZ_APNS_ENV` (см. B4) |
| `rate-limited` | 429 от FCM/APNs | ничего; следующий вопрос уведомит снова, повторов сервер не делает намеренно |
| `temporary-error` | 5xx или таймаут | то же самое; если постоянно — сеть/недоступен шлюз |
| `unknown` | 401/403 (плохие креды), 400 (кривое сообщение) | это конфигурация: неверный service account, отозванный `.p8`, не тот Team ID |

Повторных попыток нет **осознанно**: отправка происходит внутри запроса воркера
`requestHumanInput`, и ждать снятия лимита значило бы тормозить агента ради уведомления.

Частные случаи, которые стоит знать заранее:

- **Android 13+**: без разрешения `POST_NOTIFICATIONS` токен не запрашивается вовсе. Отказ —
  нормальный ответ, приложение продолжает работать без уведомлений.
- **Android**: `channelId` в payload (`agentiz-interactions`) должен существовать в приложении,
  иначе на Android 8+ уведомление тихо отбрасывается. Канал создаётся при старте активности.
- **FCM 404 `SENDER_ID_MISMATCH`**: `google-services.json` из одного проекта Firebase, а service
  account — из другого.
- **Симулятор iOS** пушей не получает (кроме локальных); нужен физический телефон.

---

## Если ничего не настроено

Ничего не ломается и ничего не теряется. Вопрос агента — это строка в базе
(`AgentRunInteraction`), пуш лишь объявляет уже сохранённую запись и нигде не хранится. Без кредов
провайдеры сообщают о себе «выключены», `/devices` продолжает принимать токены (включить пуши
позже можно без нового релиза приложения), а вопрос всё равно виден:

- в приложении на экране «Ожидающие ответы» (он опрашивает список сам);
- в дашборде на `/dashboard/agentiz-interactions`;
- в колокольчике админки — если включены уведомления Adminizer (`ADMINIZER_NOTIFICATIONS`,
  по умолчанию включены) и пользователю выдано право `notification-agentiz`. Этот канал не требует
  ни Firebase, ни Apple вообще.

Что действительно ограничено по времени — сам вопрос: `expiresAt`, по умолчанию 24 часа, после
чего run отменяется с причиной `Human input request expired`. Пуш не влияет на этот срок, он лишь
повышает шанс успеть.

---

## Если позже переводить iOS на FCM

Сейчас это не нужно, но если появится причина (единый канал, статистика в консоли Firebase), то
меняется только сторона приложения плюс одна настройка Firebase:

1. Firebase → Project settings → **Cloud Messaging** → APNs Authentication Key → загрузить тот же
   `.p8` с Key ID и Team ID.
2. Добавить в Firebase iOS-приложение, скачать `GoogleService-Info.plist`, подключить Firebase SDK
   в iOS-сборку.
3. Приложение регистрирует **FCM-токен** и шлёт его с `"transport":"fcm"` на `/devices`.

Серверную часть менять не придётся: блок `apns` уже едет внутри того же сообщения, и FCM применит
его сам. Переменные `AGENTIZ_APNS_*` после этого можно убрать.
