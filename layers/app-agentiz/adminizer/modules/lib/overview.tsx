import * as React from 'react';
import { AlertTriangle, CircleDot, Clock, MessageSquare, Play, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { href } from '../../../lib/panel/routeTree';
import { ago, elapsed, plural } from './format';
import type { PanelInboxItem } from './inbox';
import { EmptyState, PageHeader } from './page';
import type { RunCard } from './runs';
import { StatusBadge } from './status';

/**
 * The two overview screens: «Обзор» over everything and the overview of one project.
 *
 * They are the last screens ported and they are made almost entirely of links — which is the
 * reason they went last: until the rest of the tree existed there was nowhere for those links to
 * point. Every address here therefore comes from `href()`, and every *number* comes from the
 * screen it links to rather than from a count of its own: «требует внимания» is the inbox's own
 * rows (`lib/inbox/`, the same ones the phone reads), «идёт сейчас» is the run board's own
 * builder, and the feed is `AgentActivity` with the wording from `activityTypes.ts`. An overview
 * that counted for itself would be a second opinion, and the first disagreement would cost the
 * reader their trust in both screens.
 *
 * Nothing polls here: what moves is the two lists, and each of them is one click from a screen
 * that does poll.
 */

export interface OverviewStats {
  openTasks: number;
  activeRuns: number;
  workersOnline: number;
  workersTotal: number;
  actionable: number;
  projects: number;
  activeProjects: number;
}

export interface OverviewActivityRow {
  id: string;
  type: string;
  badge: string | null;
  title: string;
  createdAt: string;
  projectSlug: string | null;
  projectName: string | null;
  href: string | null;
}

export interface PanelOverview {
  /** The two project facts the page prop does not carry; null on the global overview. */
  project: { description: string | null; isActive: boolean } | null;
  stats: OverviewStats;
  attention: PanelInboxItem[];
  running: RunCard[];
  activity: OverviewActivityRow[];
}

/** The stage an in-flight run is on, in the words the run board uses. */
function currentStage(run: RunCard): string {
  const running = run.stages.find((stage) => stage.status === 'running');
  const stage = running ?? run.stages.find((item) => item.stageIndex === run.currentStageIndex);
  return stage ? stage.role : '—';
}

/**
 * Значок строки — по её виду, а не один треугольник на всё.
 *
 * Виды приходят с сервера (`InboxItemKind` в `lib/inbox/items.ts`) и уже разделены по смыслу:
 * вопрос агента — это реплика, ревью и приёмка — решение, а упавший пуш и разлогиненная обвязка —
 * поломка. Иначе список из трёх разных ожиданий выглядит как три одинаковые аварии.
 */
function attentionIcon(kind: string) {
  if (kind === 'question') return MessageSquare;
  if (kind === 'push_failed' || kind === 'reset_failed' || kind === 'harness_auth' || kind === 'run_failed') return AlertTriangle;
  return CircleDot;
}

/** One row of «требует внимания». The wording is the server's — see `lib/inbox/items.ts`. */
function AttentionRow({ item, showProject }: { item: PanelInboxItem; showProject: boolean }) {
  const where = [
    showProject ? item.projectSlug ?? item.projectName : null,
    item.taskTitle,
  ].filter(Boolean).join(' · ');
  const Icon = attentionIcon(item.kind);

  return (
    <li className="flex items-start gap-3 py-2.5 first:pt-0 last:pb-0">
      <Icon className="mt-0.5 size-4 shrink-0 agentiz-attention" />
      <div className="min-w-0 flex-1">
        {item.href ? (
          <a href={item.href} className="text-sm font-medium hover:underline">{item.headline}</a>
        ) : (
          <span className="text-sm font-medium">{item.headline}</span>
        )}
        <p className="mt-0.5 truncate text-xs text-muted-foreground">
          {item.badge}
          {where ? ` · ${where}` : ''}
          {item.waitingSince ? ` · ${ago(item.waitingSince)}` : ''}
        </p>
      </div>
    </li>
  );
}

/** «Идёт сейчас» — the same columns as a row of the run board, minus the ones a glance ignores. */
function RunningList({ runs, showProject }: { runs: RunCard[]; showProject: boolean }) {
  if (runs.length === 0) {
    return <EmptyState title="Ни один запуск не идёт" description="Здесь будут запуски, которые выполняются прямо сейчас." />;
  }
  return (
    <ul className="divide-y rounded-lg border">
      {runs.map((run) => {
        const link = run.project ? href('project.run', { slug: run.project.slug, runId: run.id }) : null;
        return (
          <li key={run.id} className="flex items-center gap-3 px-4 py-2.5 hover:bg-accent/40">
            <Play className="size-4 shrink-0 text-chart-1" />
            <StatusBadge status={run.status} className="w-32 shrink-0 justify-center max-sm:hidden" />
            <div className="min-w-0 flex-1">
              {link ? (
                <a href={link} className="block truncate text-sm hover:underline">{run.task?.title ?? 'Запуск'}</a>
              ) : (
                <span className="block truncate text-sm">{run.task?.title ?? 'Запуск'}</span>
              )}
              <p className="truncate text-xs text-muted-foreground">
                {showProject && run.project ? `${run.project.slug} · ` : ''}
                {run.pipeline?.name ?? 'без пайплайна'}
                {run.job?.worker ? ` · ${run.job.worker.name}` : ''}
              </p>
            </div>
            <span className="w-32 shrink-0 truncate text-xs text-muted-foreground max-lg:hidden">{currentStage(run)}</span>
            <span className="w-20 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
              {elapsed(run.startedAt ?? run.createdAt)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * «Последние события» — the journal, not the inbox. It only ever grows, so a row here is history
 * and never something to act on; what waits for a person is the block above.
 */
function ActivityList({ rows, showProject }: { rows: OverviewActivityRow[]; showProject: boolean }) {
  if (rows.length === 0) {
    return <EmptyState title="Событий ещё не было" description="Лента пишется на каждый запуск, вопрос и решение." />;
  }
  return (
    <ul className="divide-y rounded-lg border">
      {rows.map((row) => (
        // Одна строка, а не две: `badge` из `activityTypes.ts` почти всегда пересказывает заголовок
        // («Сброс воркспейса не удался» · «сброс не прошёл»), и вторая строка добавляла высоты,
        // а не смысла. Проект остаётся — он единственное, чего в заголовке нет.
        <li key={row.id} className="flex items-center gap-3 px-4 py-2.5">
          <Clock className="size-3.5 shrink-0 text-muted-foreground" />
          {row.href ? (
            <a href={row.href} className="min-w-0 flex-1 truncate text-sm hover:underline">{row.title}</a>
          ) : (
            <span className="min-w-0 flex-1 truncate text-sm">{row.title}</span>
          )}
          {showProject && row.projectSlug && (
            <span className="w-32 shrink-0 truncate text-right text-xs text-muted-foreground max-md:hidden">{row.projectSlug}</span>
          )}
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{ago(row.createdAt)}</span>
        </li>
      ))}
    </ul>
  );
}

/** One number with its caption, and always a link: a figure nobody can open is a dead end. */
function StatTile({ label, value, link }: { label: string; value: React.ReactNode; link: string }) {
  return (
    <a href={link} className="rounded-lg border px-4 py-3 transition-colors hover:bg-accent/50">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
    </a>
  );
}

// ---------------------------------------------------------------------------------------------
// «Обзор» — everything the person may read
// ---------------------------------------------------------------------------------------------

export function OverviewScreen({ data }: { data: PanelOverview }) {
  const { stats } = data;
  return (
    <>
      <PageHeader
        title="Обзор"
        meta={[
          <span key="projects">
            {stats.activeProjects} {plural(stats.activeProjects, 'активный проект', 'активных проекта', 'активных проектов')}
            {stats.projects !== stats.activeProjects ? ` из ${stats.projects}` : ''}
          </span>,
        ]}
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <AlertTriangle className="size-4 agentiz-attention" /> Требует внимания
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            {data.attention.length === 0 ? (
              <p className="text-sm text-muted-foreground">Ничего не ждёт вашего решения.</p>
            ) : (
              <>
                <ul className="divide-y">
                  {data.attention.map((item) => <AttentionRow key={item.id} item={item} showProject />)}
                </ul>
                {stats.actionable > data.attention.length && (
                  <Button asChild variant="outline" size="sm" className="mt-3">
                    <a href={href('inbox')}>
                      Ещё {stats.actionable - data.attention.length} во «Входящих»
                    </a>
                  </Button>
                )}
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-sm">Сейчас</CardTitle></CardHeader>
          <CardContent className="space-y-1.5 pt-0 text-sm">
            <SummaryRow label="Открытых задач" value={stats.openTasks} link={href('projects')} />
            <SummaryRow label="Идущих запусков" value={stats.activeRuns} link={href('runs', {}, { status: 'running' })} />
            <SummaryRow label="Воркеров на связи" value={`${stats.workersOnline} из ${stats.workersTotal}`} link={href('workers')} />
            <SummaryRow label="Ждут решения" value={stats.actionable} link={href('inbox')} />
          </CardContent>
        </Card>
      </div>

      <h2 className="mb-2 mt-8 text-sm font-semibold">Идёт сейчас</h2>
      <RunningList runs={data.running} showProject />

      <h2 className="mb-2 mt-8 text-sm font-semibold">Последние события</h2>
      <ActivityList rows={data.activity} showProject />
    </>
  );
}

function SummaryRow({ label, value, link }: { label: string; value: React.ReactNode; link: string }) {
  return (
    <a href={link} className="flex items-center justify-between gap-2 rounded px-1 py-0.5 hover:bg-accent/50">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium tabular-nums">{value}</span>
    </a>
  );
}

// ---------------------------------------------------------------------------------------------
// The overview of one project
// ---------------------------------------------------------------------------------------------

export function ProjectOverviewScreen({
  data,
  project,
}: {
  data: PanelOverview;
  project: { id: string; slug: string; name: string };
}) {
  const { stats } = data;
  const slug = project.slug;
  const status = data.project?.isActive === false ? 'inactive' : 'active';

  return (
    <>
      <PageHeader
        title={project.name}
        meta={[
          <StatusBadge key="status" status={status} />,
          data.project?.description ? <span key="description">{data.project.description}</span> : null,
        ]}
        actions={
          <Button asChild>
            <a href={href('project.tasks', { slug }, { new: '1' })}><Plus /> Новая задача</a>
          </Button>
        }
      />

      {data.attention.length > 0 && (
        <div className="mb-6 rounded-lg border border-warning/50 bg-warning/10 p-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-medium">
            <AlertTriangle className="size-4 agentiz-attention" /> Требует внимания
          </div>
          <ul className="space-y-1.5">
            {data.attention.map((item) => <AttentionRow key={item.id} item={item} showProject={false} />)}
          </ul>
        </div>
      )}

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Открытых задач" value={stats.openTasks} link={href('project.tasks', { slug })} />
        <StatTile label="Идущих запусков" value={stats.activeRuns} link={href('project.runs', { slug }, { status: 'running' })} />
        <StatTile label="Ждут человека" value={stats.actionable} link={href('inbox')} />
        <StatTile label="Воркеров доступно" value={`${stats.workersOnline} из ${stats.workersTotal}`} link={href('workers')} />
      </div>

      <h2 className="mb-2 text-sm font-semibold">Идёт сейчас</h2>
      <RunningList runs={data.running} showProject={false} />

      <h2 className="mb-2 mt-8 text-sm font-semibold">Последние события</h2>
      <ActivityList rows={data.activity} showProject={false} />
    </>
  );
}
