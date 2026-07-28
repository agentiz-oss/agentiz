import { spawn } from 'child_process';
import { describe, it, expect } from 'vitest';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('Smoke Test: Application Startup', () => {
  it('should start the application without crashing for a short period', { timeout: 15000 }, async () => {
    const proc = spawn('npx', ['tsx', '--tsconfig', './tsconfig.runtime.json', 'index.ts'], {
      env: { ...process.env, PORT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    proc.stderr.on('data', data => {
      stderr += data.toString();
    });
    // Allow the application to start and run briefly
    await sleep(5000);
    // Terminate the application process
    proc.kill();
    // Ignore known network errors (e.g., camera unreachable)
    const filtered = stderr
      .split('\n')
      .filter(line =>
        !line.includes('[anpr] stream error TypeError: fetch failed') &&
        !line.includes('ENETUNREACH') &&
        !line.includes("[DEP0128] DeprecationWarning: Invalid 'main' field in") &&
        // Node печатает эту подсказку следом за первым DeprecationWarning
        !line.includes('to show where the warning was created')
      )
      .join('\n')
      .trim();
    // Assert that no unexpected errors were output to stderr
    expect(filtered).toBe('');
  });
});
