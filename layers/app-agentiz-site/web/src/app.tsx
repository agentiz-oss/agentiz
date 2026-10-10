import { createInertiaApp } from '@inertiajs/react';
import { hydrateRoot } from 'react-dom/client';
import './index.css';

createInertiaApp({
  resolve: async (name) => {
    const pages = import.meta.glob('./pages/*.tsx');
    const page = pages[`./pages/${name}.tsx`];
    if (!page) {
      throw new Error(`Page not found: ${name}`);
    }
    return (await page()) as { default: unknown };
  },
  setup: ({ el, App, props }) => {
    hydrateRoot(el, <App {...props} />);
  },
});
