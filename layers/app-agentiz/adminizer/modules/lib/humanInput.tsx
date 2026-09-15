import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  humanInputChoices,
  missingHumanInputChoice,
  selectedHumanInputChoice,
  type HumanInputField,
} from '../humanInputSchema';
import { formatDateTime } from './viewerTime';
import { ago } from './format';
import { toast } from './ui';

/**
 * The form an agent's question is answered through.
 *
 * One form, not one per screen: the run screen and «Входящие» ask the same thing, and the schema
 * comes from the agent either way. There used to be two copies — `AgentizRunDetail` and the whole
 * of `AgentizInteractions`, both deleted in stage 9 of the panel rework — and they had already
 * drifted into disagreeing about what an unanswered choice does, which is the argument for keeping
 * this one. Everything the shape of an answer needs is in `humanInputSchema.ts`; that file stays
 * the only place that knows how an ACP agent spells a choice.
 *
 * The write is `answerInteraction` on the run route, which predates this screen: the panel gains
 * no new verb for answering, only a second place that offers it.
 */

export interface RunInteraction {
  id: string;
  stageExecutionId: string;
  source: string;
  message: string;
  requestedSchema: {
    type: 'object';
    properties?: Record<string, HumanInputField>;
    required?: string[];
  };
  status: string;
  responseAction?: 'accept' | 'decline' | 'cancel' | null;
  responseContent?: Record<string, unknown> | null;
  answeredByName?: string | null;
  answeredAt?: string | null;
  deliveredAt?: string | null;
  createdAt?: string;
}

const PREFIX: string = (window as any).routePrefix ?? '/dashboard';
const axios = (window as any).axios;

/** What an empty form starts as: the schema's own defaults, then a type-appropriate blank. */
function defaultsOf(interaction: RunInteraction): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(interaction.requestedSchema?.properties ?? {})) {
    if (field.default !== undefined) values[name] = field.default;
    else if (field.type === 'boolean') values[name] = false;
    else values[name] = '';
  }
  return values;
}

function Field({
  name,
  field,
  required,
  value,
  onChange,
}: {
  name: string;
  field: HumanInputField;
  required: boolean;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const choices = humanInputChoices(field);
  const label = field.title ?? name;

  return (
    <div className="space-y-1.5">
      <label className="block text-xs font-medium">
        {label}
        {required ? ' *' : ''}
      </label>
      {field.description && <p className="text-xs text-muted-foreground">{field.description}</p>}
      {choices.length > 0 ? (
        <Select
          value={selectedHumanInputChoice(choices, value)}
          onValueChange={(index: string) => onChange(choices[Number(index)]?.value ?? '')}
        >
          {/* No empty-valued item: Radix refuses one, so "ничего не выбрано" is the placeholder. */}
          <SelectTrigger size="sm" className="w-full"><SelectValue placeholder="Выберите…" /></SelectTrigger>
          <SelectContent>
            {choices.map((choice, index) => (
              <SelectItem key={String(index)} value={String(index)}>{choice.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : field.type === 'boolean' ? (
        <Checkbox checked={Boolean(value)} onCheckedChange={(checked: boolean) => onChange(checked === true)} />
      ) : (
        <Input
          type={field.type === 'number' || field.type === 'integer' ? 'number' : 'text'}
          value={String(value ?? '')}
          onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
            const raw = event.target.value;
            onChange(field.type === 'number' || field.type === 'integer' ? (raw === '' ? '' : Number(raw)) : raw);
          }}
        />
      )}
    </div>
  );
}

export function HumanInputForm({
  interaction,
  onAnswered,
}: {
  interaction: RunInteraction;
  onAnswered: () => void | Promise<void>;
}) {
  const [content, setContent] = React.useState<Record<string, unknown>>(() => defaultsOf(interaction));
  const [busy, setBusy] = React.useState(false);
  const properties = Object.entries(interaction.requestedSchema?.properties ?? {});

  const answer = async (action: 'accept' | 'decline' | 'cancel') => {
    if (action === 'accept') {
      // Codex marks a choice optional so a sibling `__other` may stand in for it; submitting
      // neither sends an empty string that the server's Ajv correctly rejects.
      const missing = missingHumanInputChoice(interaction.requestedSchema.properties, content);
      if (missing) {
        toast.error(`Выберите вариант для поля «${missing}» или заполните поле Other.`);
        return;
      }
    }
    setBusy(true);
    try {
      await axios.post(`${PREFIX}/agentiz-runs`, {
        _method: 'answerInteraction',
        interactionId: interaction.id,
        action,
        // The answer is the schema's own fields and nothing else: the agent validates what comes
        // back against the schema it sent, so a key this form invented would be refused.
        content: action === 'accept' ? content : null,
      });
      toast.success(action === 'accept' ? 'Ответ отправлен агенту' : 'Запрос закрыт');
      await onAnswered();
    } catch (error: any) {
      toast.error(error?.response?.data?.message ?? 'Не удалось отправить ответ');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <p className="whitespace-pre-wrap text-sm">{interaction.message}</p>
        <span className="shrink-0 text-xs text-muted-foreground">{ago(interaction.createdAt ?? null)}</span>
      </div>

      <div className="space-y-3">
        {properties.map(([name, field]) => (
          <Field
            key={name}
            name={name}
            field={field}
            required={interaction.requestedSchema.required?.includes(name) ?? false}
            value={content[name]}
            onChange={(value) => setContent((current) => ({ ...current, [name]: value }))}
          />
        ))}
      </div>

      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={busy} onClick={() => answer('accept')}>Ответить</Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => answer('decline')}>Отказаться</Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => answer('cancel')}>Отменить запрос</Button>
      </div>
    </div>
  );
}

/** An already-answered request, as a record of who said what. Never editable. */
export function AnsweredInput({ interaction }: { interaction: RunInteraction }) {
  return (
    <div className="rounded-md bg-muted/40 p-2 text-xs">
      Ответ: <strong>{interaction.responseAction}</strong>
      {interaction.responseContent && (
        <pre className="mt-1 whitespace-pre-wrap">{JSON.stringify(interaction.responseContent, null, 2)}</pre>
      )}
      {interaction.answeredByName && (
        <div className="text-muted-foreground">
          {interaction.answeredByName} · {formatDateTime(interaction.answeredAt)}
          {interaction.deliveredAt ? ` · доставлен ${formatDateTime(interaction.deliveredAt)}` : ''}
        </div>
      )}
    </div>
  );
}
