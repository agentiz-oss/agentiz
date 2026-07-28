import dotenv from 'dotenv';

// Load environment variables from .env file
dotenv.config();

// IMPORTANT: load Sequelize from root to avoid duplicate instances
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
let SequelizeCtor: any;
import { AppManager } from "@nodeknit/app-manager/dist/lib/AppManager.js";
import { SystemApp } from "@nodeknit/app-manager/dist/system/SystemApp.js";
import express from 'express';
import cors from 'cors';

// Set up minimal environment for fixture
process.env.SECRET = "fixture-secret";
process.env.NODE_ENV = process.env.NODE_ENV || 'development';
process.env.JWT_SECRET = process.env.JWT_SECRET || "fixture-jwt-secret";

// Minimal AppBase for fixture
import { AbstractApp } from "@nodeknit/app-manager/dist/lib/AbstractApp.js";
import { Collection } from "@nodeknit/app-manager/dist/lib/decorators/appUtils.js";

class AppBaseFixture extends AbstractApp {
  appId: string = "app-base-fixture";
  name: string = "App Base Fixture";

  @Collection
  models: any[] = [
    // Models will be added dynamically from the specified app
  ];

  constructor(appManager: AppManager, additionalModels: any[] = []) {
    super(appManager);
    this.models = this.models.concat(additionalModels);
  }

  async mount(): Promise<void> {
    // Add CORS middleware
    this.appManager.app.use(cors({
      origin: true, // Allow all origins for fixture
      credentials: true
    }));

    // Add JSON parsing middleware
    this.appManager.app.use(express.json());
    this.appManager.app.use(express.urlencoded({ extended: true }));

    // Add health check endpoint
    this.appManager.app.get('/health', (req: any, res: any) => {
      res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        app: this.appId,
        fixture: true
      });
    });
  }

  async unmount(): Promise<void> {
    // Fixture apps don't need unmounting
  }
}

async function startFixture(AppClass?: any, migrationMode: boolean = false) {
  try {
    console.log('🚀 Starting fixture...');

    // Check Docker availability for migration mode
    if (migrationMode) {
      try {
        const { execSync } = await import('child_process');
        execSync('docker --version', { stdio: 'pipe' });
        execSync('docker info', { stdio: 'pipe' });
      } catch (error) {
        console.error('❌ Docker is not available!');
        console.error('Migration generation requires Docker to run PostgreSQL and Atlas.');
        console.error('Please make sure Docker is installed and running.');
        console.error('Installation instructions: https://docs.docker.com/get-docker/');
        process.exit(1);
      }
    }

    // Resolve Sequelize from repo root node_modules via createRequire
    if (!SequelizeCtor) {
      try {
        const rootPkg = path.resolve(process.cwd(), '../..', 'package.json');
        const requireFromRoot = createRequire(rootPkg);
        const resolved = requireFromRoot.resolve('sequelize-typescript');
        const url = pathToFileURL(resolved).href;
        const mod = await import(url);
        SequelizeCtor = mod.Sequelize;
        console.log('ℹ️  Sequelize resolved via createRequire to:', resolved);
      } catch (e) {
        const mod = await import('sequelize-typescript');
        SequelizeCtor = mod.Sequelize;
        console.log('ℹ️  Sequelize loaded from bare specifier: sequelize-typescript');
      }
    }

    let sequelize: InstanceType<typeof SequelizeCtor>;

    // Setup PostgreSQL for migration mode
    if (migrationMode) {
      const { ensurePostgres, defaultPg, pgConnectionUrlHost, ensureDatabase } = await import('../lib/postgres.js');

      // Use a temporary database name for migrations to avoid conflicts
      const migrationDbName = `migration_temp_${Date.now()}`;

      // Start PostgreSQL
      await ensurePostgres(defaultPg);

      // Ensure temporary database exists
      ensureDatabase(defaultPg, migrationDbName);

      // Configure environment from Docker PostgreSQL with temporary database
      const pgUrl = new URL(pgConnectionUrlHost(defaultPg));
      process.env.DB_HOST = pgUrl.hostname;
      process.env.DB_PORT = pgUrl.port;
      process.env.DB_NAME = migrationDbName;
      process.env.DB_USER = pgUrl.username;
      process.env.DB_PASSWORD = pgUrl.password;

      // Create sequelize with Docker PostgreSQL configuration
      sequelize = new SequelizeCtor({
        dialect: 'postgres',
        host: process.env.DB_HOST,
        port: parseInt(process.env.DB_PORT || '5432'),
        database: process.env.DB_NAME,
        username: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        logging: false, // Disable SQL logging
      });
    } else {
      // Use default configuration for non-migration mode
      sequelize = new SequelizeCtor({
        dialect: 'postgres',
        host: process.env.DB_HOST || 'localhost',
        port: parseInt(process.env.DB_PORT || '5432'),
        database: process.env.DB_NAME || 'agentiz',
        username: process.env.DB_USER || 'postgres',
        password: process.env.DB_PASSWORD || 'password',
        logging: false, // Disable SQL logging
      });
    }

    // Test database connection
    await sequelize.authenticate();

    // Initialize App Manager
    const appManager = new AppManager(sequelize as any);
    await appManager.init({
      appsPath: `${import.meta.dirname}/apps` // Use fixture apps directory
    });

    // Mount System App (but don't include its models in migrations)
    const systemApp = new SystemApp(appManager);
    await systemApp._mount();

    // Mount the specified app if provided
    if (AppClass) {
      const appInstance = new AppClass(appManager)
      await appInstance._mount()
    } else {
      // Mount minimal AppBase
      const appBase = new AppBaseFixture(appManager, []);
      await appBase._mount();
    }

    // Sync database after all apps are mounted
    if (process.env.NODE_ENV !== 'production') {
      await sequelize.sync({ force: true }); // Force recreate for clean fixture
    }

    if (migrationMode) {
      // Drop system tables to exclude them from migration
      try {
        await sequelize.getQueryInterface().dropTable('apps', { cascade: true })
        await sequelize.getQueryInterface().dropTable('settings', { cascade: true })
      } catch (error) {
        // Tables might not exist, continue
      }

      // Drop tables from .migraterc exclude list (passed via env)
      const rcExclude = (process.env.MIGRATERC_EXCLUDE || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
      if (rcExclude.length > 0) {
        const qi = sequelize.getQueryInterface();
        for (const tbl of rcExclude) {
          try {
            await qi.dropTable(tbl, { cascade: true });
            // Also try without schema and with explicit public schema if formatted differently
          } catch {}
          try {
            await qi.dropTable({ tableName: tbl, schema: 'public' } as any, { cascade: true } as any);
          } catch {}
        }
      }
    }

    // Filter out system models for migrations
    const allModels = sequelize.modelManager.models.map(m => m.name)
    const appSpecificModels = allModels.filter(name => !['App', 'Setting'].includes(name))

    if (migrationMode) {
      // Return sequelize instance for migration generation
      return { sequelize, appManager };
    }

    // Start server (only if not in migration mode)
    const PORT = 17280;
    appManager.lift(PORT);

    console.log(`\n🎉 Fixture server is running!`);
    console.log(`📡 Health check: http://localhost:${PORT}/health`);
    console.log(`\n💡 Press Ctrl+C to stop the fixture`);

    // Handle graceful shutdown
    process.on('SIGINT', () => {
      console.log('\n🛑 Shutting down fixture...');
      process.exit(0);
    });

    process.on('SIGTERM', () => {
      console.log('\n🛑 Shutting down fixture...');
      process.exit(0);
    });

    return undefined; // For non-migration mode

  } catch (err) {
    console.error('❌ Error starting fixture:', err);
    process.exit(1);
  }
}

// Export for use in migration generation
export { startFixture };

// Start the fixture if this file is run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  startFixture();
}
