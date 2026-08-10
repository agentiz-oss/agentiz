import { randomBytes } from 'crypto';

const CYRILLIC: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f',
  х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};
const STOP_WORDS = new Set(['a', 'an', 'the', 'and', 'or', 'for', 'to', 'of', 'in', 'on', 'и', 'в', 'на', 'для', 'с']);

function transliterate(value: string): string {
  return [...value.toLowerCase()].map((char) => CYRILLIC[char] ?? char).join('');
}

function cleanPrefix(prefix: string | undefined): string {
  const value = transliterate(prefix ?? 'agentiz/').replace(/[^a-z0-9/_-]+/g, '-').replace(/-+/g, '-').replace(/^[-/]+|[-/]+$/g, '');
  return value ? `${value}/` : '';
}

export function generateWorkspaceBranch(title: string, prefix?: string, suffix = randomBytes(2).toString('hex')): string {
  const words = transliterate(title).split(/[^a-z0-9]+/).filter((word) => word && !STOP_WORDS.has(word)).slice(0, 3);
  if (!words.length) words.push('change');
  words[words.length - 1] = `${words[words.length - 1].slice(0, 32)}${suffix.toLowerCase().replace(/[^a-f0-9]/g, '').slice(0, 4)}`;
  const branch = `${cleanPrefix(prefix)}${words.join('-')}`;
  assertWorkspaceBranch(branch, prefix);
  return branch;
}

export function assertWorkspaceBranch(branch: string, configuredPrefix?: string): void {
  const value = branch.trim();
  if (!value || value.length > 120 || value.startsWith('/') || value.endsWith('/') || value.endsWith('.')
    || value.includes('..') || value.includes('@{') || /[~^:?*[\\\s]/.test(value)) {
    throw new Error(`Invalid Git branch name "${branch}"`);
  }
  const prefix = cleanPrefix(configuredPrefix);
  const semantic = prefix && value.startsWith(prefix) ? value.slice(prefix.length) : value.split('/').at(-1)!;
  const words = semantic.split('-').filter(Boolean);
  if (words.length < 1 || words.length > 3 || words.some((word) => !/^[a-z0-9]+$/.test(word))) {
    throw new Error('Workspace branch must contain 1–3 lowercase slug words after its prefix');
  }
}
