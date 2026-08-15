import { AppManager } from '@nodeknit/app-manager';
import { isSecretPushSetting } from './settings';

/**
 * Keeps a stored credential out of the application log.
 *
 * app-manager writes `Setting saved in database: <key>: <value>` from `Setting.beforeSaveHook` —
 * every setting, at info level, value included. That is fine for `PUSH_PROVIDER` and fatal for a
 * Firebase service account or an APNs `.p8`: installing one over MCP would copy a private key into
 * `logs/app.log` and the container's stdout, where nothing masks it afterwards and log shipping may
 * already have carried it elsewhere.
 *
 * The hook lives in the package, so the value is masked one step later instead: this prepends a
 * transform to the winston logger's format, which every transport runs through. Only the settings
 * this layer declares secret (`isSecretPushSetting`) are touched, and only in that one message
 * shape — anything else reaches the log unchanged.
 *
 * **Which logger** is the whole difficulty. `AppManager.logger` is static, and under tsx the package
 * is instantiated twice (ESM + CJS graphs) — the copy this file imports is demonstrably not always
 * the copy `Setting` logs through, and wrapping the wrong one fails silently, which is the worst
 * possible outcome for this particular guard. So the running `AppManager` instance is passed in from
 * `mount()` and its own constructor's logger is wrapped as well: that one shares a module graph with
 * the models it registered. Both are wrapped, de-duplicated by identity, and each logger carries its
 * own marker so a second call cannot nest the transform.
 */

/** Set on a logger once its format is wrapped — per object, so several package copies each get one. */
const WRAPPED = Symbol.for('agentiz.push.settingLogRedaction');

/** The message `Setting.beforeSaveHook` builds. The value runs to the end — a `.p8` has newlines. */
const SAVED_SETTING = /^(Setting saved in database: )([A-Za-z0-9_]+): ([\s\S]*)$/;

/** What the value is replaced with. Same mask `describe()` uses, so the two read as one rule. */
const MASK = '••••••••';

interface WinstonInfo {
  message?: unknown;
  [key: string]: unknown;
}

interface WinstonFormat {
  transform(info: WinstonInfo, opts?: unknown): WinstonInfo | boolean;
}

interface LoggerLike {
  format?: WinstonFormat;
  [key: symbol]: unknown;
}

/** Masks the value of a secret push setting; returns the message unchanged in every other case. */
export function redactSettingMessage(message: string): string {
  const match = SAVED_SETTING.exec(message);
  if (!match) return message;
  const [, prefix, key] = match;
  return isSecretPushSetting(key) ? `${prefix}${key}: ${MASK}` : message;
}

/** Wraps one logger's format. Returns false when the object is not a logger shape we can wrap. */
function wrapLogger(logger: LoggerLike | undefined): boolean {
  if (!logger) return false;
  if (logger[WRAPPED]) return true;
  const original = logger.format;
  if (!original || typeof original.transform !== 'function') return false;

  logger.format = {
    transform(info: WinstonInfo, opts?: unknown) {
      if (typeof info.message === 'string') info.message = redactSettingMessage(info.message);
      return original.transform(info, opts);
    },
  };
  logger[WRAPPED] = true;
  return true;
}

/**
 * Masks secret values in every `AppManager` logger this process can reach: the copy imported here
 * and the one belonging to the running instance's own class. Idempotent, and called from `mount()`
 * before a write is possible.
 */
export function installPushSettingLogRedaction(appManager?: object): void {
  const loggers = new Set<LoggerLike>();
  const collect = (candidate: unknown) => {
    const logger = (candidate as { logger?: LoggerLike } | undefined)?.logger;
    if (logger) loggers.add(logger);
  };
  collect(AppManager);
  if (appManager) collect(appManager.constructor);

  let wrapped = 0;
  for (const logger of loggers) if (wrapLogger(logger)) wrapped += 1;
  // Not fatal — but it must not pass for success either: an unwrapped logger means the next stored
  // credential is written to the log in full.
  if (wrapped === 0) {
    console.warn('[AppAgentizMobileApi] could not install push setting log redaction; a stored credential may be logged');
  }
}
