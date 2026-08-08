/**
 * CodeMirror 6 wrapper for a pipeline hook script.
 *
 * Contract is deliberately the same as a plain `<textarea>` — `value` / `onChange` — so the page
 * around it does not have to know CodeMirror exists. Internally the editor is the opposite of a
 * controlled React input: the view is created once and kept, and a changed `value` is pushed into
 * it as a transaction. Re-creating it on every render would lose the cursor, the undo history and
 * the open completion popup on every keystroke.
 */
import React, { useEffect, useRef } from 'react';
import { closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, defaultHighlightStyle, indentOnInput, syntaxHighlighting } from '@codemirror/language';
import { lintGutter, lintKeymap } from '@codemirror/lint';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, drawSelection, highlightActiveLine, highlightSpecialChars, keymap, lineNumbers } from '@codemirror/view';
import { hookExtensions, type HookEditorContext } from './hookEditorExtensions';

export interface HookScriptEditorProps {
  value: string;
  onChange(next: string): void;
  /** Drives syntax highlighting. Only bash is highlighted for now; node falls back to plain text. */
  interpreter: string;
  context: HookEditorContext;
  placeholder?: string;
  minHeight?: number;
}

/** Editing niceties that never change; the language and the variable rules live in a compartment. */
const staticExtensions = [
  lineNumbers(),
  highlightSpecialChars(),
  history(),
  drawSelection(),
  indentOnInput(),
  bracketMatching(),
  closeBrackets(),
  highlightActiveLine(),
  lintGutter(),
  syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
  // `indentWithTab` last so Tab indents instead of leaving the editor. That traps keyboard focus,
  // which is why Escape-then-Tab still works: defaultKeymap keeps the escape hatch.
  keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, ...completionKeymap, ...lintKeymap, indentWithTab]),
];

export function HookScriptEditor({ value, onChange, interpreter, context, placeholder, minHeight = 180 }: HookScriptEditorProps) {
  const host = useRef<HTMLDivElement | null>(null);
  const view = useRef<EditorView | null>(null);
  const language = useRef(new Compartment());
  // Kept in a ref so the update listener never closes over a stale prop: the listener is installed
  // once, for the life of the view, but `onChange` is a new function on every render.
  const notify = useRef(onChange);
  notify.current = onChange;

  useEffect(() => {
    if (!host.current) return undefined;
    const instance = new EditorView({
      state: EditorState.create({
        doc: value,
        extensions: [
          ...staticExtensions,
          language.current.of(hookExtensions(interpreter, context)),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) notify.current(update.state.doc.toString());
          }),
          EditorView.theme({ '.cm-content': { minHeight: `${minHeight}px` } }),
        ],
      }),
      parent: host.current,
    });
    view.current = instance;
    return () => {
      instance.destroy();
      view.current = null;
    };
    // Intentionally once: everything that can change is either pushed in or reconfigured below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Swapping the interpreter or the pipeline's source changes highlighting and which variables
  // count as in scope, without touching the document.
  useEffect(() => {
    view.current?.dispatch({
      effects: language.current.reconfigure(hookExtensions(interpreter, context)),
    });
  }, [interpreter, context.sourceKind, context.position]);

  // Only when the outside value genuinely diverged — otherwise every keystroke would round-trip
  // through the parent and reset the selection.
  useEffect(() => {
    const instance = view.current;
    if (!instance) return;
    const current = instance.state.doc.toString();
    if (current === value) return;
    instance.dispatch({ changes: { from: 0, to: current.length, insert: value } });
  }, [value]);

  return (
    <div>
      <div ref={host} />
      {placeholder && !value ? (
        <div style={{ fontSize: 12, color: "#71717a", marginTop: 4 }}>{placeholder}</div>
      ) : null}
    </div>
  );
}

export default HookScriptEditor;
