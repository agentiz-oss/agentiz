import React, { useCallback, useEffect, useMemo, useState } from "react";
import axios from "axios";
import { formatDateTime, useViewerTimezone } from "./lib/viewerTime";

/**
 * Who takes part in a project, and in what role.
 *
 * The screen does three things and nothing else: add a person, change their role, take them out.
 * It edits **only** membership rows — never a group and never a group's tokens — so handing out
 * access here can never change what a role means in another project, nor take somebody's access to
 * an unrelated part of the panel away. A role that does not exist yet is created once in the
 * panel's own group editor and is then offered here for every project.
 *
 * The role list is a ladder in the GitLab sense: each step carries everything the one above it
 * carries. That is what makes "повысить" a choice of row rather than a comparison of checkboxes,
 * and it is also why a group whose token set matches no step is shown as «Особая роль» — the words
 * mean "не совпало ни с одной ступенью", not "непонятно что".
 *
 * Deliberately absent, and not by accident (see .ai-notes/project-members-and-roles-plan.md §8.1):
 * no invitation by e-mail, no expiry date on a membership, no access requests, no group as a
 * member. Each of those changes `projectAccess.ts` rather than this file — the place where being
 * wrong means the wrong answer to "есть ли право".
 */

interface Person {
  id: number;
  login: string | null;
  fullName: string | null;
  email: string | null;
  avatar: string | null;
}

interface Member {
  id: string;
  userId: number;
  user: Person | null;
  groupId: number;
  groupName: string | null;
  presetKey: string | null;
  tokens: string[];
  grantedBy: Person | null;
  createdAt: string;
  isOwner: boolean;
}

interface Role {
  id: number;
  name: string;
  description: string | null;
  presetKey: string | null;
}

interface Preset {
  key: string;
  name: string;
  description: string;
}

interface Meta {
  canManage: boolean;
  owner: Person | null;
  ownerRoleName: string;
  presets: Preset[];
  roles: Role[];
}

interface Project {
  id: string;
  name: string;
  slug: string;
}

const PREFIX = (window as any).routePrefix ?? "/dashboard";
const API_URL = `${PREFIX}/agentiz-members`;
const PROJECTS_URL = `${PREFIX}/agentiz`;

const personName = (person: Person | null): string =>
  person?.fullName || person?.login || (person ? `#${person.id}` : "—");

/** The step of the ladder a role is, or the honest "не совпало". */
const roleLabel = (presets: Preset[], presetKey: string | null, groupName: string | null): string => {
  const preset = presets.find((item) => item.key === presetKey);
  if (preset) return preset.name;
  return groupName ? `${groupName} · Особая роль` : "Особая роль";
};

const AgentizMembers: React.FC = () => {
  useViewerTimezone();
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState("");
  const [members, setMembers] = useState<Member[]>([]);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [inviteOpen, setInviteOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState<Person[]>([]);
  const [searched, setSearched] = useState(false);
  const [pickedUserId, setPickedUserId] = useState<number | null>(null);
  const [pickedGroupId, setPickedGroupId] = useState<number | null>(null);

  const project = useMemo(() => projects.find((item) => item.id === projectId) ?? null, [projects, projectId]);
  const withProject = (path: string) => `${PREFIX}${path}${projectId ? `?projectId=${projectId}` : ""}`;

  const fetchProjects = useCallback(async () => {
    const res = await axios.get(PROJECTS_URL, { params: { _method: "getProjects" } });
    const items: Project[] = res.data?.data ?? [];
    setProjects(items);
    // `?projectId=` is how every link into this screen names its project; without it the first
    // project in the list is somebody else's.
    const preset = new URLSearchParams(window.location.search).get("projectId");
    const initial = items.find((item) => item.id === preset)?.id ?? items[0]?.id;
    if (initial) setProjectId((current) => current || initial);
  }, []);

  const fetchMembers = useCallback(async (id: string) => {
    if (!id) {
      setMembers([]);
      setMeta(null);
      return;
    }
    const res = await axios.get(API_URL, { params: { _method: "list", projectId: id } });
    setMembers(res.data?.data ?? []);
    setMeta(res.data?.meta ?? null);
  }, []);

  useEffect(() => {
    void fetchProjects().catch((e: any) => setError(e?.response?.data?.message ?? "Не удалось загрузить проекты"));
  }, [fetchProjects]);

  useEffect(() => {
    setError(null);
    void fetchMembers(projectId).catch((e: any) =>
      setError(e?.response?.data?.message ?? "Не удалось загрузить участников"));
  }, [projectId, fetchMembers]);

  const post = useCallback(async (payload: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await axios.post(API_URL, payload);
      await fetchMembers(projectId);
    } catch (e: any) {
      setError(e?.response?.data?.message ?? "Запрос не удался");
    } finally {
      setBusy(false);
    }
  }, [projectId, fetchMembers]);

  const search = useCallback(async () => {
    setBusy(true);
    try {
      const res = await axios.get(API_URL, { params: { _method: "candidates", projectId, q: query } });
      setCandidates(res.data?.data ?? []);
      setSearched(true);
    } catch (e: any) {
      setError(e?.response?.data?.message ?? "Поиск не удался");
    } finally {
      setBusy(false);
    }
  }, [projectId, query]);

  const canManage = Boolean(meta?.canManage);
  const roles = meta?.roles ?? [];
  const presets = meta?.presets ?? [];

  return (
    <div className="space-y-6 p-6">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Участники</h1>
          <p className="text-sm text-muted-foreground">
            Кто работает в проекте и что ему можно. Роль — это обычная группа панели; здесь
            меняется только то, кому она выдана в этом проекте.
          </p>
        </div>
        <a href={withProject("/agentiz")} className="text-xs underline">← к проекту</a>
      </div>

      {error && (
        <div className="rounded border p-3 text-sm" style={{ borderColor: "#fecaca", backgroundColor: "#fef2f2", color: "#b91c1c" }}>
          {error}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <label className="text-sm text-muted-foreground">Проект</label>
        <select
          className="rounded border px-2 py-1 text-sm"
          value={projectId}
          onChange={(event) => setProjectId(event.target.value)}
        >
          {projects.map((item) => (
            <option key={item.id} value={item.id}>{item.name}</option>
          ))}
        </select>
        {canManage && (
          <button
            type="button"
            className="rounded border px-3 py-1 text-sm hover:bg-primary/5"
            disabled={busy || !projectId}
            onClick={() => { setInviteOpen(true); setCandidates([]); setSearched(false); setQuery(""); setPickedUserId(null); setPickedGroupId(null); }}
          >
            Пригласить
          </button>
        )}
      </div>

      {project && members.length === 0 && (
        <div className="rounded-lg border p-4 text-sm text-muted-foreground">
          В проекте только владелец. Добавьте тестировщика, чтобы ему приходили заявки на приёмку.
        </div>
      )}

      {members.length > 0 && (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                <th className="p-3">Человек</th>
                <th className="p-3">Роль</th>
                <th className="p-3">Кто и когда выдал</th>
                <th className="p-3" />
              </tr>
            </thead>
            <tbody>
              {members.map((member) => (
                <tr key={member.id} className="border-b last:border-0">
                  <td className="p-3">
                    <div className="font-medium">{personName(member.user)}</div>
                    <div className="text-xs text-muted-foreground">{member.user?.email ?? member.user?.login ?? ""}</div>
                    {member.isOwner && (
                      <span className="mt-1 inline-block rounded px-2 py-0.5 text-[11px]" style={{ backgroundColor: "#e0e7ff", color: "#3730a3" }}>
                        владелец
                      </span>
                    )}
                  </td>
                  <td className="p-3">
                    {canManage && !member.isOwner ? (
                      <select
                        className="rounded border px-2 py-1 text-sm"
                        value={member.groupId}
                        disabled={busy}
                        onChange={(event) => void post({ _method: "setRole", memberId: member.id, groupId: Number(event.target.value) })}
                      >
                        {roles.map((role) => (
                          <option key={role.id} value={role.id}>{roleLabel(presets, role.presetKey, role.name)}</option>
                        ))}
                      </select>
                    ) : (
                      <span>{roleLabel(presets, member.presetKey, member.groupName)}</span>
                    )}
                    <div className="mt-1 text-[11px] text-muted-foreground">
                      {/* The tokens themselves, because "роль" is otherwise a name with no content. */}
                      {member.tokens.filter((token) => token.startsWith("agentiz-")).join(" · ") || "—"}
                    </div>
                  </td>
                  <td className="p-3 text-xs text-muted-foreground">
                    {member.grantedBy ? personName(member.grantedBy) : "—"}
                    <div>{formatDateTime(member.createdAt)}</div>
                  </td>
                  <td className="p-3 text-right">
                    {canManage && !member.isOwner && (
                      <button
                        type="button"
                        className="rounded border px-2 py-1 text-xs hover:bg-primary/5"
                        disabled={busy}
                        onClick={() => void post({ _method: "removeMember", memberId: member.id })}
                      >
                        Убрать
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {inviteOpen && (
        <div className="rounded-lg border p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold">Пригласить в проект</h2>
            <button type="button" className="text-xs underline" onClick={() => setInviteOpen(false)}>закрыть</button>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <input
              className="min-w-[240px] flex-1 rounded border px-2 py-1 text-sm"
              placeholder="Логин, имя или почта"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") void search(); }}
            />
            <button type="button" className="rounded border px-3 py-1 text-sm hover:bg-primary/5" disabled={busy} onClick={() => void search()}>
              Найти
            </button>
          </div>

          {searched && candidates.length === 0 && (
            <div className="mt-3 text-sm text-muted-foreground">
              Такого пользователя нет — заведите его в разделе пользователей панели. Приглашений по
              почте здесь нет: в проект добавляется только тот, у кого уже есть учётная запись.
            </div>
          )}

          {candidates.length > 0 && (
            <div className="mt-3 space-y-2">
              <div className="max-h-64 overflow-y-auto rounded border">
                {candidates.map((person) => (
                  <button
                    key={person.id}
                    type="button"
                    className={`block w-full border-b p-2 text-left text-sm last:border-0 hover:bg-primary/5 ${pickedUserId === person.id ? "bg-primary/10" : ""}`}
                    onClick={() => setPickedUserId(person.id)}
                  >
                    <span className="font-medium">{personName(person)}</span>
                    <span className="ml-2 text-xs text-muted-foreground">{person.email ?? person.login ?? ""}</span>
                  </button>
                ))}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <label className="text-sm text-muted-foreground">Роль</label>
                <select
                  className="rounded border px-2 py-1 text-sm"
                  value={pickedGroupId ?? ""}
                  onChange={(event) => setPickedGroupId(Number(event.target.value))}
                >
                  <option value="">— выберите —</option>
                  {roles.map((role) => (
                    <option key={role.id} value={role.id}>{roleLabel(presets, role.presetKey, role.name)}</option>
                  ))}
                </select>
                <button
                  type="button"
                  className="rounded border px-3 py-1 text-sm hover:bg-primary/5"
                  disabled={busy || pickedUserId === null || pickedGroupId === null}
                  onClick={async () => {
                    await post({ _method: "addMember", projectId, userId: pickedUserId, groupId: pickedGroupId });
                    setInviteOpen(false);
                  }}
                >
                  Добавить
                </button>
              </div>
              {roles.length === 0 && (
                <div className="text-xs text-muted-foreground">
                  Ни одной группы-роли не найдено. Роли заводятся один раз в разделе групп панели и
                  после этого доступны всем проектам.
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {meta && !canManage && (
        <div className="text-xs text-muted-foreground">
          Состав участников виден, но менять его может тот, у кого есть право «Проект: участники» —
          в лестнице ролей оно появляется у мейнтейнера.
        </div>
      )}
    </div>
  );
};

export default AgentizMembers;
