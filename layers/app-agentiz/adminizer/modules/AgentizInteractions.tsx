import React, { useCallback, useEffect, useState } from "react";
import axios from "axios";
import { formatDateTime, useViewerTimezone } from "./lib/viewerTime";
import { humanInputChoices, missingHumanInputChoice, selectedHumanInputChoice, type HumanInputField } from "./humanInputSchema";

type Field = HumanInputField;
type PendingInteraction = {
  id: string;
  runId: string;
  message: string;
  source: string;
  createdAt?: string;
  requestedSchema: { properties?: Record<string, Field>; required?: string[] };
  project?: { name?: string } | null;
  task?: { title?: string } | null;
  stage?: { stageIndex?: number; role?: string } | null;
};

const PREFIX = (window as any).routePrefix ?? "/dashboard";
const API_URL = `${PREFIX}/agentiz-interactions`;

const AgentizInteractions: React.FC = () => {
  useViewerTimezone();
  const [items, setItems] = useState<PendingInteraction[]>([]);
  const [answers, setAnswers] = useState<Record<string, Record<string, unknown>>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await axios.get(API_URL, { params: { _method: "listPending" } });
      const next: PendingInteraction[] = response.data?.data ?? [];
      setItems(next);
      setAnswers((current: Record<string, Record<string, unknown>>): Record<string, Record<string, unknown>> => {
        const merged = { ...current };
        for (const interaction of next) {
          if (merged[interaction.id]) continue;
          const initial: Record<string, unknown> = {};
          for (const [name, field] of Object.entries(interaction.requestedSchema?.properties ?? {})) {
            initial[name] = field.default !== undefined ? field.default : field.type === "boolean" ? false : "";
          }
          merged[interaction.id] = initial;
        }
        return merged;
      });
      setError(null);
    } catch (e: any) {
      setError(e?.response?.data?.message ?? "Не удалось загрузить вопросы");
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval((): void => { void load(); }, 2500);
    return (): void => { window.clearInterval(timer); };
  }, [load]);

  const answer = useCallback(async (interaction: PendingInteraction, action: "accept" | "decline" | "cancel") => {
    const content = answers[interaction.id] ?? {};
    const missingChoice = action === "accept" ? missingHumanInputChoice(interaction.requestedSchema.properties, content) : null;
    if (missingChoice) {
      setError(`Выберите вариант для поля «${missingChoice}» или заполните поле Other.`);
      return;
    }
    setBusy(interaction.id);
    setError(null);
    try {
      await axios.post(API_URL, {
        _method: "answerInteraction",
        interactionId: interaction.id,
        action,
        content: action === "accept" ? content : null,
      });
      await load();
    } catch (e: any) {
      setError(e?.response?.data?.message ?? "Не удалось отправить ответ");
    } finally {
      setBusy(null);
    }
  }, [answers, load]);

  const change = (interactionId: string, name: string, value: unknown) => {
    setAnswers((all) => ({ ...all, [interactionId]: { ...all[interactionId], [name]: value } }));
  };

  return (
    <div className="space-y-4 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Нужен ответ</h1>
          <p className="text-sm text-muted-foreground">Вопросы работающих агентов из доступных вам проектов.</p>
        </div>
        <a href={`${PREFIX}/agentiz-tasks`} className="text-sm underline">← к задачам</a>
      </div>

      {error && <div className="rounded border p-3 text-sm" style={{ borderColor: "#fecaca", backgroundColor: "#fef2f2", color: "#b91c1c" }}>{error}</div>}
      {items.length === 0 && !error && (
        <div className="rounded-lg border p-6 text-sm text-muted-foreground">Сейчас ни один агент не ждёт ответа.</div>
      )}
      <ul className="space-y-4">
        {items.map((interaction) => (
          <li key={interaction.id} className="rounded-lg border p-4" style={{ borderColor: "#fdba74", backgroundColor: "#fff7ed" }}>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span className="rounded px-2 py-0.5 font-medium" style={{ backgroundColor: "#ffedd5", color: "#c2410c" }}>waiting_input</span>
              <span>{interaction.project?.name ?? "Проект"}</span>
              <span>· {interaction.task?.title ?? "Задача"}</span>
              <span>· #{interaction.stage?.stageIndex ?? "?"} {interaction.stage?.role ?? "стадия"}</span>
              <span>· {interaction.source} · {formatDateTime(interaction.createdAt)}</span>
              <a href={`${PREFIX}/agentiz-runs?runId=${interaction.runId}`} className="underline">открыть запуск</a>
            </div>
            <p className="mt-3 whitespace-pre-wrap text-sm font-medium">{interaction.message}</p>
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              {Object.entries(interaction.requestedSchema?.properties ?? {}).map(([name, field]) => {
                const value = answers[interaction.id]?.[name];
                const choices = humanInputChoices(field);
                return (
                  <label key={name} className="block text-xs">
                    <span className="block font-medium">{field.title ?? name}{interaction.requestedSchema.required?.includes(name) ? " *" : ""}</span>
                    {field.description && <span className="block text-muted-foreground">{field.description}</span>}
                    {choices.length > 0 ? (
                      <select value={selectedHumanInputChoice(choices, value)} onChange={(event) => {
                        const index = Number(event.target.value);
                        change(interaction.id, name, Number.isInteger(index) && choices[index] ? choices[index].value : "");
                      }} className="mt-1 w-full rounded border px-2 py-1.5 text-sm">
                        <option value="">Выберите…</option>
                        {choices.map((choice, index) => <option key={String(index)} value={String(index)}>{choice.label}</option>)}
                      </select>
                    ) : field.type === "boolean" ? (
                      <input type="checkbox" checked={Boolean(value)} onChange={(event) => change(interaction.id, name, event.target.checked)} className="mt-2" />
                    ) : (
                      <input
                        type={field.type === "number" || field.type === "integer" ? "number" : "text"}
                        value={String(value ?? "")}
                        onChange={(event) => {
                          const raw = event.target.value;
                          change(interaction.id, name, field.type === "number" || field.type === "integer" ? (raw === "" ? "" : Number(raw)) : raw);
                        }}
                        className="mt-1 w-full rounded border px-2 py-1.5 text-sm"
                      />
                    )}
                  </label>
                );
              })}
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <button onClick={() => answer(interaction, "accept")} disabled={busy === interaction.id} className="rounded border px-3 py-1.5 text-sm font-medium disabled:opacity-50">Ответить</button>
              <button onClick={() => answer(interaction, "decline")} disabled={busy === interaction.id} className="rounded border px-3 py-1.5 text-sm disabled:opacity-50">Отказаться</button>
              <button onClick={() => answer(interaction, "cancel")} disabled={busy === interaction.id} className="rounded border px-3 py-1.5 text-sm disabled:opacity-50">Отменить запрос</button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
};

export default AgentizInteractions;
