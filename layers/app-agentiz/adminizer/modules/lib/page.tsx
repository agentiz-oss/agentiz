import * as React from 'react';
import { Separator } from '@/components/ui/separator';
import { cn } from './ui';

/**
 * Three width modes instead of one — the UI review named the single fixed width as its own
 * problem. Settings read badly across a wide column, lists badly inside a narrow one, and a log or
 * a diff wants the whole viewport.
 */
const WIDTH = {
  narrow: 'max-w-3xl',
  default: 'max-w-6xl',
  wide: 'max-w-none',
} as const;

export function Page({
  children,
  width = 'default',
  className,
}: {
  children: React.ReactNode;
  width?: keyof typeof WIDTH;
  className?: string;
}) {
  return <div className={cn('mx-auto w-full px-6 py-5', WIDTH[width], className)}>{children}</div>;
}

export function PageHeader({
  title,
  meta,
  description,
  actions,
  tabs,
  className,
}: {
  title: React.ReactNode;
  meta?: React.ReactNode | React.ReactNode[];
  description?: React.ReactNode;
  actions?: React.ReactNode;
  tabs?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('mb-5', className)}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="flex flex-wrap items-center gap-2 text-xl font-semibold tracking-tight">{title}</h1>
          {meta && (
            <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
              {(Array.isArray(meta) ? meta : [meta]).filter(Boolean).map((entry, index) => (
                <React.Fragment key={index}>
                  {index > 0 && <span aria-hidden className="text-muted-foreground/50">·</span>}
                  {entry}
                </React.Fragment>
              ))}
            </div>
          )}
          {description && <p className="mt-2 max-w-3xl text-sm text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      {tabs ? <div className="mt-4">{tabs}</div> : <Separator className="mt-4" />}
    </div>
  );
}

/**
 * A titled block: a heading, an explanation and the controls. Deliberately not a `Card` — a
 * settings page is a sequence of subjects, and a page of cards reads as a dashboard, which is what
 * the overview is for.
 *
 * `variant` is the one difference between the places that use it, and it is a real one: a screen
 * whose sections are *the* content (a machine's card, an account's settings) separates them with
 * a rule, while a screen where they sit among other blocks — a settings section, a tab of the
 * pipeline editor — only needs the spacing. Three screens had grown their own copy of this, which
 * is how «Раздел» starts meaning three slightly different amounts of margin.
 */
export function Section({
  title,
  description,
  footer,
  children,
  className,
  variant = 'plain',
}: {
  title: string;
  description?: React.ReactNode;
  footer?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  variant?: 'plain' | 'divided';
}) {
  const divided = variant === 'divided';
  return (
    <section className={cn(divided ? 'border-b py-6 first:pt-0 last:border-b-0' : 'space-y-3', className)}>
      <div>
        <h2 className="text-sm font-semibold">{title}</h2>
        {description && <p className="mt-0.5 max-w-3xl text-sm text-muted-foreground">{description}</p>}
      </div>
      {/* Plain keeps the children as siblings of the heading: the section's own `space-y-3` is
          what separates them, and a wrapper would collapse that to nothing. */}
      {divided ? <div className="mt-4 space-y-3">{children}</div> : children}
      {footer && <div className="flex flex-wrap items-center gap-2">{footer}</div>}
    </section>
  );
}

/**
 * The facts of one entity: a label/value grid, not a table and not prose. What belongs here is
 * what a person quotes when they ask somebody else about the thing — a branch, a worker, a model.
 * The agent's own text never does: it is paragraphs, and it goes below in full.
 */
export function Facts({ items }: { items: Array<[string, React.ReactNode] | null> }) {
  const rows = items.filter(Boolean) as Array<[string, React.ReactNode]>;
  return (
    <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
      {rows.map(([label, value]) => (
        <div key={label} className="min-w-0">
          <dt className="text-xs text-muted-foreground">{label}</dt>
          <dd className="mt-0.5 truncate text-sm">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed px-6 py-14 text-center">
      <p className="text-sm font-medium">{title}</p>
      {description && <p className="mt-1 max-w-md text-sm text-muted-foreground">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
