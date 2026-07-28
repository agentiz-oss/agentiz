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
