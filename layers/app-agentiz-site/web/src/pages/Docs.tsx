import { Head } from '@inertiajs/react';
import { Layout } from '../components/Layout';

type DocLink = { slug: string; title: string; description: string };
type DocPage = DocLink & { html: string };

const href = (slug: string) => (slug === 'index' ? '/docs' : `/docs/${slug}`);

/**
 * One documentation page. The HTML comes from the server, rendered from
 * `layers/app-agentiz-site/content/docs/<slug>.md` with raw HTML disabled — see `lib/docs.ts`.
 */
export default function Docs(props: { nav: DocLink[]; page: DocPage | null; slug: string }) {
  const { nav, page } = props;
  const index = page ? nav.findIndex((doc) => doc.slug === page.slug) : -1;
  const prev = index > 0 ? nav[index - 1] : null;
  const next = index >= 0 && index + 1 < nav.length ? nav[index + 1] : null;

  return (
    <Layout
      section="docs"
      description={page?.description || 'Agentiz documentation.'}
      editPath={page ? `layers/app-agentiz-site/content/docs/${page.slug}.md` : undefined}
    >
      {page ? null : (
        <Head>
          <meta name="robots" content="noindex" />
        </Head>
      )}
      <main className="wrap docs">
        <aside>
          <ul>
            {nav.map((doc) => (
              <li key={doc.slug}>
                <a href={href(doc.slug)} aria-current={doc.slug === page?.slug ? 'page' : undefined}>
                  {doc.slug === 'index' ? 'Overview' : doc.title}
                </a>
              </li>
            ))}
          </ul>
        </aside>

        <article className="doc">
          {page ? (
            <>
              <h1>{page.title}</h1>
              {page.description ? <p className="lead">{page.description}</p> : null}
              <div dangerouslySetInnerHTML={{ __html: page.html }} />
              <nav className="pager">
                {prev ? <a href={href(prev.slug)}>← {prev.slug === 'index' ? 'Overview' : prev.title}</a> : <span />}
                {next ? <a href={href(next.slug)}>{next.title} →</a> : <span />}
              </nav>
            </>
          ) : (
            <>
              <h1>Page not found</h1>
              <p className="lead">
                There is no documentation page called “{props.slug}”. Pick one from the list, or
                start at the <a href="/docs">overview</a>.
              </p>
            </>
          )}
        </article>
      </main>
    </Layout>
  );
}
