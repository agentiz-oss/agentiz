import React, { useMemo, useState } from "react";
import { diffLines } from "diff";
import parseDiff from "parse-diff";

/**
 * Diff viewer in the shape of the assistant-ui registry component
 * (`npx shadcn@latest add @assistant-ui/diff-viewer`), vendored into the repo because these
 * admin modules are built by our own vite lib config and have no shadcn registry / `@/lib/utils`
 * to install into.
 *
 * Two deviations from upstream, both to match the GitLab/GitHub review UI we are copying:
 * colours are inline styles rather than tailwind `bg-muted` + arbitrary values (the dashboard's
 * CSS is compiled by Adminizer, so classes this file invents are simply absent at runtime), and
 * hunk headers (`@@ … @@`) are kept as their own line type instead of being dropped — without
 * them a patch with several hunks reads as one continuous file.
 */

type DiffLineType = "add" | "del" | "normal" | "hunk";

interface ParsedLine {
  type: DiffLineType;
  content: string;
  oldLineNumber?: number;
  newLineNumber?: number;
}

interface ParsedFile {
  oldName?: string | undefined;
  newName?: string | undefined;
  lines: ParsedLine[];
  additions: number;
  deletions: number;
}

interface SplitLinePair {
  left: ParsedLine | null;
  right: ParsedLine | null;
  hunk?: string;
}

const palette = {
  border: "#30363d",
  background: "#0d1117",
  text: "#e6edf3",
  gutterText: "#6e7681",
  headerBackground: "#161b22",
  headerText: "#c9d1d9",
  hunkBackground: "#161b22",
  hunkText: "#8b949e",
  addBackground: "rgba(46,160,67,0.18)",
  addGutter: "rgba(46,160,67,0.32)",
  addText: "#7ee787",
  delBackground: "rgba(248,81,73,0.16)",
  delGutter: "rgba(248,81,73,0.3)",
  delText: "#ffa198",
  emptyBackground: "#0b0e13",
};

function parsePatch(patch: string): ParsedFile[] {
  return parseDiff(patch).map((file) => {
    const lines: ParsedLine[] = [];
    let additions = 0;
    let deletions = 0;
    for (const chunk of file.chunks) {
      lines.push({ type: "hunk", content: chunk.content });
      for (const change of chunk.changes) {
        if (change.type === "add") {
          additions++;
          lines.push({ type: "add", content: change.content.slice(1), newLineNumber: change.ln });
        } else if (change.type === "del") {
          deletions++;
          lines.push({ type: "del", content: change.content.slice(1), oldLineNumber: change.ln });
        } else {
          lines.push({
            type: "normal",
            content: change.content.slice(1),
            oldLineNumber: change.ln1,
            newLineNumber: change.ln2,
          });
        }
      }
    }
    return { oldName: file.from, newName: file.to, lines, additions, deletions };
  });
}

function computeDiff(oldContent: string, newContent: string): {
  lines: ParsedLine[];
  additions: number;
  deletions: number;
} {
  const lines: ParsedLine[] = [];
  let oldLine = 1;
  let newLine = 1;
  let additions = 0;
  let deletions = 0;

  for (const change of diffLines(oldContent, newContent)) {
    for (const content of change.value.replace(/\n$/, "").split("\n")) {
      if (change.added) {
        additions++;
        lines.push({ type: "add", content, newLineNumber: newLine++ });
      } else if (change.removed) {
        deletions++;
        lines.push({ type: "del", content, oldLineNumber: oldLine++ });
      } else {
        lines.push({ type: "normal", content, oldLineNumber: oldLine++, newLineNumber: newLine++ });
      }
    }
  }
  return { lines, additions, deletions };
}

/**
 * Side-by-side pairing: a run of deletions is zipped against the run of additions that follows
 * it, so a rewritten line sits opposite the line it replaced instead of below it.
 */
function pairLinesForSplit(lines: ParsedLine[]): SplitLinePair[] {
  const pairs: SplitLinePair[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.type === "hunk") {
      pairs.push({ left: null, right: null, hunk: line.content });
      i++;
    } else if (line.type === "normal") {
      pairs.push({ left: line, right: line });
      i++;
    } else {
      const deletions: ParsedLine[] = [];
      while (i < lines.length && lines[i]!.type === "del") deletions.push(lines[i++]!);
      const additions: ParsedLine[] = [];
      while (i < lines.length && lines[i]!.type === "add") additions.push(lines[i++]!);
      for (let j = 0; j < Math.max(deletions.length, additions.length); j++) {
        pairs.push({ left: deletions[j] ?? null, right: additions[j] ?? null });
      }
    }
  }
  return pairs;
}

function backgroundFor(type: DiffLineType | "empty"): string | undefined {
  if (type === "add") return palette.addBackground;
  if (type === "del") return palette.delBackground;
  if (type === "empty") return palette.emptyBackground;
  return undefined;
}

function gutterBackgroundFor(type: DiffLineType | "empty"): string | undefined {
  if (type === "add") return palette.addGutter;
  if (type === "del") return palette.delGutter;
  if (type === "empty") return palette.emptyBackground;
  return undefined;
}

function textColorFor(type: DiffLineType | "empty"): string {
  if (type === "add") return palette.addText;
  if (type === "del") return palette.delText;
  return palette.text;
}

const gutterStyle: React.CSSProperties = {
  width: 48,
  flexShrink: 0,
  padding: "0 8px",
  textAlign: "right",
  color: palette.gutterText,
  userSelect: "none",
};

const codeStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  padding: "0 8px",
  whiteSpace: "pre",
};

function HunkRow({ content }: { content: string }) {
  return (
    <div
      data-slot="diff-viewer-hunk"
      style={{
        display: "flex",
        backgroundColor: palette.hunkBackground,
        color: palette.hunkText,
        borderTop: `1px solid ${palette.border}`,
        borderBottom: `1px solid ${palette.border}`,
      }}
    >
      <span style={{ ...gutterStyle }}>…</span>
      <span style={{ ...gutterStyle }}>…</span>
      <span style={codeStyle}>{content}</span>
    </div>
  );
}

function DiffViewerLine({ line, showLineNumbers }: { line: ParsedLine; showLineNumbers: boolean }) {
  if (line.type === "hunk") return <HunkRow content={line.content} />;
  const marker = line.type === "add" ? "+" : line.type === "del" ? "-" : " ";
  return (
    <div
      data-slot="diff-viewer-line"
      data-type={line.type}
      style={{ display: "flex", backgroundColor: backgroundFor(line.type) }}
    >
      {showLineNumbers && (
        <>
          <span style={{ ...gutterStyle, backgroundColor: gutterBackgroundFor(line.type) }}>
            {line.oldLineNumber ?? ""}
          </span>
          <span style={{ ...gutterStyle, backgroundColor: gutterBackgroundFor(line.type) }}>
            {line.newLineNumber ?? ""}
          </span>
        </>
      )}
      <span style={{ ...codeStyle, color: textColorFor(line.type) }}>
        {marker} {line.content}
      </span>
    </div>
  );
}

function SplitSide({
  line,
  side,
  showLineNumbers,
}: {
  line: ParsedLine | null;
  side: "left" | "right";
  showLineNumbers: boolean;
}) {
  const type = line ? line.type : "empty";
  const marker = !line ? "" : line.type === "add" ? "+" : line.type === "del" ? "-" : " ";
  return (
    <div
      data-slot={`diff-viewer-split-${side}`}
      data-type={type}
      style={{
        display: "flex",
        width: "50%",
        minWidth: 0,
        backgroundColor: backgroundFor(type),
        borderRight: side === "left" ? `1px solid ${palette.border}` : undefined,
      }}
    >
      {showLineNumbers && (
        <span style={{ ...gutterStyle, backgroundColor: gutterBackgroundFor(type) }}>
          {(side === "left" ? line?.oldLineNumber : line?.newLineNumber) ?? ""}
        </span>
      )}
      {/* Side-by-side halves are 50% of the viewport, so long lines wrap here instead of
          scrolling — a horizontal scrollbar per half would desynchronise the two columns. */}
      <span
        style={{
          ...codeStyle,
          color: textColorFor(type),
          whiteSpace: "pre-wrap",
          wordBreak: "break-all",
        }}
      >
        {line ? `${marker} ${line.content}` : ""}
      </span>
    </div>
  );
}

function DiffViewerSplitLine({ pair, showLineNumbers }: { pair: SplitLinePair; showLineNumbers: boolean }) {
  if (pair.hunk !== undefined) return <HunkRow content={pair.hunk} />;
  return (
    <div data-slot="diff-viewer-split-line" style={{ display: "flex" }}>
      <SplitSide line={pair.left} side="left" showLineNumbers={showLineNumbers} />
      <SplitSide line={pair.right} side="right" showLineNumbers={showLineNumbers} />
    </div>
  );
}

function FileHeader({
  file,
  collapsed,
  onToggle,
}: {
  file: ParsedFile;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const renamed = file.oldName && file.newName && file.oldName !== file.newName;
  return (
    <div
      data-slot="diff-viewer-header"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 12px",
        backgroundColor: palette.headerBackground,
        color: palette.headerText,
        borderBottom: `1px solid ${palette.border}`,
      }}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        style={{
          background: "none",
          border: "none",
          color: palette.hunkText,
          cursor: "pointer",
          padding: 0,
          width: 14,
        }}
      >
        {collapsed ? "›" : "⌄"}
      </button>
      <span style={{ flex: 1, fontWeight: 600, wordBreak: "break-all" }}>
        {renamed ? (
          <>
            <span style={{ color: palette.delText }}>{file.oldName}</span>
            {" → "}
            <span style={{ color: palette.addText }}>{file.newName}</span>
          </>
        ) : (
          file.newName || file.oldName
        )}
      </span>
      <span style={{ color: palette.addText }}>+{file.additions}</span>
      <span style={{ color: palette.delText }}>−{file.deletions}</span>
    </div>
  );
}

type ViewMode = "split" | "unified";

export interface DiffViewerProps {
  patch?: string | null;
  oldFile?: { content: string; name?: string };
  newFile?: { content: string; name?: string };
  /** Uncontrolled starting mode; the toolbar switch takes over from there. */
  viewMode?: ViewMode;
  /** Set to control the mode from outside — then the built-in toolbar is not rendered. */
  onViewModeChange?: (mode: ViewMode) => void;
  showToolbar?: boolean;
  showLineNumbers?: boolean;
  /** Remembers the toolbar choice across page loads under this localStorage key. */
  persistKey?: string;
  maxHeight?: number | string;
  className?: string;
}

function readPersistedMode(key: string | undefined, fallback: ViewMode): ViewMode {
  if (!key || typeof window === "undefined") return fallback;
  const stored = window.localStorage?.getItem(key);
  return stored === "split" || stored === "unified" ? stored : fallback;
}

export function DiffViewer({
  patch,
  oldFile,
  newFile,
  viewMode = "unified",
  onViewModeChange,
  showToolbar = true,
  showLineNumbers = true,
  persistKey,
  maxHeight = 600,
  className,
}: DiffViewerProps) {
  const controlled = onViewModeChange !== undefined;
  const [internalMode, setInternalMode] = useState<ViewMode>(() =>
    readPersistedMode(persistKey, viewMode),
  );
  const mode = controlled ? viewMode : internalMode;
  const [collapsed, setCollapsed] = useState<Record<number, boolean>>({});

  const setMode = (next: ViewMode) => {
    if (persistKey && typeof window !== "undefined") window.localStorage?.setItem(persistKey, next);
    if (controlled) onViewModeChange!(next);
    else setInternalMode(next);
  };

  const parsedFiles = useMemo<ParsedFile[]>(() => {
    if (patch) return parsePatch(patch);
    if (oldFile?.content !== undefined && newFile?.content !== undefined) {
      const { lines, additions, deletions } = computeDiff(oldFile.content, newFile.content);
      return [{ oldName: oldFile.name, newName: newFile.name, lines, additions, deletions }];
    }
    return [];
  }, [patch, oldFile?.content, oldFile?.name, newFile?.content, newFile?.name]);

  const splitLinePairs = useMemo<SplitLinePair[][]>(
    () => (mode === "split" ? parsedFiles.map((file) => pairLinesForSplit(file.lines)) : []),
    [parsedFiles, mode],
  );

  if (parsedFiles.length === 0) {
    return (
      <div
        data-slot="diff-viewer"
        className={className}
        style={{
          border: `1px solid ${palette.border}`,
          borderRadius: 8,
          padding: 12,
          backgroundColor: palette.background,
          color: palette.hunkText,
          fontSize: 12,
        }}
      >
        Дифф пуст.
      </div>
    );
  }

  const totals = parsedFiles.reduce(
    (acc, file) => ({
      additions: acc.additions + file.additions,
      deletions: acc.deletions + file.deletions,
    }),
    { additions: 0, deletions: 0 },
  );

  return (
    <div data-slot="diff-viewer" data-view-mode={mode} className={className}>
      {showToolbar && (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: 8,
            marginBottom: 8,
            fontSize: 12,
          }}
        >
          <span className="text-muted-foreground">
            {parsedFiles.length} файл(ов), <span style={{ color: "#16a34a" }}>+{totals.additions}</span>{" "}
            <span style={{ color: "#dc2626" }}>−{totals.deletions}</span>
          </span>
          <div style={{ marginLeft: "auto", display: "flex" }}>
            {(["unified", "split"] as const).map((value, index) => (
              <button
                key={value}
                type="button"
                onClick={() => setMode(value)}
                aria-pressed={mode === value}
                className="border px-2 py-1 text-xs font-medium"
                style={{
                  borderRadius: index === 0 ? "4px 0 0 4px" : "0 4px 4px 0",
                  marginLeft: index === 0 ? 0 : -1,
                  backgroundColor: mode === value ? palette.headerBackground : "transparent",
                  color: mode === value ? "#fff" : undefined,
                }}
              >
                {value === "unified" ? "Inline" : "Side-by-side"}
              </button>
            ))}
          </div>
        </div>
      )}

      <div
        style={{
          border: `1px solid ${palette.border}`,
          borderRadius: 8,
          overflow: "hidden",
          backgroundColor: palette.background,
          maxHeight,
          overflowY: "auto",
        }}
      >
        {parsedFiles.map((file, fileIndex) => (
          <div
            key={`${file.oldName ?? ""}->${file.newName ?? ""}-${fileIndex}`}
            data-slot="diff-viewer-file"
            style={{
              borderTop: fileIndex === 0 ? undefined : `1px solid ${palette.border}`,
              contentVisibility: "auto",
              containIntrinsicSize: "auto 240px",
            } as React.CSSProperties}
          >
            <FileHeader
              file={file}
              collapsed={collapsed[fileIndex] === true}
              onToggle={() =>
                setCollapsed((current) => ({ ...current, [fileIndex]: current[fileIndex] !== true }))
              }
            />
            {collapsed[fileIndex] !== true && (
              <div data-slot="diff-viewer-content" style={{ overflowX: "auto" }}>
                <div
                  style={{
                    minWidth: mode === "split" ? undefined : "max-content",
                    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                    fontSize: 12,
                    lineHeight: "18px",
                  }}
                >
                  {mode === "split"
                    ? (splitLinePairs[fileIndex] ?? []).map((pair, pairIndex) => (
                        <DiffViewerSplitLine
                          key={pairIndex}
                          pair={pair}
                          showLineNumbers={showLineNumbers}
                        />
                      ))
                    : file.lines.map((line, lineIndex) => (
                        <DiffViewerLine key={lineIndex} line={line} showLineNumbers={showLineNumbers} />
                      ))}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

DiffViewer.displayName = "DiffViewer";

export type { ParsedLine, ParsedFile, SplitLinePair, ViewMode };
export { parsePatch, computeDiff, pairLinesForSplit };
export default DiffViewer;
