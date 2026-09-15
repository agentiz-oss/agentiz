import React from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { ago, plural, queryParam, setQueryParam } from './format';
import { EmptyState, Page, PageHeader } from './page';
import { cn, toast } from './ui';

/**
 * «Входящие» — everything waiting on the person reading it.
 *
 * The words on this screen are **not** invented here. `badge`, `headline`, `facts` and `explain`
 * come from the server (`lib/inbox/items.ts`), the same four fields the phone renders, for the
 * reason that catalogue exists at all: three surfaces naming one event three ways is what made
 * «ревью · 0 файлов» mean nothing in particular. A client that composes its own captions is how
 * that comes back.
 *
 * The replacement for `/dashboard/agentiz-interactions` («Нужен ответ»), which showed one of the
 * ten kinds — an agent's question — and nothing else.
 */

export interface PanelInboxItem {
  id: string;
  kind: string;
  activityType: string;
  badge: string;
  headline: string;
  facts: string | null;
  explain: string | null;
  priority: number;
  projectId: string;
  projectName: string | null;
  projectSlug: string | null;
  taskId: string | null;
  taskTitle: string | null;
  runId: string | null;
  interactionId: string | null;
  proposalId: string | null;
  approvalId: string | null;
  revision: number | null;
  url: string | null;
  waitingSince: string | null;
  href: string | null;
  blocking: boolean;
  notify: { typeLabel: string; push: string; dashboard: string; label: string } | null;
  actions: Array<{ key: string; label: string; style: 'primary' | 'default' | 'danger' }>;
}

export interface PanelInbox {
  items: PanelInboxItem[];
  actionableCount: number;
  reminderCount: number;
  workerAlerts: { needLogin: number; offline: number };
}

const PREFIX: string = (window as any).routePrefix ?? '/dashboard';
const axios = (window as any).axios;

/** The three tabs, as query values. Anything else falls back to «Всё». */
const VIEWS: Array<{ value: string; label: string; keeps: (item: PanelInboxItem) => boolean }> = [
  { value: 'all', label: 'Всё', keeps: () => true },
  { value: 'blocking', label: 'Ждут решения', keeps: (item) => item.blocking },
  { value: 'reminders', label: 'Напоминания', keeps: (item) => !item.blocking },
];

/**
 * What a button does in the panel.
 *
 * Every write here is an endpoint that already exists and that the old screens already used — the
 * inbox is a projection for reading, not a new write surface, so it must not grow its own verbs.
 * `null` means the decision needs a form the inbox does not have (an elicitation's schema, a
 * pipeline choice), and the row's own screen is where that form lives; the button becomes a link
 * rather than a control that fails.
 */
type Call = { path: string; body: Record<string, unknown>; needsComment?: boolean; confirm?: string };

export function callFor(item: PanelInboxItem, key: string): Call | null {
  if (key === 'approve' && item.approvalId) {
    return { path: '/agentiz-tasks', body: { _method: 'decideApproval', approvalId: item.approvalId, decision: 'approved' } };
  }
  if (key === 'reject' && item.approvalId) {
    // `ApprovalService` refuses a rejection with no text, and rightly: that text is what the agent
    // receives as its next instruction.
    return {
      path: '/agentiz-tasks',
      body: { _method: 'decideApproval', approvalId: item.approvalId, decision: 'rejected' },
      needsComment: true,
    };
  }
  if (key === 'approve' && item.proposalId) {
    return { path: '/agentiz-runs', body: { _method: 'approveWorkspaceProposal', proposalId: item.proposalId, revision: item.revision } };
  }
  if (key === 'reject' && item.proposalId) {
    return {
      path: '/agentiz-runs',
      body: { _method: 'rejectWorkspaceProposal', proposalId: item.proposalId, revision: item.revision },
      confirm: 'Работа в папке воркера будет отложена в stash и папка освобождена. Продолжить?',
    };
  }
  if (key === 'apply_diff' && item.runId) {
    return { path: '/agentiz-runs', body: { _method: 'applyRunDiff', runId: item.runId } };
  }
  return null;
}

function InboxRow({ item, selected, onSelect }: {
  item: PanelInboxItem;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        className={cn(
          'flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-accent/50',
          selected && 'bg-accent',
        )}
      >
        <span className={cn('mt-1.5 size-2 shrink-0 rounded-full', item.blocking ? 'bg-warning' : 'bg-muted-foreground/40')} />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>{item.badge}</span>
            {!item.blocking && <span>· напоминание</span>}
          </span>
          <span className="mt-0.5 block truncate text-sm font-medium">{item.headline}</span>
          <span className="mt-0.5 block truncate text-xs text-muted-foreground">
            {item.taskTitle ?? 'без задачи'}
            {item.waitingSince ? ` · ${ago(item.waitingSince)}` : ''}
          </span>
        </span>
      </button>
    </li>
  );
}

/**
 * The buttons of one row, and the text box the rejecting ones need.
 *
 * Exported because the task screen prints the very same rows above a task («требует внимания»), and
 * a second mapping from an action key to an endpoint is how the two surfaces start doing different
 * things to the same entity. Where the decision needs a form this list does not have — an
 * elicitation's schema, a choice of pipeline — the button becomes a link to the row's own screen
 * instead of a control that is guaranteed to fail.
 */
export function InboxDecision({ item, onDone }: { item: PanelInboxItem; onDone: () => void }) {
  const [comment, setComment] = React.useState('');
  const [busy, setBusy] = React.useState<string | null>(null);

  const run = async (key: string, call: Call) => {
    if (call.needsComment && !comment.trim()) {
      toast.error('Напишите, что не так — этот текст агент получит как следующее указание.');
      return;
    }
    if (call.confirm && !window.confirm(call.confirm)) return;
    setBusy(key);
    try {
      await axios.post(`${PREFIX}${call.path}`, {
        ...call.body,
        ...(call.needsComment ? { comment: comment.trim() } : {}),
      });
      toast.success('Готово');
      setComment('');
      onDone();
    } catch (error: any) {
      toast.error(error?.response?.data?.message ?? 'Не получилось');
    } finally {
      setBusy(null);
    }
  };

  const needsComment = item.actions.some((action) => callFor(item, action.key)?.needsComment);

  return (
    <div className="space-y-3">
      {needsComment && (
        <Textarea
          value={comment}
          onChange={(event: any) => setComment(event.target.value)}
          placeholder="Что переделать — этот текст агент получит как следующее указание"
          rows={3}
        />
      )}

      <div className="flex flex-wrap gap-2">
        {item.actions.map((action) => {
          const call = callFor(item, action.key);
          const variant = action.style === 'primary' ? 'default' : action.style === 'danger' ? 'destructive' : 'outline';
          if (!call) {
            // No endpoint the inbox may call on its own: the row's own screen has the form.
            const target = action.key === 'open_url' && item.url ? item.url : item.href;
            if (!target) return null;
            return (
              <Button key={action.key} asChild size="sm" variant={variant as any}>
                <a href={target}>{action.label}</a>
              </Button>
            );
          }
          return (
            <Button
              key={action.key}
              size="sm"
              variant={variant as any}
              disabled={busy !== null}
              onClick={() => run(action.key, call)}
            >
              {action.label}
            </Button>
          );
        })}
      </div>
    </div>
  );
}

function InboxDetail({ item, onDone }: { item: PanelInboxItem; onDone: () => void }) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-sm">{item.badge}</CardTitle>
          <span className="text-xs text-muted-foreground">{ago(item.waitingSince)}</span>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 pt-0">
        <div>
          <p className="text-sm font-medium">{item.headline}</p>
          {item.explain && <p className="mt-1 text-sm text-muted-foreground">{item.explain}</p>}
        </div>
        {item.facts && (
          <p className="rounded border bg-muted/40 px-2 py-1 font-mono text-[11px] text-muted-foreground">{item.facts}</p>
        )}

        <InboxDecision item={item} onDone={onDone} />

        {item.notify && (
          <>
            <Separator />
            <p className="text-xs text-muted-foreground">
              {item.notify.typeLabel}: {item.notify.label}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function InboxScreen({ initial }: { initial: PanelInbox }) {
  const [inbox, setInbox] = React.useState<PanelInbox>(initial);
  const [view, setView] = React.useState(queryParam('view') ?? 'all');
  const [selectedId, setSelectedId] = React.useState<string | null>(queryParam('item'));

  const reload = React.useCallback(async () => {
    // A row leaves this list because its entity closed, never because time passed, so the only
    // honest way to learn that it is gone is to ask again.
    const response = await axios.get(`${PREFIX}/agentiz`, { params: { _method: 'getInbox' } });
    setInbox(response.data.data);
  }, []);

  const keeps = (VIEWS.find((entry) => entry.value === view) ?? VIEWS[0]).keeps;
  const shown = inbox.items.filter(keeps);
  const selected = shown.find((item) => item.id === selectedId) ?? shown[0] ?? null;

  // Grouped by project, because "что меня ждёт" across five projects is otherwise one flat wall.
  const groups = new Map<string, PanelInboxItem[]>();
  for (const item of shown) {
    const key = item.projectName ?? item.projectId;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }

  return (
    <Page width="wide">
      <PageHeader
        title="Входящие"
        meta={[
          <span key="b">
            {inbox.actionableCount} {plural(inbox.actionableCount, 'ждёт', 'ждут', 'ждут')} решения
          </span>,
          <span key="r">
            {inbox.reminderCount} {plural(inbox.reminderCount, 'напоминание', 'напоминания', 'напоминаний')}
          </span>,
          (inbox.workerAlerts.needLogin > 0 || inbox.workerAlerts.offline > 0) && (
            <Badge key="w" variant="outline">
              воркеры: {inbox.workerAlerts.needLogin} без входа · {inbox.workerAlerts.offline} офлайн
            </Badge>
          ),
        ]}
        tabs={
          <Tabs
            value={view}
            onValueChange={(value: string) => { setView(value); setQueryParam('view', value === 'all' ? null : value); }}
          >
            <TabsList>
              {VIEWS.map((entry) => (
                <TabsTrigger key={entry.value} value={entry.value}>{entry.label}</TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        }
      />

      {shown.length === 0 ? (
        <EmptyState
          title="Ничего не ждёт"
          description="Здесь появляются вопросы агентов, ревью, решения и напоминания по всем вашим проектам."
        />
      ) : (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_440px]">
          <div className="min-w-0 space-y-6">
            {[...groups.entries()].map(([name, items]) => (
              <div key={name}>
                <div className="mb-1.5 flex items-center gap-2 text-xs text-muted-foreground">
                  {items[0].projectSlug ? (
                    <a href={`${PREFIX}/agentiz/projects/${items[0].projectSlug}`} className="font-medium hover:underline">{name}</a>
                  ) : (
                    <span className="font-medium">{name}</span>
                  )}
                  <span>· {items.length}</span>
                </div>
                <ul className="divide-y rounded-lg border">
                  {items.map((item) => (
                    <InboxRow
                      key={item.id}
                      item={item}
                      selected={selected?.id === item.id}
                      onSelect={() => { setSelectedId(item.id); setQueryParam('item', item.id); }}
                    />
                  ))}
                </ul>
              </div>
            ))}
          </div>

          <div className="xl:sticky xl:top-4 xl:self-start">
            {selected
              ? <InboxDetail item={selected} onDone={reload} />
              : <EmptyState title="Выберите строку" />}
          </div>
        </div>
      )}
    </Page>
  );
}
