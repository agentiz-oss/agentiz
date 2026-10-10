import { createInertiaApp } from '@inertiajs/react';
import { renderToString } from 'react-dom/server';
import './index.css';

/** Called by app-inertiajs for every request; returns the page markup and Inertia's <Head> tags. */
export async function renderPage(page: {
  component: string;
  props: Record<string, unknown>;
  url: string;
  version: string;
}): Promise<{ html: string; head: string[] }> {
  const result = (await createInertiaApp({
    // app-inertiajs hands over a bare {component, props, url, version}; Inertia's types want a
    // full Page with scroll regions and remembered state.
    page: page as never,
    render: renderToString,
    resolve: (name) => {
      const pages = import.meta.glob('./pages/*.tsx', { eager: true });
      const mod = pages[`./pages/${name}.tsx`] as { default: unknown } | undefined;
      if (!mod) {
        throw new Error(`Page not found: ${name}`);
      }
      return mod;
    },
    setup: ({ App, props }) => <App {...props} />,
  })) as unknown as { head: string[]; body: string };

  return { html: result.body, head: result.head };
}
