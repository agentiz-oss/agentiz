import type { ReactNode } from 'react';
import { Head } from '@inertiajs/react';
import favicon from '../assets/favicon.svg';

export const GITHUB = 'https://github.com/agentiz-oss/agentiz';

type Section = 'home' | 'docs';

/**
 * Header and footer of every page.
 *
 * Links are plain `<a>`, never Inertia's `<Link>`: app-inertiajs renders full documents and does
 * not answer the Inertia XHR protocol, so a client-side visit would get HTML where it expects JSON.
 *
 * No `<title>` here — app-inertiajs only falls back to the per-route title from `index.ts` when
 * the rendered head has none, so a title in the layout would take over titling for every page.
 */
export function Layout(props: {
  section: Section;
  description: string;
  editPath?: string;
  children: ReactNode;
}) {
  return (
    <>
      <Head>
        <meta name="description" content={props.description} />
        <meta name="theme-color" content="#000000" />
        <link rel="icon" type="image/svg+xml" href={favicon} />
      </Head>

      <header className="top">
        <div className="wrap">
          <a className="logo" href="/">agentiz</a>
          <nav>
            <a href="/#screenshots">Screenshots</a>
            <a href="/docs" aria-current={props.section === 'docs' ? 'page' : undefined}>Docs</a>
            <a href={GITHUB}>GitHub</a>
          </nav>
        </div>
      </header>

      {props.children}

      <footer className="foot">
        <div className="wrap">
          <span>Agentiz — open source, self-hosted.</span>
          <span>
            {props.editPath ? <><a href={`${GITHUB}/edit/main/${props.editPath}`}>Edit this page</a> · </> : null}
            <a href="/docs">Docs</a> · <a href={GITHUB}>GitHub</a> · <a href={`${GITHUB}/issues`}>Issues</a>
          </span>
        </div>
      </footer>
    </>
  );
}
