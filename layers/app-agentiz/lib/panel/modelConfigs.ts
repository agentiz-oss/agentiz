import { generateAdminizerModelConfig } from '@nodeknit/app-adminizer';

/**
 * Registration of Agentiz models with the panel's generic CRUD — and the one place that decides
 * they are **not** sidebar items.
 *
 * Before the rework every registered model put its own row into the panel's navigation: eighteen
 * of them, «Agent Run Logs» next to «Agent Run Jobs», in the same list as the screens a person
 * actually works in. The new scheme keeps the CRUD (it is the tool for taking a system apart) and
 * moves the way in behind one section, «Админ → Модели данных», built from the registry below.
 *
 * Why a wrapper and not `override` in the generator's options: `generateAdminizerModelConfig`
 * spreads the model's own `@AdminizerModel` metadata **after** `options.override`
 * (`local_modules/app-adminizer/src/utils/decorators.ts`), so a model that declares
 * `navbar: { visible: true }` — most of ours do — silently wins. Setting it on the produced
 * config is the only spelling that holds for every model.
 *
 * `visible` in a model's own declaration is not thrown away: it used to mean "worth an operator's
 * attention", and that is what orders the «Модели данных» screen now (`featured`).
 */

export interface AgentizDataModel {
  /** The CRUD key: `/dashboard/model/<modelname>`. */
  modelname: string;
  title: string;
  icon: string;
  /** The model declared itself navbar-visible, i.e. it is one of the few worth listing first. */
  featured: boolean;
  /** The token adminizer registers for reading this model (`registerModelTokens`). */
  readToken: string;
}

/**
 * Shared mutable registry, so it lives on a `Symbol.for` global: under tsx a module can be
 * instantiated twice (ESM + CJS graphs) and plain module state would then split in two — the
 * layers registering their models and the render reading the list would be looking at different
 * arrays. Same rule as every other registry in this repo.
 */
const REGISTRY = Symbol.for('agentiz.panel.dataModels');

function registry(): Map<string, AgentizDataModel> {
  const globals = globalThis as any;
  if (!globals[REGISTRY]) globals[REGISTRY] = new Map<string, AgentizDataModel>();
  return globals[REGISTRY];
}

/**
 * Builds the panel config for one Agentiz model, hides it from the sidebar and records it for the
 * «Модели данных» screen. Every layer of ours registers through this, never through
 * `generateAdminizerModelConfig` directly — a model registered around it reappears in the sidebar
 * and is missing from the screen that replaced it, which is exactly the split this avoids.
 */
export function agentizModelConfig(
  modelClass: Function,
  options?: Parameters<typeof generateAdminizerModelConfig>[1],
): ReturnType<typeof generateAdminizerModelConfig> {
  const generated = generateAdminizerModelConfig(modelClass, options);
  const config = generated.config as any;
  const featured = config.navbar?.visible !== false;

  config.navbar = { ...(config.navbar ?? {}), visible: false };

  registry().set(generated.modelname, {
    modelname: generated.modelname,
    title: config.title ?? generated.modelname,
    icon: config.icon ?? 'database',
    featured,
    readToken: `read-${generated.modelname}-model`,
  });

  return generated;
}

/** Everything registered so far, featured first and alphabetical inside each half. */
export function agentizDataModels(): AgentizDataModel[] {
  return [...registry().values()].sort((a, b) => {
    if (a.featured !== b.featured) return a.featured ? -1 : 1;
    return a.title.localeCompare(b.title, 'ru');
  });
}
