#!/usr/bin/env node
import 'reflect-metadata';
import path from 'node:path';
import fs from 'node:fs';
import { normalizeToMigrationName } from '../lib/atlas';
async function main() {
    // Check if Docker is installed and running
    try {
        const { execSync } = await import('child_process');
        execSync('docker --version', { stdio: 'pipe' });
        execSync('docker info', { stdio: 'pipe' });
    }
    catch (error) {
        console.error('❌ Docker is not available!');
        console.error('Please make sure Docker is installed and running.');
        console.error('Installation instructions: https://docs.docker.com/get-docker/');
        process.exit(1);
    }
    // Parse command line arguments
    const args = process.argv.slice(2);
    // Parse migration name
    const nameIndex = args.indexOf('--name');
    let migrationNameInput;
    if (nameIndex !== -1 && nameIndex + 1 < args.length) {
        migrationNameInput = args[nameIndex + 1];
    }
    migrationNameInput = migrationNameInput || process.env.MIGRATION_NAME;
    // Parse app path
    const appPathIndex = args.indexOf('--app-path');
    let appPath;
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
    if (!fs.existsSync(migrationsDir))
        fs.mkdirSync(migrationsDir, { recursive: true });
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
        const { startFixture } = await import('../fixture/index');
        const { sequelize } = await startFixture(AppClass, true);
        // Generate migration using Atlas
        const { atlasMigrateDiff } = await import('../lib/atlas');
        const migrationFilePath = await atlasMigrateDiff(migrationName, migrationsDir);
        if (migrationFilePath) {
            console.log(`✅ Migration generated: ${migrationFilePath}`);
        }
        else {
            console.log('ℹ️  No database changes detected - migration not needed');
        }
        // Cleanup
        await sequelize.close();
    }
    catch (error) {
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
