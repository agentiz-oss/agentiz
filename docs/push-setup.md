# Настройка push-уведомлений: от пустого аккаунта до пришедшего уведомления

Что настраивается: сервер узнаёт, что агент задал вопрос, и присылает уведомление на телефон
владельца проекта; тап по уведомлению открывает экран этого вопроса.

Дорога одна, обе платформы идут через FCM:

```
Android ──FCM-токен──▶ сервер ──▶ FCM (Google) ──▶ телефон
iOS     ──FCM-токен──▶ сервер ──▶ FCM (Google) ──▶ APNs (Apple) ──▶ телефон
```

С Apple разговаривает Google: приложение на обеих платформах регистрирует FCM-токен, а `.p8`
загружается в консоль Firebase. Прямой путь в APNs со стороны сервера был и удалён — вместе с ним
исчезла необходимость знать, из какой сборки (sandbox или production) пришёл токен.

Поэтому Firebase нужен для обеих платформ, а ключ Apple — для iOS, но не серверу. Ничего из этого не
обязательно: без настроек пуши просто не отправляются, вопрос всё равно виден в приложении и в
дашборде (см. «Если ничего не настроено»).

Всё, что ниже, — одноразовые действия. Часть A нужна всегда, часть B — если нужен iOS.

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

## Часть B. iOS: ключ APNs — в Firebase, не на сервер

iOS ходит через FCM, как и Android: приложение регистрирует **FCM-токен**, а с Apple разговаривает
Google. Поэтому ключ `.p8` загружается в консоль Firebase, а на сервере Agentiz никаких
`AGENTIZ_APNS_*` больше нет — их удалили вместе с прямым APNs-провайдером.

Смысл этого выбора один: окружение APNs (sandbox против production) определяет Google по самой
регистрации. Сборка из Xcode и сборка из TestFlight работают одновременно, и подгонять под них
настройку сервера не нужно — раньше это была самая частая причина «токен есть, пуш не доходит».

### B1. Ключ APNs (`.p8`)

1. https://developer.apple.com/account → **Certificates, Identifiers & Profiles → Keys → +**.
2. Имя любое (`Agentiz APNs`), галка **Apple Push Notifications service (APNs)** → Continue → Register.
3. **Download** — файл `AuthKey_XXXXXXXXXX.p8`. **Скачать можно один раз**; потерян — заводится новый.
4. `XXXXXXXXXX` в имени файла — это **Key ID**.

Один ключ работает на все приложения команды и на оба окружения (лимит: два ключа APNs на аккаунт).

### B2. Загрузка ключа в Firebase

Firebase → Project settings → **Cloud Messaging** → APNs Authentication Key → **Upload**: сам `.p8`,
Key ID и Team ID (developer.apple.com → Membership details, например `5K5GDFV386`).

### B3. iOS-приложение в Firebase

**Add app → iOS**, bundle id — точно `cx.m42.agentoz` (значение `BUNDLE_ID` в
`mobile-client/iosApp/Configuration/Config.xcconfig`). Скачать `GoogleService-Info.plist` и положить
в `mobile-client/iosApp/iosApp/`. Файл в `.gitignore`: это конфиг инсталляции, не артефакт репозитория.

Без него приложение не запустится вовсе — `FirebaseApp.configure()` падает, если plist отсутствует.

### B4. SDK в Xcode-проекте

В Xcode: **File → Add Package Dependencies** → `https://github.com/firebase/firebase-ios-sdk` →
подключить к таргету продукт **FirebaseMessaging**. `iosApp/iosApp/iOSApp.swift` импортирует его
безусловно, так что до этого шага iOS-сборка не компилируется.

### B5. Capability у App ID

**Identifiers** → нужный App ID → включить **Push Notifications** → Save. Без неё устройство не
получит APNs-токен, который Firebase обменивает на свой. После смены capability provisioning profile
надо **перевыпустить и пересобрать** приложение (см. `mobile-client/SECRETS-SETUP.md`).

### B6. Что настраивается на сервере

Ничего отдельного для iOS. Работает тот же service account Firebase, что и для Android
(`AGENTIZ_FCM_SERVICE_ACCOUNT`), — блок `apns` едет внутри общего сообщения, и FCM применяет его сам.

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
но доставить ничего не смогут: выбран `gateway` без URL, выбран `firebase` без service account,
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

# вернуться к тому, что написано в .env
curl -s -H "X-Mcp-Key: $MCP_KEY" -H 'Content-Type: application/json' \
  -d '{"settings":{"PUSH_PROVIDER":null}}' https://agentiz.m42.cx/mcp/call/agentiz.managePushSettings
```

Значения проверяются **до** записи: `PUSH_PROVIDER` только `firebase`/`gateway`, service account —
что это JSON с `project_id`/`client_email`/`private_key` (или существующий файл), URL — что это
http/https, таймаут — что это число в разумных пределах. Если в одном вызове несколько настроек и
хоть одна не прошла — **не применяется ни одна**: наполовину применённая смена кредов хуже
отклонённой.

**Прочитать записанный секрет нельзя ничем** — ни этим инструментом, ни через админку; потеряли,
устанавливайте заново. app-manager при сохранении пишет в лог строку
`Setting saved in database: <ключ>: <значение>`, но значения секретных ключей в ней замаскированы —
`layers/app-agentiz-mobile-api/lib/push/redactSettingLog.ts` подменяет их на `••••••••` до того, как
строка дойдёт до транспорта.

## Часть C. Что где лежит в итоге

| Файл / переменная | Где | Что сломается без него |
| --- | --- | --- |
| `mobile-client/composeApp/google-services.json` | в дереве сборки Android | Android-приложение не получит FCM-токен |
| `mobile-client/iosApp/iosApp/GoogleService-Info.plist` | в дереве сборки iOS | iOS-приложение падает на старте (`FirebaseApp.configure()`) |
| `.p8` в консоли Firebase | Firebase → Cloud Messaging | FCM не сможет доставить в APNs, iOS молчит |
| `AGENTIZ_FCM_SERVICE_ACCOUNT` | `.env` сервера | сервер не сможет отправить в FCM — молчат обе платформы |
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
пересобирать не надо. iOS идёт тем же путём — её токены такие же FCM-токены.

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
| `invalid-token` | FCM `UNREGISTERED`, `INVALID_ARGUMENT` | ничего: строка устройства удаляется сама, приложение зарегистрирует новый токен |
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

## Что осталось от прямого APNs

Ничего. `ApnsPushProvider`, настройки `AGENTIZ_APNS_*`, учёт окружения токена и колонка
`MobileDevice.transport` удалены — последняя миграцией `drop_device_transport`: при одном способе
доставки колонка не различала бы ничего.

`POST /devices` по-прежнему принимает поле `transport` в теле и молча его игнорирует: у старой сборки
токен всё равно окажется FCM-токеном, и отказывать ей не за что.
