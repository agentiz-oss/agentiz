#!/usr/bin/env node
import 'reflect-metadata';
import path from 'node:path';
import fs from 'node:fs';
import { normalizeToMigrationName } from '../lib/atlas.js';
import type { PathLike } from 'node:fs';

async function main() {
  // Check if Docker is installed and running
  try {
    const { execSync } = await import('child_process');
    execSync('docker --version', { stdio: 'pipe' });
    execSync('docker info', { stdio: 'pipe' });
  } catch (error) {
    console.error('❌ Docker is not available!');
    console.error('Please make sure Docker is installed and running.');
    console.error('Installation instructions: https://docs.docker.com/get-docker/');
    process.exit(1);
  }

  // Parse command line arguments
  const args = process.argv.slice(2);

  // Parse migration name
  const nameIndex = args.indexOf('--name');
  let migrationNameInput: string | undefined;
  if (nameIndex !== -1 && nameIndex + 1 < args.length) {
    migrationNameInput = args[nameIndex + 1];
  }
  migrationNameInput = migrationNameInput || process.env.MIGRATION_NAME;

  // Parse app path
  const appPathIndex = args.indexOf('--app-path');
  let appPath: string | undefined;
  if (appPathIndex !== -1 && appPathIndex + 1 < args.length) {
    appPath = args[appPathIndex + 1];
  }
  appPath = appPath || process.env.APP_PATH;

  if (!migrationNameInput) {
    console.error('❌ Error: Migration name is required!');
    console.error('Usage: npm run migrate -- --name "add user table" --app-path "/path/to/app"');
    console.error('   or: MIGRATION_NAME="add user table" APP_PATH="/path/to/app" npm run migrate');
    process.exit(1);
  }

  if (!appPath) {
    console.error('❌ Error: App path is required!');
    console.error('Usage: npm run migrate -- --name "add user table" --app-path "/path/to/app"');
    console.error('   or: MIGRATION_NAME="add user table" APP_PATH="/path/to/app" npm run migrate');
    process.exit(1);
  }

  // Validate app path exists
  if (!fs.existsSync(appPath)) {
    console.error(`❌ Error: App path does not exist: ${appPath}`);
    process.exit(1);
  }

  // Validate app has index.ts
  const indexPath = path.join(appPath, 'index.ts');
  if (!fs.existsSync(indexPath)) {
    console.error(`❌ Error: No index.ts found in ${appPath}`);
    process.exit(1);
  }

  const migrationName = normalizeToMigrationName(migrationNameInput);
  console.log(`📝 Creating migration: "${migrationName}"`);
  console.log(`📁 App path: ${appPath}`);

  // Ensure migrations dir exists in the specified app path
  const migrationsDir = path.resolve(appPath, 'migrations');
  if (!fs.existsSync(migrationsDir)) fs.mkdirSync(migrationsDir, { recursive: true });

  try {
    // Set migration mode environment variable
    process.env.GENERATE_MIGRATION = 'true';

    // Import the app class
    const appModule = await import(indexPath);
    if (!appModule.default) {
      throw new Error(`No default export found in ${appPath}/index.ts`);
    }

    const AppClass = appModule.default;

    // Import and start fixture with the specified app
    const { startFixture } = await import('../fixture/index.js');

    // Load optional .migraterc from app path
    type Migraterc = { exclude?: string[] };
    const migratercPath = path.join(appPath, '.migraterc');
    let migraterc: Migraterc = {};
    if (fs.existsSync(migratercPath)) {
      try {
        migraterc = JSON.parse(fs.readFileSync(migratercPath, 'utf8')) as Migraterc;
        console.log('🧩 .migraterc loaded:', JSON.stringify(migraterc));
      } catch (e: any) {
        console.warn('⚠️  Failed to parse .migraterc, ignoring:', e?.message || e);
      }
    }

    // Pass excludes to fixture via env to drop from schema before diff
    if (migraterc.exclude && migraterc.exclude.length > 0) {
      process.env.MIGRATERC_EXCLUDE = migraterc.exclude.join(',');
    }

    const { sequelize } = await startFixture(AppClass, true);

    // Generate migration using Atlas
    const { atlasMigrateDiff } = await import('../lib/atlas');

    const migrationFilePath = await atlasMigrateDiff(migrationName, migrationsDir);

    // Post-process migration with exclusion rules if provided
    let finalPath = migrationFilePath;
    if (migrationFilePath && migraterc.exclude && migraterc.exclude.length > 0) {
      const originalSql = fs.readFileSync(migrationFilePath, 'utf8');
      const filteredSql = filterMigrationSql(originalSql, migraterc.exclude);
      if (filteredSql.trim().length === 0) {
        // No changes remain after filtering — remove file and report as no-op
        try { fs.unlinkSync(migrationFilePath); } catch {}
        finalPath = null;
      } else if (filteredSql !== originalSql) {
        fs.writeFileSync(migrationFilePath, filteredSql, 'utf8');
      }
    }

    // If we have a final SQL path
    if (finalPath) {
      try {
        const basename = path.basename(finalPath);
        const dir = path.dirname(finalPath);
        const isGolangPair = /\.up\.sql$|\.down\.sql$/i.test(basename);
        const sql = fs.readFileSync(finalPath, 'utf8');

        // Generate timestamp using Date.now() for uniqueness
        const timestamp = Date.now().toString();

        if (isGolangPair) {
          // Generate completely new filename with Date.now() timestamp
          const newBasename = `${timestamp}_${migrationName}${basename.includes('.up.sql') ? '.up.sql' : '.down.sql'}`;
          const newPath = path.join(dir, newBasename);

          // Rename the file
          fs.renameSync(finalPath, newPath);
          finalPath = newPath;
          console.log(`🔄 Renamed migration to include timestamp: ${newBasename}`);

          // If it's an .up.sql, ensure a matching .down.sql exists; if not, synthesize
          if (/\.up\.sql$/i.test(newBasename)) {
            const downName = `${timestamp}_${migrationName}.down.sql`;
            const downPath = path.join(dir, downName);

            // Check if Atlas generated a matching down file and rename it too
            const originalDownName = basename.replace(/\.up\.sql$/i, '.down.sql');
            const originalDownPath = path.join(dir, originalDownName);
            if (fs.existsSync(originalDownPath)) {
              fs.renameSync(originalDownPath, downPath);
              console.log(`🔄 Renamed down migration: ${downName}`);
            } else if (!fs.existsSync(downPath)) {
              // Generate down migration if it doesn't exist
              const revertMatch = sql.match(/\/\*\s*atlas:revert\s*\*\/([\s\S]*)$/i);
              let downSql = revertMatch ? (revertMatch[1].trim() + (revertMatch[1].trim().endsWith(';') ? '\n' : '\n')) : '';
              if (!downSql) downSql = generateDownFromUp(sql) || `-- down migration for ${timestamp}_${migrationName}\n-- TODO: add rollback statements if needed.\n`;
              fs.writeFileSync(downPath, downSql, 'utf8');
              console.log(`✅ Migration generated: ${downPath}`);
            }
          }
          console.log(`✅ Migration generated: ${finalPath}`);
        } else {
          // Fallback: split single file into *_up.sql and *_down.sql with timestamp
          const parsed = path.parse(finalPath);

          // Generate timestamp using Date.now() for uniqueness
          const timestamp2 = Date.now().toString();

          // Generate completely new filenames with timestamp
          const upPath = path.join(parsed.dir, `${timestamp2}_${migrationName}.up.sql`);
          const downPath = path.join(parsed.dir, `${timestamp2}_${migrationName}.down.sql`);

          const revertMatch = sql.match(/\/\*\s*atlas:revert\s*\*\/([\s\S]*)$/i);
          let upSql = sql;
          let downSql = '';
          if (revertMatch) {
            downSql = revertMatch[1].trim() + (revertMatch[1].trim().endsWith(';') ? '\n' : '\n');
            upSql = sql.replace(/\n?\/\*\s*atlas:revert\s*\*\/[\s\S]*$/i, '').trim() + '\n';
          }
          if (!downSql) {
            downSql = generateDownFromUp(upSql) || `-- down migration for ${timestamp2}_${migrationName}\n-- TODO: add rollback statements if needed.\n`;
          }
          fs.writeFileSync(upPath, upSql, 'utf8');
          fs.writeFileSync(downPath, downSql, 'utf8');
          try { fs.unlinkSync(finalPath); } catch {}
          console.log(`✅ Migration generated: ${upPath}\n✅ Migration generated: ${downPath}`);
          finalPath = upPath;
        }
      } catch (e) {
        console.warn('⚠️  Failed finalization of migration files:', e?.message || e);
        console.log(`✅ Migration generated: ${finalPath}`);
      }
    } else {
      console.log('ℹ️  No database changes detected - migration not needed');
    }

    // Cleanup
    await sequelize.close();

  } catch (error: any) {
    console.error('❌ Migration generation failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  }

  console.log('🎉 Migration generation completed!');
}

main().catch(err => {
  console.error('💥 Error:', err.message);
  console.error(err.stack);
  process.exit(1);
});

// Remove statements related to excluded tables from SQL
function filterMigrationSql(sql: string, exclude: string[]): string {
  const excludes = exclude.map(s => s.toLowerCase());
  let out = sql;
  for (const table of excludes) {
    const qName = table.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
    // Remove create table block
    out = out.replace(new RegExp(`^--\\s*Create\\s+\"[^\"]*\"\\.\"${qName}\"\\s*table[\r\n]+CREATE\\s+TABLE[\s\S]*?;[\r\n]+`, 'gms'), '');
    // Remove drop table block
    out = out.replace(new RegExp(`^--\\s*Drop\\s+\"[^\"]*\"\\.\"${qName}\"\\s*table[\r\n]+DROP\\s+TABLE[\s\S]*?;[\r\n]+`, 'gms'), '');
    // Remove any ALTER TABLE affecting the excluded table
    out = out.replace(new RegExp(`^ALTER\\s+TABLE[\s\S]*?\"${qName}\"[\s\S]*?;[\r\n]+`, 'gms'), '');
    // Remove ALTER statements that reference excluded table in FK
    out = out.replace(new RegExp(`^ALTER\\s+TABLE[\s\S]*?REFERENCES[\s\S]*?\"${qName}\"[\s\S]*?;[\r\n]+`, 'gms'), '');
  }
  return out;
}

// Best-effort DOWN generator for common DDL emitted by Atlas
function generateDownFromUp(upSql: string): string {
  // Split by semicolon end-of-statement
  const stmts = upSql
    .split(/;\s*\n/g)
    .map(s => s.trim())
    .filter(Boolean);
  const down: string[] = [];

  for (let i = stmts.length - 1; i >= 0; i--) {
    const s = stmts[i];
    // CREATE TABLE "schema"."name" or CREATE TABLE "name"
    let m = s.match(/^CREATE\s+TABLE\s+"([^"]+)"\."([^"]+)"/i);
    if (m) {
      const schema = m[1], name = m[2];
      down.push(`DROP TABLE "${schema}"."${name}";`);
      continue;
    }
    m = s.match(/^CREATE\s+TABLE\s+"([^"]+)"/i);
    if (m) {
      const name = m[1];
      down.push(`DROP TABLE "${name}";`);
      continue;
    }

    // CREATE TYPE enums
    m = s.match(/^CREATE\s+TYPE\s+"([^"]+)"\."([^"]+)"\s+AS\s+ENUM/i);
    if (m) {
      const schema = m[1], name = m[2];
      down.push(`DROP TYPE "${schema}"."${name}";`);
      continue;
    }
    m = s.match(/^CREATE\s+TYPE\s+"([^"]+)"\s+AS\s+ENUM/i);
    if (m) {
      const name = m[1];
      down.push(`DROP TYPE "${name}";`);
      continue;
    }

    // CREATE INDEX
    m = s.match(/^CREATE\s+(UNIQUE\s+)?INDEX\s+"([^"]+)"\s+ON\s+("[^"]+"\.)?"([^"]+)"/i);
    if (m) {
      const idx = m[2];
      down.push(`DROP INDEX IF EXISTS "${idx}";`);
      continue;
    }

    // ALTER TABLE ... ADD CONSTRAINT "name"
    m = s.match(/^ALTER\s+TABLE\s+(.+?)\s+ADD\s+CONSTRAINT\s+"([^"]+)"/i);
    if (m) {
      const tableRef = m[1].trim();
      const cname = m[2];
      down.push(`ALTER TABLE ${tableRef} DROP CONSTRAINT "${cname}";`);
      continue;
    }

    // ALTER TABLE ... ADD COLUMN "col"
    m = s.match(/^ALTER\s+TABLE\s+(.+?)\s+ADD\s+COLUMN\s+"([^"]+)"/i);
    if (m) {
      const tableRef = m[1].trim();
      const col = m[2];
      down.push(`ALTER TABLE ${tableRef} DROP COLUMN "${col}";`);
      continue;
    }

    // ALTER TABLE ... DROP CONSTRAINT ...  (cannot auto-recreate safely) -> skip
    // ALTER TABLE ... DROP COLUMN ...      (cannot auto-recreate safely) -> skip
    // ALTER TYPE ... ADD VALUE ...         (not reversible) -> skip
    // Other DDL -> skip with comment for visibility
    // down.push(`-- TODO: revert: ${s.replace(/\n/g,' ')}`)
  }

  return down.join('\n');
}
