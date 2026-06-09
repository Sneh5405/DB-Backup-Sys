#!/usr/bin/env node

import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

import { pathToFileURL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const distPath = path.resolve(__dirname, '../dist/bin/index.js');
const tsPath = path.resolve(__dirname, '../src/bin/index.ts');
const tsxBin = path.resolve(__dirname, '../node_modules/.bin/tsx' + (process.platform === 'win32' ? '.cmd' : ''));

if (fs.existsSync(distPath)) {
  // Use the built JavaScript files
  import(pathToFileURL(distPath).href).catch((err) => {
    console.error('Failed to launch compiled script:', err);
    process.exit(1);
  });
} else {
  // Fallback to tsx for development execution
  if (!fs.existsSync(tsxBin)) {
    console.error('Neither the built files nor the development runner (tsx) were found. Please run "npm run build" or "npm install".');
    process.exit(1);
  }

  const proc = spawn(tsxBin, [tsPath, ...process.argv.slice(2)], {
    stdio: 'inherit',
    shell: true,
  });

  proc.on('exit', (code) => {
    process.exit(code ?? 0);
  });
}
