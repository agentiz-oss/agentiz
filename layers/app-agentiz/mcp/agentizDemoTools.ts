/**
 * `agentiz.seedDemo` — собрать (или снести) демо-проект для проверки приложения в магазинах.
 *
 * Инструмент, а не сид и не миграция, по двум причинам, которые подробно расписаны в
 * `lib/demo/demoWorkspace.ts`: сиды на проде выключены жёстко, а миграция отрабатывает один раз и
 * не даёт привести демо в исходный вид перед следующей отправкой в App Store / Google Play.
 * Вызывается по требованию, идемпотентен, трогает только демо-проект.
 *
 * Аккаунт ревьюера заводится **не здесь**, а `adminizer.user` — он единственный знает, как
 * Adminizer солит и хэширует пароль (`login + password + AP_PASSWORD_SALT`), и повторять это
 * второй раз значило бы завести вторую правду о паролях. Здесь у пользователя только берут id
 * (он становится `ownerId` демо-проекта, а значит и участником с ролью владельца) и, если панель
 * подняла `GroupAP`, проверяют, что он состоит в группе-верхней-границе: без неё разделы Agentiz
 * в панели открываются без полей.
 */

import type { IMcpTool } from '@nodeknit/app-mcp';
import type { Model, ModelStatic } from 'sequelize';
import { AgentProject } from '../models/AgentProject';
import { ACCESS_GROUP } from '../lib/access/tokens';
import { removeDemoWorkspaceContent, seedDemoWorkspace, DEMO_PROJECT_SLUG } from '../lib/demo/demoWorkspace';

const DEFAULT_OWNER_LOGIN = 'demo@agentiz.app';

type Params = Record<string, unknown>;

function objectParams(params: unknown): Params {
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    throw new Error('JSON object parameters are required');
  }
  return params as Params;
}

function userModel(): ModelStatic<Model> | null {
  const sequelize = AgentProject.sequelize;
  if (!sequelize || !sequelize.isDefined('UserAP')) return null;
  return sequelize.model('UserAP') as ModelStatic<Model>;
}

function groupModel(): ModelStatic<Model> | null {
  const sequelize = AgentProject.sequelize;
  if (!sequelize || !sequelize.isDefined('GroupAP')) return null;
  return sequelize.model('GroupAP') as ModelStatic<Model>;
}

/**
 * Находит аккаунт ревьюера по логину. Не создаёт: создание пароля — дело `adminizer.user`, и
 * сообщение об ошибке прямо называет этот вызов, потому что ничего другого вызывающий не увидит.
 */
async function resolveOwner(login: string): Promise<{ id: number; login: string }> {
  const UserAP = userModel();
  if (!UserAP) throw new Error('Модель UserAP не зарегистрирована — панель не поднята, демо-проекту некому принадлежать');
  const attributes = UserAP.getAttributes();
  for (const field of ['login', 'email', 'username']) {
    if (!(field in attributes)) continue;
    const found = await UserAP.findOne({ where: { [field]: login } as any });
    if (found) {
      const plain = found.get({ plain: true }) as Record<string, unknown>;
      return { id: Number(plain.id), login: String(plain.login ?? login) };
    }
  }
  throw new Error(
    `Пользователь "${login}" не найден. Заведите его сначала: adminizer.user {"action":"create","login":"${login}",` +
    `"data":{"password":"<пароль>","fullName":"Demo reviewer","isActive":true,"isConfirmed":true,` +
    `"isAdministrator":false,"groups":["${ACCESS_GROUP.name}"]}}`,
  );
}

/**
 * Проверяет, что владелец состоит в группе-верхней-границе. Именно она (а не проектная роль)
 * решает, откроется ли раздел Agentiz в панели вообще: проектная роль сужает видимость строк и
 * никогда не расширяет её. Чинить сами группы здесь не пытаемся — если ассоциации нет, честно
 * говорим об этом в ответе.
 */
async function ensureAccessGroup(userId: number): Promise<{ group: string; state: 'already' | 'added' | 'unavailable'; detail?: string }> {
  const UserAP = userModel();
  const Group = groupModel();
  if (!UserAP || !Group) return { group: ACCESS_GROUP.name, state: 'unavailable', detail: 'GroupAP не зарегистрирована' };
  if (!(UserAP.associations as Record<string, unknown> | undefined)?.groups) {
    return { group: ACCESS_GROUP.name, state: 'unavailable', detail: 'у UserAP нет ассоциации groups' };
  }
  const group = await Group.findOne({ where: { name: ACCESS_GROUP.name } as any });
  if (!group) return { group: ACCESS_GROUP.name, state: 'unavailable', detail: 'группа ещё не посеяна' };

  const user = await UserAP.findByPk(userId, { include: [{ association: 'groups' }] });
  if (!user) return { group: ACCESS_GROUP.name, state: 'unavailable', detail: 'пользователь исчез' };
  const current = ((user.get('groups') as Array<Model> | undefined) ?? []).map((row) => Number((row.get({ plain: true }) as any).id));
  if (current.includes(Number((group.get({ plain: true }) as any).id))) return { group: ACCESS_GROUP.name, state: 'already' };

  await (user as any).addGroup(group);
  return { group: ACCESS_GROUP.name, state: 'added' };
}

const seedDemoTool: IMcpTool = {
  name: 'agentiz.seedDemo',
  group: 'agentiz-actions',
  shortDescription: 'Creates or refreshes the demo project used for App Store / Google Play review.',
  description:
    'Builds a self-contained demo project (slug "demo") owned by the given account: roles, two pipeline specs, six tasks, ' +
    'finished/failed runs with stages and logs, a comment thread, an activity feed, one pending agent question and one ' +
    'pending approval, plus an inactive demo workflow. Idempotent — fixed ids prefixed "demo-" are updated in place. ' +
    'reset:true recreates the content (reopening a question the reviewer answered); remove:true deletes it. ' +
    'No worker, no repository and no credentials are involved. Create the reviewer account first with adminizer.user.',
  mode: 'protected',
  inputSchema: {
    type: 'object',
    properties: {
      ownerLogin: { type: 'string', description: `Login of the reviewer account that owns the demo project. Default "${DEFAULT_OWNER_LOGIN}".` },
      reset: { type: 'boolean', description: 'Delete the demo content first, then rebuild it — returns the demo to its pristine state.' },
      remove: { type: 'boolean', description: 'Delete the demo content and stop. The project row itself is kept unless removeProject is also true.' },
      removeProject: { type: 'boolean', description: 'With remove:true, delete the demo project row as well.' },
    },
  },
  async handler(params) {
    const payload = objectParams(params ?? {});
    const login = typeof payload.ownerLogin === 'string' && payload.ownerLogin.trim() ? payload.ownerLogin.trim() : DEFAULT_OWNER_LOGIN;

    if (payload.remove === true) {
      const deleted = await removeDemoWorkspaceContent({ includeProject: payload.removeProject === true });
      return { removed: true, slug: DEMO_PROJECT_SLUG, deleted };
    }

    const owner = await resolveOwner(login);
    const result = await seedDemoWorkspace({ ownerUserId: owner.id, reset: payload.reset === true });
    const access = await ensureAccessGroup(owner.id);
    return { ...result, owner, access };
  },
};

export const agentizDemoMcpTools: IMcpTool[] = [seedDemoTool];
