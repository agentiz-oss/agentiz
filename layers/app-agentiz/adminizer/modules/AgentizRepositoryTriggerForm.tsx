import React, { useEffect, useMemo, useState } from "react";
import axios from "axios";

/**
 * The config editor of `agentiz.repository.trigger` — the escape hatch
 * `NodeTypeDefinition.ui = { module }` exists for.
 *
 * The generated form can render strings and enums, and a repository is neither: what a person needs
 * here is the list of repositories actually connected to a project, which no JSON schema can carry.
 * Everything else stays ordinary inputs, so this component is a convenience over a config that is
 * fully writable by hand — the node works identically with `repositoryId` typed in as a string,
 * which is what an MCP agent does.
 *
 * The data comes from the repositories screen's own endpoints (`getProjects`,
 * `getProjectRepositories`), not from a new one: those already answer exactly this question and
 * already carry the project guard. Reusing them means the picker cannot show a project the person
 * may not see.
 */

const PREFIX = (window as any).routePrefix ?? "/dashboard";
const REPOS_URL = `${PREFIX}/agentiz-repos`;

const PUSHED = "agentiz.repository.pushed";
const CI_RUN = "agentiz.repository.ciRun";
const PACKAGE = "agentiz.repository.packagePublished";

interface NodeFormProps {
  config: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  readOnly?: boolean;
}

interface ProjectRow {
  id: string;
  name: string;
}

interface LinkRow {
  id: string;
  projectId: string;
  isActive: boolean;
  repository: {
    id: string;
    pathWithNamespace: string;
    provider: string;
    defaultBranch: string | null;
    webhook: { hookId?: string | null; lastError?: string | null } | null;
  } | null;
}

const FIELD = "flex flex-col gap-1 text-sm";
const LABEL = "text-xs font-medium text-muted-foreground";
const CONTROL = "w-full rounded border px-2 py-1 text-sm";

const AgentizRepositoryTriggerForm: React.FC<NodeFormProps> = ({ config, onChange, readOnly }) => {
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [links, setLinks] = useState<LinkRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  const event = String(config.event ?? PUSHED);
  const projectId = String(config.projectId ?? "");
  const repositoryId = String(config.repositoryId ?? "");
  const isCi = event === CI_RUN;
  const isPackage = event === PACKAGE;

  const set = (patch: Record<string, unknown>) => onChange({ ...config, ...patch });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [projectsRes, linksRes] = await Promise.all([
          axios.get(REPOS_URL, { params: { _method: "getProjects" } }),
          axios.get(REPOS_URL, { params: { _method: "getProjectRepositories" } }),
        ]);
        if (cancelled) return;
        setProjects(projectsRes.data?.data ?? []);
        setLinks(linksRes.data?.data ?? []);
      } catch (e: any) {
        if (!cancelled) setError(e?.response?.data?.message ?? "Не удалось загрузить список репозиториев");
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // An empty project means "any", so the picker then offers every repository the person can see —
  // the same rule the node itself applies to the event stream.
  const options = useMemo(
    () => links.filter((link) => link.isActive && link.repository && (!projectId || link.projectId === projectId)),
    [links, projectId],
  );

  const selected = options.find((link) => link.repository?.id === repositoryId)?.repository ?? null;

  return (
    <div className="flex flex-col gap-3">
      {error && (
        <div className="rounded border p-2 text-xs" style={{ borderColor: "#fecaca", backgroundColor: "#fef2f2", color: "#b91c1c" }}>
          {error}. Поля ниже всё равно работают — id можно вписать строкой.
        </div>
      )}

      <label className={FIELD}>
        <span className={LABEL}>Событие</span>
        <select className={CONTROL} disabled={readOnly} value={event} onChange={(e) => set({ event: e.target.value })}>
          <option value={PUSHED}>В ветку пришли коммиты</option>
          <option value={CI_RUN}>Завершился CI-прогон</option>
          <option value={PACKAGE}>Опубликован пакет (образ)</option>
        </select>
      </label>

      <label className={FIELD}>
        <span className={LABEL}>Проект</span>
        <select
          className={CONTROL}
          disabled={readOnly}
          value={projectId}
          // Changing the project drops the repository: keeping an id from the previous project
          // would leave a node that filters on a pair which can never occur, and looks configured.
          onChange={(e) => set({ projectId: e.target.value, repositoryId: "" })}
        >
          <option value="">любой проект</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>{project.name}</option>
          ))}
        </select>
      </label>

      <label className={FIELD}>
        <span className={LABEL}>Репозиторий</span>
        <select className={CONTROL} disabled={readOnly} value={repositoryId} onChange={(e) => set({ repositoryId: e.target.value })}>
          <option value="">любой репозиторий проекта</option>
          {options.map((link) => (
            <option key={link.id} value={link.repository!.id}>
              {link.repository!.pathWithNamespace} ({link.repository!.provider})
            </option>
          ))}
        </select>
        {repositoryId && !selected && (
          <span className="text-xs" style={{ color: "#b45309" }}>
            Репозиторий {repositoryId} не найден среди подключённых — id сохранён как есть.
          </span>
        )}
        {/* The one thing a person cannot find out anywhere else: whether this repository is on the
            fast path or waiting up to 15 minutes for the poll. */}
        {selected && !selected.webhook?.hookId && (
          <span className="text-xs" style={{ color: "#b45309" }}>
            Вебхук не установлен{selected.webhook?.lastError ? `: ${selected.webhook.lastError}` : ""} —
            события приходят опросом, с задержкой до 15 минут.
          </span>
        )}
      </label>

      {!isPackage && (
      <label className={FIELD}>
        <span className={LABEL}>Ветки</span>
        <input
          className={CONTROL}
          disabled={readOnly}
          placeholder={selected?.defaultBranch ? `${selected.defaultBranch}, release/*` : "main, release/*"}
          value={String(config.branches ?? "")}
          onChange={(e) => set({ branches: e.target.value })}
        />
        <span className="text-xs text-muted-foreground">Маски через запятую. Пусто = любая ветка.</span>
      </label>
      )}

      {isPackage && (
        <>
          <label className={FIELD}>
            <span className={LABEL}>Пакет</span>
            <input
              className={CONTROL}
              disabled={readOnly}
              placeholder="api, *-worker"
              value={String(config.packageName ?? "")}
              onChange={(e) => set({ packageName: e.target.value })}
            />
            <span className="text-xs text-muted-foreground">Маски через запятую. Пусто = любой пакет.</span>
          </label>
          <label className={FIELD}>
            <span className={LABEL}>Тег образа</span>
            <input
              className={CONTROL}
              disabled={readOnly}
              placeholder="latest, v*"
              value={String(config.tag ?? "")}
              onChange={(e) => set({ tag: e.target.value })}
            />
            <span className="text-xs text-muted-foreground">
              Пусто = любой тег. Пакет без тега под непустую маску не подходит.
            </span>
          </label>
          {/* The one thing about this event a person cannot see anywhere else: it has no poll
              behind it, so the state of the hook is not a matter of latency but of whether the
              event arrives at all. */}
          <div className="text-xs" style={{ color: "#b45309" }}>
            У этого события нет опроса — только вебхук. Пакет должен быть привязан к репозиторию
            (публикацией из его workflow или меткой org.opencontainers.image.source), иначе
            событие уходит на уровень организации и в этот хук не попадает.
          </div>
        </>
      )}

      {isCi && (
        <>
          <label className={FIELD}>
            <span className={LABEL}>Исход CI</span>
            <input
              className={CONTROL}
              disabled={readOnly}
              placeholder="failure"
              value={String(config.conclusion ?? "")}
              onChange={(e) => set({ conclusion: e.target.value })}
            />
            <span className="text-xs text-muted-foreground">
              success, failure, cancelled, timed_out, skipped, neutral, action_required, stale. Пусто = любой.
            </span>
          </label>
          <label className={FIELD}>
            <span className={LABEL}>Название CI-воркфлоу</span>
            <input
              className={CONTROL}
              disabled={readOnly}
              value={String(config.workflowName ?? "")}
              onChange={(e) => set({ workflowName: e.target.value })}
            />
          </label>
        </>
      )}

      {!isPackage && (
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          disabled={readOnly}
          // Undefined is a meaningful third state — "как по умолчанию для этого события" — and the
          // default differs between the two events, so the box shows the resolved value while the
          // config keeps saying nothing until somebody actually touches it.
          checked={config.ignoreOwnRuns === undefined ? !isCi : config.ignoreOwnRuns !== false}
          onChange={(e) => set({ ignoreOwnRuns: e.target.checked })}
        />
        <span>
          Пропускать события собственных запусков
          <span className="block text-xs text-muted-foreground">
            {isCi
              ? "Для CI обычно выключено: упавшая сборка нашей же ветки — это и есть повод для доработки."
              : "Для пуша обычно включено, иначе граф кормит сам себя."}
          </span>
        </span>
      </label>
      )}
    </div>
  );
};

export default AgentizRepositoryTriggerForm;
