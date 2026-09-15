import { Op } from 'sequelize';
import type { Model, ModelStatic, Sequelize } from 'sequelize';
import { AgentProject } from '../../models/AgentProject';
import { AgentProjectMember } from '../../models/AgentProjectMember';
import { AgentRole } from '../../models/AgentRole';
import { AgentTaskSource } from '../../models/AgentTaskSource';
import { can, type AccessActor, type AccessCache } from '../access/projectAccess';
import { PROJECT_TOKENS, ROLE_PRESETS, ownerRolePreset } from '../access/tokens';
import { maskProjectForUI, maskTaskSourceForUI } from '../secrets';
import { describeTaskManagers, getTaskManagerAdapter } from '../taskManager';

/**
 * What the four sections of a project's settings are made of, on the server.
 *
 * Its own file rather than functions inside the route tables, for the reason `runBoard.ts` and
 * `workerBoard.ts` exist: `lib/panel/render.ts` paints the first frame and must not import a route
 * table to do it, and the answer a screen re-reads after a write has to be built by the code that
 * painted it. `memberRoutes` therefore answers `_method=list` *through* `projectMembersView`
 * rather than beside it — one builder, two callers, no second shape.
 *
 * Nothing here decides anything about rights. The caller has already resolved the project (and
 * with it `agentiz-project-read`); what each section additionally needs to be *edited* travels as
 * a flag beside the data, because a reader of a project is supposed to see what it is configured
 * with — «Настройки» that answer 403 to a person who can read the project would hide the reason
 * their runs behave the way they do.
 */

/** Only what a person-picker needs; a member list is not a way to read the user table. */
export interface PanelPerson {
  id: number;
  login: string | null;
  fullName: string | null;
  email: string | null;
  avatar: string | null;
}

export interface PanelMemberRow {
  id: string;
  userId: number;
  user: PanelPerson | null;
  groupId: number;
  groupName: string | null;
  presetKey: string | null;
  tokens: string[];
  grantedBy: PanelPerson | null;
  createdAt: Date;
  isOwner: boolean;
}

export interface PanelMembersMeta {
  canManage: boolean;
  owner: PanelPerson | null;
  ownerRoleName: string;
  presets: Array<{ key: string; name: string; description: string }>;
  roles: Array<{ id: unknown; name: unknown; description: unknown; presetKey: string | null }>;
}

export interface PanelMembersView {
  items: PanelMemberRow[];
  meta: PanelMembersMeta;
}

function systemModel(name: string): ModelStatic<Model> | null {
  const sequelize = AgentProjectMember.sequelize as Sequelize | undefined;
  if (!sequelize || !sequelize.isDefined(name)) return null;
  return sequelize.model(name) as ModelStatic<Model>;
}

function plain(record: Model | null | undefined): Record<string, unknown> | null {
  return record ? (record.get({ plain: true }) as Record<string, unknown>) : null;
}

function publicUser(user: Record<string, unknown> | null): PanelPerson | null {
  if (!user) return null;
  return {
    id: user.id as number,
    login: (user.login as string) ?? null,
    fullName: (user.fullName as string) ?? null,
    email: (user.email as string) ?? null,
    avatar: (user.avatar as string) ?? null,
  };
}

const tokensOf = (group: Record<string, unknown> | null): string[] =>
  Array.isArray(group?.tokens)
    ? (group!.tokens as unknown[])
        .map((grant) => (typeof grant === 'string' ? grant : (grant as any)?.tokenId))
        .filter((token): token is string => typeof token === 'string')
        .map((token) => token.toLowerCase())
    : [];

/**
 * Which rung of the ladder a group is, by comparing token sets. A group whose set matches no
 * preset is labelled «Особая роль» rather than guessed at — and because each preset contains the
 * previous one, "matches" can only be the exact set, never a prefix.
 */
function presetKeyOf(group: Record<string, unknown> | null): string | null {
  const tokens = new Set(tokensOf(group));
  for (const preset of ROLE_PRESETS) {
    if (preset.tokens.length !== tokens.size) continue;
    if (preset.tokens.every((token) => tokens.has(token))) return preset.key;
  }
  return null;
}

async function loadGroups(): Promise<Record<string, unknown>[]> {
  const Group = systemModel('GroupAP');
  if (!Group) return [];
  const groups = await Group.findAll({ order: [['name', 'ASC']] });
  return groups.map((group) => plain(group)!).filter(Boolean);
}

async function loadUsers(ids: number[]): Promise<Map<number, Record<string, unknown>>> {
  const User = systemModel('UserAP');
  if (!User || ids.length === 0) return new Map();
  const users = await User.findAll({ where: { id: ids as any } });
  return new Map(users.map((user) => {
    const row = plain(user)!;
    return [Number(row.id), row];
  }));
}

/** The candidate list of the invite picker. Deliberately not a directory: 20 rows, by substring. */
export async function memberCandidates(query: string): Promise<PanelPerson[]> {
  const User = systemModel('UserAP');
  if (!User) return [];
  // No e-mail invitations: a person is added only if they already have a panel account, and an
  // empty result says so instead of offering to create one.
  const where = query
    ? {
        [Op.or]: [
          { login: { [Op.like]: `%${query}%` } },
          { fullName: { [Op.like]: `%${query}%` } },
          { email: { [Op.like]: `%${query}%` } },
        ],
      }
    : {};
  const users = await User.findAll({ where: where as any, order: [['login', 'ASC']], limit: 20 });
  return users.map((user) => publicUser(plain(user))!);
}

/** Who takes part in the project and in what role. `null` when the project itself is gone. */
export async function projectMembersView(
  projectId: string,
  actor: AccessActor,
  cache?: AccessCache,
): Promise<PanelMembersView | null> {
  const project = await AgentProject.findByPk(projectId);
  if (!project) return null;

  const rows = await AgentProjectMember.findAll({ where: { projectId }, order: [['createdAt', 'ASC']] });
  const groups = await loadGroups();
  const groupById = new Map(groups.map((group) => [Number(group.id), group]));
  const users = await loadUsers([
    ...new Set([
      ...rows.map((row) => Number(row.userId)),
      ...rows.map((row) => Number(row.grantedByUserId)).filter(Number.isFinite),
      ...(project.ownerId !== null ? [Number(project.ownerId)] : []),
    ]),
  ]);

  const canManage = await can(actor, projectId, PROJECT_TOKENS.projectMembers, cache);

  return {
    items: rows.map((row) => {
      const group = groupById.get(Number(row.groupId)) ?? null;
      return {
        id: row.id,
        userId: row.userId,
        user: publicUser(users.get(Number(row.userId)) ?? null),
        groupId: row.groupId,
        groupName: (group?.name as string) ?? null,
        presetKey: presetKeyOf(group),
        tokens: tokensOf(group),
        grantedBy: publicUser(users.get(Number(row.grantedByUserId)) ?? null),
        createdAt: row.createdAt,
        // The owner's row is what makes their own project visible to them; taking it away is the
        // one removal nobody can undo from this screen.
        isOwner: project.ownerId !== null && Number(project.ownerId) === Number(row.userId),
      };
    }),
    meta: {
      canManage,
      owner: publicUser(project.ownerId !== null ? users.get(Number(project.ownerId)) ?? null : null),
      ownerRoleName: ownerRolePreset().name,
      presets: ROLE_PRESETS.map(({ key, name, description }) => ({ key, name, description })),
      roles: groups.map((group) => ({
        id: group.id,
        name: group.name,
        description: group.description ?? null,
        presetKey: presetKeyOf(group),
      })),
    },
  };
}

/**
 * The project's **agent** roles, read-only.
 *
 * They are here because the word «роль» means two different things in one project and the two are
 * easiest to confuse on exactly this screen: a person's role is a panel group, an agent's role is
 * a prompt and a model. Editing them stays where the pipelines live — this is a list with a link,
 * never a second editor.
 */
export interface PanelAgentRole {
  id: string;
  key: string;
  title: string;
  model: string | null;
  /** The ACP harness the role was pinned to (`setRoleAcpProvider`), when it was. */
  provider: string | null;
}

export async function projectAgentRoles(projectId: string): Promise<PanelAgentRole[]> {
  const roles = await AgentRole.findAll({ where: { projectId }, order: [['key', 'ASC']] });
  return roles.map((role) => ({
    id: role.id,
    key: role.key,
    title: role.title,
    model: role.model ?? null,
    provider: typeof (role.config as any)?.provider === 'string' ? ((role.config as any).provider as string) : null,
  }));
}

/** Where the project's tasks come from, plus the catalogue a new source is picked out of. */
export interface PanelSourcesView {
  sources: Array<Record<string, unknown>>;
  managers: ReturnType<typeof describeTaskManagers>;
}

export async function projectSourcesView(projectId: string): Promise<PanelSourcesView> {
  const sources = await AgentTaskSource.findAll({ where: { projectId }, order: [['createdAt', 'ASC']] });
  return {
    sources: sources.map((source) => ({
      ...maskTaskSourceForUI(source),
      // A source whose layer is not mounted must be visible as broken, not silently idle.
      available: Boolean(getTaskManagerAdapter(source.type)),
      typeTitle: getTaskManagerAdapter(source.type)?.title ?? source.type,
    })),
    // The types a source can be created as — whichever integration layers are mounted right now.
    managers: describeTaskManagers(),
  };
}

/** The project itself: its facts, its owner, and the one credential it may still carry. */
export interface PanelGeneralView {
  project: Record<string, unknown>;
  owner: PanelPerson | null;
  /** True when the project still uses the pre-integration direct repository binding. */
  hasDirectRepository: boolean;
  /** True when `secrets.token` holds something — the value itself never leaves the server. */
  hasToken: boolean;
}

export async function projectGeneralView(project: AgentProject): Promise<PanelGeneralView> {
  const owner = project.ownerId !== null ? (await loadUsers([Number(project.ownerId)])).get(Number(project.ownerId)) ?? null : null;
  return {
    // `maskProjectForUI` is the only way a project leaves the server: `secrets.token` comes out as
    // the mask, and sending the mask back means «оставить как было» (`lib/secrets.ts`).
    project: maskProjectForUI(project),
    owner: publicUser(owner),
    hasDirectRepository: Boolean(project.repoProvider),
    hasToken: typeof project.secrets?.token === 'string' && project.secrets.token.length > 0,
  };
}
