import React, { useEffect, useState } from "react";
import axios from "axios";

/**
 * "Documentation" button for a panel page, rendered only when the knowledge base actually has an
 * article about this page.
 *
 * The set of articles is asked for at mount instead of read from the Inertia props adminizer
 * shares (`docs`): the panel navigates client-side, so that object belongs to whatever page was
 * loaded first, while `/docs/api/context` always answers about the URL it was asked about. The
 * endpoint applies the same access rights as everything else in the subsystem, so an article the
 * viewer may not read never reaches this button — and a deployment with documentation disabled
 * (404) or a page nobody wrote about renders nothing at all.
 */
interface DocLink {
  id: string;
  title: string;
  section?: string;
}

const prefix = (): string => (window as any).routePrefix ?? "/dashboard";

export function DocsButton({ url, className }: { url?: string; className?: string }) {
  const [docs, setDocs] = useState<DocLink[]>([]);
  const [open, setOpen] = useState(false);
  const path = url ?? (typeof window !== "undefined" ? window.location.pathname : "");

  useEffect(() => {
    let cancelled = false;
    axios
      .get(`${prefix()}/docs/api/context`, { params: { url: path } })
      .then((response) => {
        const items = Array.isArray(response.data?.documents) ? response.data.documents : [];
        if (!cancelled) setDocs(items);
      })
      // No knowledge base, no rights, no article — all of them mean the same thing here.
      .catch(() => {
        if (!cancelled) setDocs([]);
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  if (docs.length === 0) return null;

  const href = (id: string) => `${prefix()}/docs/${encodeURIComponent(id)}`;
  const buttonClass = className ?? "rounded border px-3 py-1.5 text-sm font-medium";

  if (docs.length === 1) {
    return (
      <a href={href(docs[0].id)} className={buttonClass} title={docs[0].title}>
        Документация
      </a>
    );
  }

  return (
    <div className="relative">
      <button type="button" onClick={() => setOpen((value) => !value)} className={buttonClass}>
        Документация ({docs.length})
      </button>
      {open ? (
        <div className="absolute right-0 z-20 mt-1 w-64 rounded border bg-background p-1 shadow">
          {docs.map((item) => (
            <a
              key={item.id}
              href={href(item.id)}
              className="block rounded px-2 py-1 text-sm hover:bg-muted"
            >
              {item.title}
            </a>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export default DocsButton;
