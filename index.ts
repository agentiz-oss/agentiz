import { AppManager } from "@nodeknit/app-manager";
import { SystemApp } from "@nodeknit/app-manager";
import { adminizerConfig } from "./config/adminizer";
import { runSeeds } from "./seeds/index";
import { setDevENV } from "./devtools/environments";
import { createSequelize } from "./config/sequelize.js";
// Apps are discovered from layers/ and the dependency graph. Both sources are
// started when their id is listed in INIT_APPS_TO_ENABLE.

process.env.SECRET ??= "secret";
// Apps started on boot. Everything else found in appsPaths is loaded but stays stopped.
// Mount order is derived from appDependencies, not from this list.
process.env.INIT_APPS_TO_ENABLE ??= "app-adminizer;app-mcp;app-agentiz;app-agentiz-gitlab-integration;app-agentiz-github-integration;app-agentiz-mobile-api;app-agentiz-claude-limits";
// For local SQLite development, prefer migrations and disable alter-sync.
// This avoids unstable Sequelize alter behavior on SQLite.
if (!process.env.DATABASE_URL) {
  process.env.ORM_ALTER ??= "false";
  process.env.USE_MIGRATIONS ??= "true";
}

export const sequelize = createSequelize();

if(!process.env.NODE_ENV) {
  setDevENV()
}

try {
  await sequelize.authenticate();
  AppManager.log.info("Connected to database");

  const ormAlter = process.env.ORM_ALTER !== 'false';
  const ormForce = process.env.ORM_FORCE === 'true';
  if (!ormAlter) {
    AppManager.log.info("Skipping root sequelize.sync due to ORM_ALTER=false");
  } else if (process.env.NODE_ENV === 'production') {
    AppManager.log.info("Skipping root sequelize.sync in production environment");
  } else {
    await sequelize.sync({ force: ormForce, alter: true });
    AppManager.log.info(`Sequelize ORM initialized via sync (force=${ormForce}, alter=true)!`);
  }

  // Initializing App Manager
  const appManager = new AppManager(sequelize);

  await appManager.init({
    // Discovery uses both this local layer directory and the dependency graph
    // (node_modules). A dev `file:` link and a published package are handled
    // identically, so applications never need to be mounted by hand here.
    appsPath: process.env.APPS_PATH ?? `${import.meta.dirname}/layers`,
    // Adminizer requires its config as the second constructor argument.
    appConfigs: { "app-adminizer": adminizerConfig },
    // Register health endpoints before enabled apps are mounted below.
    autoMount: false,
  });

  // Add health endpoints early, before other apps mount
  appManager.app.get('/healthz', (_req, res) => {
    res.status(200).send('ok');
  });
  appManager.app.get('/readyz', (_req, res) => {
    res.status(200).send('ok');
  });

  // Defining System App
  const systemApp = new SystemApp(appManager);
  await systemApp._mount();

  // Mounts all discovered apps together, in appDependencies order.
  await systemApp.mountLoadedApps();

  console.log(
    'Зарегистрированные модели:',
    sequelize.modelManager.models.map(m => m.name)
  );

  if (process.env.NODE_ENV === 'production' && process.env.FORCE_SEED !== '1') {
    console.log('[seeds] Hard-disabled in production environment (set FORCE_SEED=1 to override)');
  } else {
    await runSeeds(appManager);
  }
  const PORT = Number(process.env.PORT ?? 17280);
  appManager.lift(PORT)

} catch (err) {
  AppManager.log.error("Error starting App Manager:", err, err.stack);
}
