#!/usr/bin/env node
/**
 * Wrapper script for running migrations generator with proper decorator support
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Arguments to pass to the actual script
const scriptPath = join(__dirname, 'generate-migration.ts');
const args = process.argv.slice(2);

// Use local tsx from node_modules
const tsxPath = join(__dirname, '..', 'node_modules', '.bin', 'tsx');

// Run with local tsx
const child = spawn(tsxPath, [
  scriptPath,
  ...args
], {
  stdio: 'inherit'
});

child.on('exit', (code) => {
  process.exit(code || 0);
});

child.on('error', (error) => {
  console.error('Failed to start process:', error);
  process.exit(1);
});