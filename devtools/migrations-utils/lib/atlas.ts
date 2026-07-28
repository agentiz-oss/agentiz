import { sh } from './docker.js'
import { PgConfig, pgConnectionUrlDocker } from './postgres.js'
import path from 'node:path'
import fs from 'node:fs'

export function atlasEnsureChecksum(opts: { pg: PgConfig, migrationsDir: string }) {
  const { pg, migrationsDir } = opts

  // Use a separate checksum directory to avoid polluting migrations folder
  const checksumDir = path.join(migrationsDir, '.atlas')
  if (!fs.existsSync(checksumDir)) {
    fs.mkdirSync(checksumDir, { recursive: true })
  }

  // Mount the entire project root to access any migrations directory
  const projectRoot = path.resolve(process.cwd(), '../..')
  const rel = path.relative(projectRoot, migrationsDir)
  const containerDir = `/project/${rel}`
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0
  const gid = typeof process.getgid === 'function' ? process.getgid() : 0

  // Always regenerate checksum for current format (golang-migrate)
  const checksumFile = path.join(checksumDir, 'atlas.sum')
  const rootChecksumFile = path.join(migrationsDir, 'atlas.sum')
  try { if (fs.existsSync(rootChecksumFile)) fs.unlinkSync(rootChecksumFile) } catch {}
  try { if (fs.existsSync(checksumFile)) fs.unlinkSync(checksumFile) } catch {}

  const atlasArgs = [
    'docker run --rm',
    `-u ${uid}:${gid}`,
    `--network ${pg.network}`,
    `-v ${projectRoot}:/project`,
    '-w /project',
    'arigaio/atlas',
    'migrate hash',
    `--dir file://${containerDir}?format=golang-migrate`
  ]

  try {
    sh(atlasArgs.join(' '))
    // Move generated atlas.sum to .atlas directory temporarily
    if (fs.existsSync(rootChecksumFile)) {
      fs.copyFileSync(rootChecksumFile, checksumFile)
      fs.unlinkSync(rootChecksumFile)
    }
    console.log('✅ Checksum file regenerated successfully')
  } catch (error: any) {
    console.log('⚠️  Failed to regenerate checksum, continuing anyway...')
    console.log('Error:', error?.message || error)
  }
}

export function atlasMigrateDiff(migrationName: string, migrationsDir: string): Promise<string>;
export function atlasMigrateDiff(opts: { pg: PgConfig, migrationsDir: string, devUrl: string, name?: string }): void;
export function atlasMigrateDiff(
  nameOrOpts: string | { pg: PgConfig, migrationsDir: string, devUrl: string, name?: string },
  migrationsDir?: string
): Promise<string> | void {
  // New simple signature: fixture handles everything
  if (typeof nameOrOpts === 'string' && migrationsDir) {
    return atlasMigrateDiffFromFixture(nameOrOpts, migrationsDir);
  }

  // Legacy signature: manual setup
  return atlasMigrateDiffLegacy(nameOrOpts as { pg: PgConfig, migrationsDir: string, devUrl: string, name?: string });
}

async function atlasMigrateDiffFromFixture(migrationName: string, migrationsDir: string): Promise<string | null> {
  // This function expects the fixture to have already setup PostgreSQL and synced models
  // We just need to use Atlas to generate the migration from the current DB state

  // Import PostgreSQL utilities when needed
  const { ensurePostgres, defaultPg, pgConnectionUrlDocker, ensureDatabase, pgUrlForDbDocker } = await import('./postgres.js');

  // Setup PostgreSQL if not already running
  await ensurePostgres(defaultPg);

  // Setup Atlas dev database for comparison
  const atlasDevDb = 'atlas_dev';
  ensureDatabase(defaultPg, atlasDevDb);
  const devUrl = pgUrlForDbDocker(defaultPg, atlasDevDb);

  // Use the database configured by the fixture (temporary database for migrations)
  const dbName = process.env.DB_NAME || 'cloudpanel';
  const toUrl = `postgres://${process.env.DB_USER || 'cloud'}:${process.env.DB_PASSWORD || 'cloud'}@${defaultPg.container}:5432/${dbName}?sslmode=disable`;

  // Mount the entire project root to access any migrations directory
  const projectRoot = path.resolve(process.cwd(), '../..');
  const rel = path.relative(projectRoot, migrationsDir);
  const containerDir = `/project/${rel}`;

  // Ensure checksum file exists (this also creates .atlas directory if needed)
  atlasEnsureChecksum({ pg: defaultPg, migrationsDir });

  // Copy checksum file from .atlas to migrations root for Atlas to find it
  const checksumSrcFile = path.join(migrationsDir, '.atlas', 'atlas.sum')
  const checksumDestFile = path.join(migrationsDir, 'atlas.sum')
  if (fs.existsSync(checksumSrcFile) && !fs.existsSync(checksumDestFile)) {
    try {
      fs.copyFileSync(checksumSrcFile, checksumDestFile)
    } catch (error) {
      // Silent fail, not critical
    }
  }

  // Run Atlas in Docker on the same network so it can reach Postgres by container name
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  const gid = typeof process.getgid === 'function' ? process.getgid() : 0;

  const atlasArgs = [
    'docker run --rm',
    `-u ${uid}:${gid}`,
    `--network ${defaultPg.network}`,
    `-v ${projectRoot}:/project`,
    '-w /project',
    'arigaio/atlas',
    'migrate diff',
    `--dir file://${containerDir}?format=golang-migrate`,
    `--to ${toUrl}`,
    `--dev-url ${devUrl}${devUrl.includes('?') ? '&' : '?'}sslmode=disable`,
    shellEscape(migrationName)
  ];

  console.log('🏃 Running Atlas migration diff...');
  const output = sh(atlasArgs.join(' '), { stdio: 'pipe' });
  const outputStr = output?.toString() || '';

  // Always clean up the temporary checksum file from migrations root
  if (fs.existsSync(checksumDestFile)) {
    try {
      fs.unlinkSync(checksumDestFile)
    } catch (error) {
      // Silent fail, not critical
    }
  }

  // Also clean up the checksum file from .atlas directory
  if (fs.existsSync(checksumSrcFile)) {
    try {
      fs.unlinkSync(checksumSrcFile)
    } catch (error) {
      // Silent fail, not critical
    }
  }

  // Clean up the entire .atlas directory if it's empty
  const atlasDir = path.join(migrationsDir, '.atlas')
  try {
    if (fs.existsSync(atlasDir)) {
      const files = fs.readdirSync(atlasDir)
      if (files.length === 0) {
        fs.rmdirSync(atlasDir)
      }
    }
  } catch (error) {
    // Silent fail, not critical
  }

  // Check if Atlas reported no changes
  if (outputStr.includes('no changes to be made') || outputStr.includes('synced with the desired state')) {
    console.log('ℹ️  No changes detected - no migration needed');
    return null;
  }

  // Find the generated migration file
  const files = fs.readdirSync(migrationsDir, { withFileTypes: true })
    .filter(d => d.isFile() && d.name.endsWith('.sql'))
    .map(d => d.name)
    .sort();

  if (files.length === 0) {
    console.log('ℹ️  No changes detected - no migration needed');
    return null;
  }

  const latestMigration = files[files.length - 1];
  const migrationPath = path.join(migrationsDir, latestMigration);

  return migrationPath;
}

function atlasMigrateDiffLegacy(opts: { pg: PgConfig, migrationsDir: string, devUrl: string, name?: string }): void {
  const { pg, migrationsDir, devUrl, name } = opts
  const toUrl = pgConnectionUrlDocker(pg) + '?sslmode=disable'

  // Mount the entire project root to access any migrations directory
  const projectRoot = path.resolve(process.cwd(), '../..')
  const rel = path.relative(projectRoot, migrationsDir)
  const containerDir = `/project/${rel}`

  // Run Atlas in Docker on the same network so it can reach Postgres by container name
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0
  const gid = typeof process.getgid === 'function' ? process.getgid() : 0

  const atlasArgs = [
    'docker run --rm',
    `-u ${uid}:${gid}`,
    `--network ${pg.network}`,
    `-v ${projectRoot}:/project`,
    '-w /project',
    'arigaio/atlas',
    'migrate diff',
    `--dir file://${containerDir}?format=golang-migrate`,
    `--to ${toUrl}`,
    `--dev-url ${devUrl}${devUrl.includes('?') ? '&' : '?'}sslmode=disable`
  ]

  // Add name as positional argument if provided
  if (name) {
    atlasArgs.push(shellEscape(name))
  }

  console.log('🏃 Running Atlas migration diff...')
  const output = sh(atlasArgs.filter(Boolean).join(' '))
  console.log('📝 Atlas output:', output)
}

function shellEscape(s: string) {
  return `'${s.replace(/'/g, `'"'"'`)}'`
}

export function normalizeToMigrationName(input: string): string {
  // Convert to lowercase, replace spaces and special chars with underscores, remove consecutive underscores
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') // Remove leading/trailing underscores
    .replace(/_+/g, '_') // Replace multiple underscores with single
}
