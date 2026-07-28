import { execSync } from 'node:child_process'

export function sh(cmd: string, opts: { stdio?: 'inherit' | 'pipe' } = { stdio: 'inherit' }) {
  return execSync(cmd, { stdio: opts.stdio ?? 'inherit' })
}

export function trySh(cmd: string) {
  try {
    execSync(cmd, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

export function dockerNetworkEnsure(name: string) {
  const exists = trySh(`docker network inspect ${name}`)
  if (!exists) {
    sh(`docker network create ${name}`)
  }
}

export function dockerRmIfExists(name: string) {
  const exists = trySh(`bash -lc "docker ps -a --format '{{.Names}}' | grep -w ${name}"`)
  if (exists) {
    trySh(`docker rm -f ${name}`)
  }
}

export function dockerRun(args: string[]) {
  sh(`docker run ${args.join(' ')}`)
}

export function dockerExec(name: string, args: string[]) {
  sh(`docker exec ${name} ${args.join(' ')}`)
}

export function dockerStop(name: string) {
  trySh(`docker stop ${name}`)
}

export async function waitFor(fn: () => Promise<boolean> | boolean, timeoutMs = 30000, intervalMs = 500) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const ok = await Promise.resolve(fn())
    if (ok) return
    await new Promise(r => setTimeout(r, intervalMs))
  }
  throw new Error('Timeout waiting for condition')
}
