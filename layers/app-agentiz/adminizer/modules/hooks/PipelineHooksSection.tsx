/**
 * The "скрипты вокруг стадий" block of the pipeline editor.
 *
 * Unlike the selects around it, a script is not saved as you type: a half-written `rm -rf` is a
 * valid document, and autosaving it would arm the next run with it. Each panel keeps a draft and
 * saves on an explicit press, so what is stored is always something somebody decided to store.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { HOOK_VARIABLES, DEFAULT_HOOK_TIMEOUT_SEC, type HookVariableScope } from '../../../lib/hookEnv';
import { HookScriptEditor } from './HookScriptEditor';

/*
 * CodeMirror is most of this module's JavaScript (~160 kB gzipped) and it loads even for someone
 * who never opens a hook. A dynamic import does shrink the first load, but under vite's lib mode it
 * also turns AgentizPipelines.js into a re-export facade — changing how the *whole* screen is
 * delivered, not just this editor. Adminizer's module loader is not in this repository, so that
 * change cannot be verified here, and a broken pipeline page is a worse outcome than a heavier one.
 * Revisit with the loader in hand.
 */

export interface HookConfig {
  interpreter: 'bash' | 'node';
  script: string;
  timeoutSec?: number;
  onFail?: 'stop' | 'continue';
}

export interface PipelineHooksSectionProps {
  hooks: { before?: HookConfig; after?: HookConfig } | undefined;
  sourceKind: 'repository' | 'worker_workspace';
  busy: boolean;
  /** Saves the whole hooks object; `undefined` for a position removes that hook. */
  onSave(next: { before?: HookConfig; after?: HookConfig }): void;
}

const POSITIONS: Array<{ key: 'before' | 'after'; title: string; hint: string }> = [
  {
    key: 'before',
    title: 'Перед стадиями',
    hint: 'Выполняется после того, как рабочая папка готова, и до первой стадии: поставить зависимости, поднять базу, сгенерировать конфиг.',
  },
  {
    key: 'after',
    title: 'После стадий',
    hint: 'Выполняется после последней стадии и до сбора диффа — значит, форматтер или кодогенерация попадут в изменения запуска. Запускается и когда стадия упала, тогда AGENTIZ_RUN_STATUS=failed.',
  },
];

const EMPTY_HOOK: HookConfig = { interpreter: 'bash', script: '', timeoutSec: DEFAULT_HOOK_TIMEOUT_SEC, onFail: 'stop' };

function scopeLabel(scope: HookVariableScope): string {
  if (scope === 'repository') return 'репозиторий';
  if (scope === 'workspace') return 'папка воркера';
  if (scope === 'after') return 'after';
  return '';
}

/** Reference list, so nobody has to leave the page to remember a name. */
function VariablePalette({ sourceKind, position }: { sourceKind: string; position: string }) {
  const [open, setOpen] = useState(false);
  const visible = useMemo(() => HOOK_VARIABLES.filter((variable) => {
    if (variable.scope === 'repository') return sourceKind === 'repository';
    if (variable.scope === 'workspace') return sourceKind === 'worker_workspace';
    if (variable.scope === 'after') return position === 'after';
    return true;
  }), [sourceKind, position]);

  return (
    <div className="mt-2">
      <button type="button" onClick={() => setOpen((value) => !value)} className="text-xs underline">
        {open ? 'Скрыть переменные' : `Доступные переменные (${visible.length})`}
      </button>
      {open && (
        <div className="mt-1 max-h-48 overflow-y-auto rounded border p-2">
          {visible.map((variable) => (
            <div key={variable.name} className="flex gap-2 py-0.5 text-xs">
              <code className="shrink-0 font-medium">${variable.name}</code>
              <span className="text-muted-foreground">
                {variable.description}
                {scopeLabel(variable.scope) && ` · ${scopeLabel(variable.scope)}`}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function HookPanel({
  position, title, hint, hook, sourceKind, busy, onChange,
}: {
  position: 'before' | 'after';
  title: string;
  hint: string;
  hook: HookConfig | undefined;
  sourceKind: 'repository' | 'worker_workspace';
  busy: boolean;
  onChange(next: HookConfig | undefined): void;
}) {
  const stored = Boolean(hook);
  // Separate from `stored`: ticking the checkbox opens the editor, but nothing is written until
  // there is a script to write — validation rejects an empty one, and a checkbox that fails to
  // save would be a strange thing to explain.
  const [expanded, setExpanded] = useState(stored);
  const [draft, setDraft] = useState<HookConfig>(hook ?? EMPTY_HOOK);

  // The server is the source of truth: after a save the parent refetches, and the draft has to
  // follow, or the panel keeps claiming unsaved changes forever.
  const savedKey = JSON.stringify(hook ?? null);
  useEffect(() => {
    setDraft(hook ?? EMPTY_HOOK);
    if (!hook) setExpanded(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedKey]);

  const saved = hook ?? EMPTY_HOOK;
  const dirty = !stored
    ? draft.script.trim().length > 0
    : draft.script !== saved.script || draft.interpreter !== saved.interpreter
      || (draft.timeoutSec ?? DEFAULT_HOOK_TIMEOUT_SEC) !== (saved.timeoutSec ?? DEFAULT_HOOK_TIMEOUT_SEC)
      || (draft.onFail ?? 'stop') !== (saved.onFail ?? 'stop');

  const editorContext = useMemo(
    () => ({ sourceKind, position }),
    [sourceKind, position],
  );

  return (
    <div className="rounded border p-3">
      <label className="flex items-center gap-2 text-sm font-medium">
        <input
          type="checkbox"
          checked={expanded}
          disabled={busy}
          onChange={(event) => {
            if (event.target.checked) {
              setExpanded(true);
            } else {
              setExpanded(false);
              // Only tell the server when there is something to remove.
              if (stored) onChange(undefined);
            }
          }}
        />
        {title}
        {stored && <span className="text-xs font-normal text-muted-foreground">· сохранён</span>}
      </label>
      <p className="mt-1 text-xs text-muted-foreground">{hint}</p>

      {expanded && (
        <div className="mt-2 space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <label className="text-xs text-muted-foreground">Чем исполнять</label>
            <select
              value={draft.interpreter}
              disabled={busy}
              onChange={(event) => setDraft({ ...draft, interpreter: event.target.value as 'bash' | 'node' })}
              className="rounded border px-2 py-1 disabled:opacity-50"
            >
              <option value="bash">#!/bin/bash</option>
              <option value="node">#!/bin/node</option>
            </select>

            <label className="text-xs text-muted-foreground">Таймаут, с</label>
            <input
              type="number"
              min={1}
              max={3600}
              value={draft.timeoutSec ?? DEFAULT_HOOK_TIMEOUT_SEC}
              disabled={busy}
              onChange={(event) => setDraft({ ...draft, timeoutSec: Number(event.target.value) || DEFAULT_HOOK_TIMEOUT_SEC })}
              className="w-20 rounded border px-2 py-1 disabled:opacity-50"
            />

            <label className="text-xs text-muted-foreground">Если упал</label>
            <select
              value={draft.onFail ?? 'stop'}
              disabled={busy}
              onChange={(event) => setDraft({ ...draft, onFail: event.target.value as 'stop' | 'continue' })}
              className="rounded border px-2 py-1 disabled:opacity-50"
            >
              <option value="stop">остановить запуск</option>
              <option value="continue">продолжить</option>
            </select>
          </div>

          <HookScriptEditor
            value={draft.script}
            onChange={(script) => setDraft({ ...draft, script })}
            interpreter={draft.interpreter}
            context={editorContext}
            placeholder="Скрипт пишется без строки #! — её подставит воркер по выбранному интерпретатору."
          />

          {draft.interpreter === 'node' && (
            <p className="text-xs text-muted-foreground">
              Подсветка синтаксиса пока только для bash; node-скрипт редактируется как обычный текст.
            </p>
          )}
          {draft.interpreter === 'bash' && (
            <p className="text-xs text-muted-foreground">
              Запускается как <code>bash -e -o pipefail</code>: первая же неуспешная команда завершает скрипт.
            </p>
          )}

          <VariablePalette sourceKind={sourceKind} position={position} />

          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={busy || !dirty || !draft.script.trim()}
              onClick={() => onChange(draft)}
              className="rounded border px-3 py-1 text-sm disabled:opacity-50"
            >
              Сохранить
            </button>
            {dirty && stored && <span className="text-xs text-amber-600">есть несохранённые изменения</span>}
            {!stored && <span className="text-xs text-muted-foreground">хук ещё не сохранён — запуски его не увидят</span>}
          </div>
        </div>
      )}
    </div>
  );
}

export function PipelineHooksSection({ hooks, sourceKind, busy, onSave }: PipelineHooksSectionProps) {
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium">Скрипты вокруг стадий</h3>
      <p className="text-xs text-muted-foreground">
        Оба скрипта выполняются на воркере, в той же папке, где работает агент. Значения приходят
        обычными переменными окружения — ничего не подставляется в текст скрипта, поэтому название
        задачи не может стать командой. Токен доступа к репозиторию хукам не выдаётся.
      </p>
      {POSITIONS.map((entry) => (
        <HookPanel
          key={entry.key}
          position={entry.key}
          title={entry.title}
          hint={entry.hint}
          hook={hooks?.[entry.key]}
          sourceKind={sourceKind}
          busy={busy}
          onChange={(next) => onSave({ ...hooks, [entry.key]: next })}
        />
      ))}
    </div>
  );
}

export default PipelineHooksSection;
