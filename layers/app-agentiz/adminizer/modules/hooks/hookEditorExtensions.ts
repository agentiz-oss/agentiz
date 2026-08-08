/**
 * CodeMirror extensions for the pipeline hook editor: highlight, complete and lint the
 * `$AGENTIZ_*` variables a script may read.
 *
 * The catalogue itself is not defined here — it is imported from `lib/hookEnv.ts`, the same module
 * the server uses to build the environment. That is the whole point of the arrangement: the names
 * offered while typing cannot drift away from the names a run actually exports, which is the
 * failure mode of keeping the grammar in one place and the values in another.
 */
import { autocompletion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { StreamLanguage } from '@codemirror/language';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { linter, type Diagnostic } from '@codemirror/lint';
import { Decoration, EditorView, MatchDecorator, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { HOOK_VARIABLES, HOOK_VARIABLE_NAMES, type HookVariableScope } from '../../../lib/hookEnv';

/** `$NAME` and `${NAME}` — matched in one pattern so highlight and lint agree on what a mention is. */
const VARIABLE_PATTERN = /\$\{?(AGENTIZ_[A-Z0-9_]*)\}?/g;

/**
 * Which variables this particular pipeline will actually define.
 *
 * A repository pipeline has no `AGENTIZ_WORKSPACE_PATH` and a directory pipeline has no
 * `AGENTIZ_BASE_SHA`. Both are real names, so calling them "unknown" would be wrong — they get a
 * warning that says they will be empty *here*, which is the thing worth knowing before saving.
 */
export interface HookEditorContext {
  sourceKind: 'repository' | 'worker_workspace';
  position: 'before' | 'after';
}

function scopeApplies(scope: HookVariableScope, context: HookEditorContext): boolean {
  if (scope === 'always') return true;
  if (scope === 'repository') return context.sourceKind === 'repository';
  if (scope === 'workspace') return context.sourceKind === 'worker_workspace';
  return context.position === 'after';
}

function scopeNote(scope: HookVariableScope, context: HookEditorContext): string | null {
  if (scopeApplies(scope, context)) return null;
  if (scope === 'repository') return 'только для пайплайна, работающего с репозиторием';
  if (scope === 'workspace') return 'только для пайплайна, работающего в папке воркера';
  return 'только в after-хуке';
}

/** Language support. `shell` covers bash; node scripts get plain text until a JS mode is added. */
export function hookLanguage(interpreter: string) {
  return interpreter === 'bash' ? [StreamLanguage.define(shell)] : [];
}

const knownMark = Decoration.mark({ class: 'cm-agentiz-var' });
const unknownMark = Decoration.mark({ class: 'cm-agentiz-var-unknown' });
const outOfScopeMark = Decoration.mark({ class: 'cm-agentiz-var-scope' });

/**
 * Paints every `$AGENTIZ_*` mention so a typo is visible before the run rather than after it.
 *
 * `MatchDecorator` re-runs only over the changed viewport, which matters because this runs on every
 * keystroke.
 */
export function hookVariableHighlight(context: HookEditorContext) {
  const matcher = new MatchDecorator({
    regexp: VARIABLE_PATTERN,
    decoration: (match) => {
      const name = match[1];
      if (!HOOK_VARIABLE_NAMES.has(name)) return unknownMark;
      const definition = HOOK_VARIABLES.find((item) => item.name === name);
      return definition && !scopeApplies(definition.scope, context) ? outOfScopeMark : knownMark;
    },
  });
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = matcher.createDeco(view);
      }
      update(update: ViewUpdate) {
        this.decorations = matcher.updateDeco(update, this.decorations);
      }
    },
    { decorations: (instance) => instance.decorations },
  );
}

/**
 * Completion over the catalogue, triggered by the `$` that starts every mention.
 *
 * Variables that will not exist in this pipeline are still offered, but sorted last and labelled,
 * because the alternative — hiding them — leaves somebody wondering why the name they read in the
 * docs does not come up.
 */
export function hookVariableCompletion(context: HookEditorContext) {
  return autocompletion({
    override: [(ctx: CompletionContext): CompletionResult | null => {
      const word = ctx.matchBefore(/\$\{?[A-Za-z0-9_]*/);
      if (!word || (word.from === word.to && !ctx.explicit)) return null;
      const braced = word.text.startsWith('${');
      return {
        from: word.from,
        options: HOOK_VARIABLES.map((variable) => {
          const note = scopeNote(variable.scope, context);
          return {
            label: braced ? `\${${variable.name}}` : `$${variable.name}`,
            type: 'variable',
            detail: note ?? variable.example,
            info: note ? `${variable.description}\n(${note})` : variable.description,
            boost: note ? -1 : 0,
          };
        }),
        validFor: /^\$\{?[A-Za-z0-9_]*\}?$/,
      };
    }],
  });
}

/**
 * Underlines mentions that will not resolve.
 *
 * An unknown name is an error, because `AGENTIZ_` is our prefix and a misspelling silently expands
 * to an empty string — the single most annoying way for a hook to go wrong. A name that is real but
 * out of scope for this pipeline is a warning, since the script may be shared between pipelines.
 */
export function hookVariableLinter(context: HookEditorContext) {
  return linter((view): Diagnostic[] => {
    const text = view.state.doc.toString();
    const diagnostics: Diagnostic[] = [];
    const pattern = new RegExp(VARIABLE_PATTERN.source, 'g');
    for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
      const name = match[1];
      const from = match.index;
      const to = from + match[0].length;
      const definition = HOOK_VARIABLES.find((item) => item.name === name);
      if (!definition) {
        diagnostics.push({
          from, to, severity: 'error',
          message: `Agentiz не определяет переменную ${name}. Если вы задаёте её сами в этом же скрипте — предупреждение можно игнорировать.`,
        });
        continue;
      }
      const note = scopeNote(definition.scope, context);
      if (note) {
        diagnostics.push({ from, to, severity: 'warning', message: `${name} — ${note}. Здесь она будет пустой.` });
      }
    }
    return diagnostics;
  });
}

/**
 * Look and feel.
 *
 * Colours come from Adminizer's CSS variables where they exist so the editor follows the panel's
 * light/dark theme instead of pinning its own.
 */
export const hookEditorTheme = EditorView.theme({
  '&': { fontSize: '13px', border: '1px solid var(--border, #d4d4d8)', borderRadius: '6px', overflow: 'hidden' },
  '&.cm-focused': { outline: '2px solid var(--ring, #6366f1)', outlineOffset: '-1px' },
  '.cm-content': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', padding: '8px 0' },
  '.cm-gutters': { backgroundColor: 'transparent', border: 'none', color: 'var(--muted-foreground, #a1a1aa)' },
  '.cm-agentiz-var': { color: '#0f766e', fontWeight: '600' },
  '.cm-agentiz-var-unknown': { color: '#b91c1c', textDecoration: 'underline wavy #b91c1c' },
  '.cm-agentiz-var-scope': { color: '#b45309', textDecoration: 'underline dotted #b45309' },
});

/** Everything the editor needs for one hook, in the order CodeMirror expects. */
export function hookExtensions(interpreter: string, context: HookEditorContext) {
  return [
    ...hookLanguage(interpreter),
    hookVariableHighlight(context),
    hookVariableCompletion(context),
    hookVariableLinter(context),
    hookEditorTheme,
  ];
}
