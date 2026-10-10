import 'reflect-metadata';
import path from 'node:path';
import type { Request } from 'express';
import { AppInertiajs, type InertiaPageProps } from '@nodeknit/app-inertiajs';
import { docLinks, loadDocs } from './lib/docs';

/**
 * The public project site: a landing page at `/` and the user documentation under `/docs`.
 *
 * Same shape as restoapp-marketplace's storefront: React pages rendered on the server by
 * `@nodeknit/app-inertiajs` and hydrated in the browser, bundled by Vite from `web/`. It reads
 * nothing from the database and depends on no other layer — the documentation is markdown in
 * `content/docs/`, turned into HTML here (`lib/docs.ts`) and handed to the page as a prop.
 *
 * Production serves `web/dist` (built by `npm run build:site`, gitignored, built inside the
 * image); with `VITE_ENV=dev` the root `index.ts` attaches a Vite dev server instead.
 */

const webRoot = path.resolve(import.meta.dirname, 'web');

const SITE = 'Agentiz';

function docsProps(req: Request): InertiaPageProps {
  const slug = typeof req.params.slug === 'string' ? req.params.slug : 'index';
  const page = loadDocs().find((doc) => doc.slug === slug);
  return {
    nav: docLinks(),
    page: page
      ? { slug: page.slug, title: page.title, description: page.description, html: page.html }
      : null,
    slug,
  };
}

function docsTitle(props: InertiaPageProps): string {
  const page = props.page as { title?: string; slug?: string } | null;
  if (!page) {
    return `Page not found — ${SITE} docs`;
  }
  return page.slug === 'index' ? `${SITE} docs` : `${page.title} — ${SITE} docs`;
}

export default class AppAgentizSite extends AppInertiajs {
  appId = 'app-agentiz-site';
  name = 'Agentiz Site';
  htmlLang = 'en';

  inertiaVite = {
    rootDir: webRoot,
    configFile: path.join(webRoot, 'vite.config.ts'),
    clientEntry: 'src/app.tsx',
    devClientEntry: '/src/app.tsx',
    ssrEntry: '/src/ssr.tsx',
    clientBuildDir: path.join(webRoot, 'dist/client'),
    ssrBuildPath: path.join(webRoot, 'dist/server/ssr.js'),
    // Not `/assets`: adminizer and the panel modules already live under several asset paths, and
    // a shared prefix would make it a question of mount order which one answers.
    assetsUrlPrefix: '/site-assets',
    version: '1',
  };

  inertiaPages = [
    {
      route: '/',
      component: 'Home',
      title: `${SITE} — coding agents on your own machines`,
      props: () => ({ docs: docLinks() }),
    },
    {
      route: '/docs',
      component: 'Docs',
      title: docsTitle,
      props: (req: Request) => docsProps(req),
    },
    {
      route: '/docs/:slug',
      component: 'Docs',
      title: docsTitle,
      props: (req: Request) => docsProps(req),
    },
  ];
}

