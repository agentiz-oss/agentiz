import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import MarkdownIt from 'markdown-it';

/**
 * The site's documentation is a directory of markdown files, one page each:
 *
 *   ---
 *   title: Workers
 *   order: 50
 *   description: One line for the docs index and <meta name="description">.
 *   ---
 *
 * The slug is the file name; `index.md` is `/docs`. Pages are rendered on the server and reach
 * the browser as finished HTML — the page component only places it. Raw HTML inside the markdown
 * is off (`html: false`): these files are edited through pull requests, and a page has no reason
 * to carry markup the stylesheet does not know.
 */

const CONTENT_DIR = path.resolve(import.meta.dirname, '../content/docs');

export type DocLink = { slug: string; title: string; description: string };
export type DocPage = DocLink & { html: string; order: number };

const md = new MarkdownIt({ html: false, linkify: true, typographer: true });

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`*_~]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// h2/h3 get an id, so a section can be linked to (`/docs/workers#push-rights`). An explicit
// `{#id}` at the end of the heading wins over the generated one and is cut from the text.
md.core.ruler.push('heading_ids', (state) => {
  const tokens = state.tokens;
  for (let i = 0; i < tokens.length; i++) {
    const open = tokens[i];
    if (open.type !== 'heading_open' || (open.tag !== 'h2' && open.tag !== 'h3')) {
      continue;
    }
    const inline = tokens[i + 1];
    const explicit = /\s*\{#([a-z0-9-]+)\}\s*$/.exec(inline.content);
    let id = slugify(inline.content);
    if (explicit) {
      id = explicit[1];
      inline.content = inline.content.slice(0, explicit.index);
      const last = inline.children?.[inline.children.length - 1];
      if (last?.type === 'text') {
        last.content = last.content.replace(/\s*\{#[a-z0-9-]+\}\s*$/, '');
      }
    }
    open.attrSet('id', id);
  }
});

function parse(file: string): DocPage {
  const raw = fs.readFileSync(path.join(CONTENT_DIR, file), 'utf8');
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  const meta = (match ? yaml.load(match[1]) : {}) as Record<string, unknown>;
  const body = match ? raw.slice(match[0].length) : raw;
  const slug = file.replace(/\.md$/, '');
  return {
    slug,
    title: typeof meta.title === 'string' ? meta.title : slug,
    description: typeof meta.description === 'string' ? meta.description : '',
    order: typeof meta.order === 'number' ? meta.order : 1000,
    html: md.render(body),
  };
}

let cache: DocPage[] | null = null;

/**
 * Read once in production; re-read on every request otherwise, so editing a page needs no
 * restart (tsx watch does not see `.md` files).
 */
export function loadDocs(): DocPage[] {
  if (cache) {
    return cache;
  }
  const pages = fs
    .readdirSync(CONTENT_DIR)
    .filter((file) => file.endsWith('.md'))
    .map(parse)
    .sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
  if (process.env.NODE_ENV === 'production') {
    cache = pages;
  }
  return pages;
}

export function docLinks(): DocLink[] {
  return loadDocs().map(({ slug, title, description }) => ({ slug, title, description }));
}

