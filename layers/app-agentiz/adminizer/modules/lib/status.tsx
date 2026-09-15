import * as React from 'react';
import { Badge } from '@/components/ui/badge';
import { cn } from './ui';

/**
 * One status vocabulary for every entity in the panel.
 *
 * Each screen used to colour and word its own statuses — the UI review named that as its own
 * reason why "каждый экран изучаешь заново": the same `failed` was red here, grey there, and
 * printed as a raw enum value in a third place.
 *
 * Colours are panel palette tokens, never hex. That is what makes the dark theme work: `chart-1`
 * and `chart-2` are defined in both themes by adminizer, and `warning` joined them in
 * 5.1.0-build.28. A literal `#d1fae5` would stay pale green on a black background.
 */
type Tone = 'neutral' | 'running' | 'success' | 'warn' | 'danger' | 'muted';

const TONES: Record<Tone, string> = {
  neutral: 'border-border bg-secondary text-secondary-foreground',
  running: 'border-transparent bg-chart-1/15 text-chart-1',
  success: 'border-transparent bg-chart-2/15 text-chart-2',
  warn: 'border-transparent bg-warning/20 text-warning-foreground',
  danger: 'border-transparent bg-destructive/15 text-destructive',
  muted: 'border-border bg-transparent text-muted-foreground',
};

/** Keyed by the value stored in the database, so a status reaches the screen without translation. */
const DICT: Record<string, { label: string; tone: Tone }> = {
  // задачи
  new: { label: 'Новая', tone: 'neutral' },
  queued: { label: 'В очереди', tone: 'neutral' },
  running: { label: 'Идёт', tone: 'running' },
  waiting: { label: 'Ждёт человека', tone: 'warn' },
  waiting_input: { label: 'Ждёт ответа', tone: 'warn' },
  done: { label: 'Готово', tone: 'success' },
  failed: { label: 'Упало', tone: 'danger' },
  cancelled: { label: 'Отменено', tone: 'muted' },
  ignored: { label: 'Пропущена', tone: 'muted' },
  // запуски и этапы
  succeeded: { label: 'Успешно', tone: 'success' },
  pending: { label: 'Не начинался', tone: 'muted' },
  skipped: { label: 'Пропущен', tone: 'muted' },
  // вопросы агента (AgentRunInteraction)
  answered: { label: 'Отвечен', tone: 'neutral' },
  delivered: { label: 'Доставлен агенту', tone: 'success' },
  expired: { label: 'Истёк', tone: 'muted' },
  orphaned: { label: 'Потерян', tone: 'muted' },
  // предложения изменений
  waiting_review: { label: 'Ждёт ревью', tone: 'warn' },
  pushed: { label: 'Запушено', tone: 'success' },
  rejected: { label: 'Отклонено', tone: 'muted' },
  working: { label: 'В работе', tone: 'running' },
  push_failed: { label: 'Пуш не прошёл', tone: 'danger' },
  // воркеры, спеки, воркфлоу
  active: { label: 'Активен', tone: 'success' },
  paused: { label: 'На паузе', tone: 'muted' },
  online: { label: 'На связи', tone: 'success' },
  offline: { label: 'Нет связи', tone: 'muted' },
  draft: { label: 'Черновик', tone: 'muted' },
  inactive: { label: 'Выключен', tone: 'muted' },
  revoked: { label: 'Отозван', tone: 'danger' },
  never_contacted: { label: 'Не подключался', tone: 'muted' },
  // Четвёртое состояние `AgentGitConnection.status`: остальные три уже выше («активен»,
  // «истёк», «отозван»). Означает, что платформа ответила отказом — причина в `lastError`.
  error: { label: 'Ошибка', tone: 'danger' },
  // Состояния привязки воркер × обвязка (`workerHarnessView.state`). Три из четырёх кончаются
  // по-разному, поэтому и называются по-разному: лимит ждёт сброса, выключенную включает оператор,
  // а «нет входа» чинится только браузером на машине воркера и момента возврата не имеет.
  available: { label: 'Доступна', tone: 'success' },
  disabled: { label: 'Выключена оператором', tone: 'muted' },
  unauthorized: { label: 'Нет входа', tone: 'danger' },
  exhausted: { label: 'Лимит исчерпан', tone: 'danger' },
  pass: { label: 'Вердикт: годно', tone: 'success' },
  fail: { label: 'Вердикт: не годно', tone: 'danger' },
};

/** An unknown status is printed as it is stored rather than hidden — a new enum value must be visible. */
export function statusLabel(status: string): string {
  return DICT[status]?.label ?? status;
}

/**
 * What started a run (`AgentRun.trigger`). Not a status, but the same kind of thing and here for
 * the same reason: it is a stored enum value that two screens print — the run board and the task
 * timeline — and a word that differs between them reads as two different events.
 */
const TRIGGERS: Record<string, string> = {
  sync: 'синхронизация задач',
  manual: 'вручную',
  webhook: 'вебхук',
  schedule: 'расписание',
  human_comment: 'комментарий человека',
};

export function triggerLabel(trigger: string): string {
  return TRIGGERS[trigger] ?? trigger;
}

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  const item = DICT[status] ?? { label: status, tone: 'neutral' as Tone };
  return (
    <Badge variant="outline" className={cn('gap-1.5', TONES[item.tone], className)}>
      {item.tone === 'running' && <span className="size-1.5 animate-pulse rounded-full bg-current" />}
      {item.label}
    </Badge>
  );
}
