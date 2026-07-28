import { execSync } from 'node:child_process'
import { dockerNetworkEnsure, dockerRmIfExists, dockerRun, trySh, waitFor } from './docker.js'

export type PgConfig = {
  network: string
  container: string
  user: string
  password: string
  db: string
  port: number // host port
  image?: string
}

export const defaultPg: PgConfig = {
  network: 'cloudpanel-net',
  container: 'cloudpanel-pg',
  user: 'cloud',
  password: 'cloud',
  db: 'cloudpanel',
  port: 55432,
  image: 'postgres:15-alpine'
}

export function pgConnectionUrlHost(cfg: PgConfig) {
  return `postgres://${cfg.user}:${cfg.password}@127.0.0.1:${cfg.port}/${cfg.db}`
}

export function pgConnectionUrlDocker(cfg: PgConfig) {
  return `postgres://${cfg.user}:${cfg.password}@${cfg.container}:5432/${cfg.db}`
}

export async function ensurePostgres(cfg: PgConfig = defaultPg) {
  dockerNetworkEnsure(cfg.network)

  const running = trySh(`bash -lc "docker ps --format '{{.Names}}' | grep -w ${cfg.container}"`)
  if (!running) {
    dockerRmIfExists(cfg.container)
    dockerRun([
      '--rm',
      '-d',
      `--name ${cfg.container}`,
      `--network ${cfg.network}`,
      `-e POSTGRES_USER=${cfg.user}`,
      `-e POSTGRES_PASSWORD=${cfg.password}`,
      `-e POSTGRES_DB=${cfg.db}`,
      `-p ${cfg.port}:5432`,
      cfg.image || 'postgres:15-alpine'
    ])
  }

  // Wait for readiness using pg_isready
  await waitFor(() => trySh(`docker exec ${cfg.container} pg_isready -U ${cfg.user}`), 60000, 500)

  // Wait for host port to be available
  await waitFor(() => {
    try {
      execSync(`nc -z 127.0.0.1 ${cfg.port}`, { stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  }, 30000, 500)

  // Create the DB if missing
  trySh(`docker exec -e PGPASSWORD=${cfg.password} ${cfg.container} psql -U ${cfg.user} -tc "SELECT 1 FROM pg_database WHERE datname='${cfg.db}'" | grep -q 1 || docker exec -e PGPASSWORD=${cfg.password} ${cfg.container} createdb -U ${cfg.user} ${cfg.db}`)
}

export function ensureDatabase(cfg: PgConfig = defaultPg, dbName: string) {
  trySh(`docker exec -e PGPASSWORD=${cfg.password} ${cfg.container} psql -U ${cfg.user} -tc "SELECT 1 FROM pg_database WHERE datname='${dbName}'" | grep -q 1 || docker exec -e PGPASSWORD=${cfg.password} ${cfg.container} createdb -U ${cfg.user} ${dbName}`)
}

export function pgUrlForDbDocker(cfg: PgConfig, dbName: string) {
  return `postgres://${cfg.user}:${cfg.password}@${cfg.container}:5432/${dbName}`
}
