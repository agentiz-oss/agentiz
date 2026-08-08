/**
 * Project secrets never leave the server in clear text: list responses replace them with
 * SECRET_MASK, and an update that sends the mask back means "keep the stored value".
 * The UI receives a mask and can retain an existing secret without seeing it.
 */
export const SECRET_MASK = '********';

const SECRET_KEYS = ['token'] as const;

export function maskProjectForUI(project: any): any {
  const raw = typeof project?.toJSON === 'function' ? project.toJSON() : project;
  const copy = JSON.parse(JSON.stringify(raw ?? {}));
  if (copy.secrets && typeof copy.secrets === 'object') {
    for (const key of SECRET_KEYS) {
      if (typeof copy.secrets[key] === 'string' && copy.secrets[key].length > 0) {
        copy.secrets[key] = SECRET_MASK;
      }
    }
  }
  return copy;
}

/**
 * Worker rows carry the hash of a personal token. The hash is not a secret an admin needs, and
 * exposing it turns a read-only UI leak into an offline attack surface, so it never leaves the
 * server — the visible prefix is enough to identify a token.
 */
export function maskWorkerForUI(worker: any): any {
  const raw = typeof worker?.toJSON === 'function' ? worker.toJSON() : worker;
  const copy = JSON.parse(JSON.stringify(raw ?? {}));
  delete copy.tokenHash;
  return copy;
}

/**
 * A git connection holds the OAuth token pair. It is never shown, not even masked per key: the UI
 * only needs to know whether the connection has credentials at all, which `hasSecrets` says.
 */
export function maskConnectionForUI(connection: any): any {
  if (!connection) return null;
  const raw = typeof connection?.toJSON === 'function' ? connection.toJSON() : connection;
  const copy = JSON.parse(JSON.stringify(raw ?? {}));
  copy.hasSecrets = Boolean(copy.secrets?.accessToken);
  delete copy.secrets;
  return copy;
}

export function restoreMaskedSecrets(newSecrets: any, oldSecrets: any): any {
  const merged = JSON.parse(JSON.stringify(newSecrets ?? {}));
  for (const key of SECRET_KEYS) {
    if (merged[key] === SECRET_MASK) {
      const previous = oldSecrets?.[key];
      merged[key] = typeof previous === 'string' && previous.length > 0 ? previous : '';
    }
  }
  return merged;
}

/**
 * A task source's secret keys are not fixed — they come from the adapter's `configFields`, so any
 * string value in `secrets` is masked wholesale rather than by an allowlist of known names.
 */
export function maskTaskSourceForUI(source: any): any {
  const raw = typeof source?.toJSON === 'function' ? source.toJSON() : source;
  const copy = JSON.parse(JSON.stringify(raw ?? {}));
  if (copy.secrets && typeof copy.secrets === 'object') {
    for (const key of Object.keys(copy.secrets)) {
      if (typeof copy.secrets[key] === 'string' && copy.secrets[key].length > 0) {
        copy.secrets[key] = SECRET_MASK;
      }
    }
  }
  return copy;
}

/** Same "mask means keep" contract as restoreMaskedSecrets, over an open-ended key set. */
export function restoreMaskedTaskSourceSecrets(newSecrets: any, oldSecrets: any): Record<string, unknown> {
  const merged = JSON.parse(JSON.stringify(newSecrets ?? {}));
  for (const key of Object.keys(merged)) {
    if (merged[key] === SECRET_MASK) {
      const previous = oldSecrets?.[key];
      if (typeof previous === 'string' && previous.length > 0) {
        merged[key] = previous;
      } else {
        delete merged[key];
      }
    }
  }
  // Keys the form did not send at all must survive too.
  for (const [key, value] of Object.entries(oldSecrets ?? {})) {
    if (!(key in merged)) merged[key] = value;
  }
  return merged;
}
