/**
 * Same contract as app-agentiz/lib/secrets: tokens never leave the server, the UI receives
 * SECRET_MASK, and sending the mask back means "keep the stored value".
 */
export const SECRET_MASK = '********';

export function maskSecrets(secrets: object | null | undefined): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...(secrets ?? {}) };
  for (const [key, value] of Object.entries(copy)) {
    if (typeof value === 'string' && value.length > 0) copy[key] = SECRET_MASK;
  }
  return copy;
}

export function restoreMaskedSecrets(
  next: object | null | undefined,
  previous: object | null | undefined,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...(next ?? {}) };
  const stored = (previous ?? {}) as Record<string, unknown>;
  for (const [key, value] of Object.entries(merged)) {
    if (value === SECRET_MASK) {
      merged[key] = typeof stored[key] === 'string' ? stored[key] : '';
    }
  }
  return merged;
}

/** Model -> plain JSON with every secret field masked. */
export function maskModelForUI(instance: { toJSON?: () => unknown } | null, secretFields = ['secrets']): any {
  if (!instance) return null;
  const raw = typeof instance.toJSON === 'function' ? instance.toJSON() : instance;
  const copy: any = JSON.parse(JSON.stringify(raw ?? {}));
  for (const field of secretFields) {
    if (copy[field] && typeof copy[field] === 'object') {
      copy[field] = maskSecrets(copy[field]);
    }
  }
  return copy;
}
