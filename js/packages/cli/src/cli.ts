#!/usr/bin/env node
import readline from 'node:readline/promises';
import { openInBrowser } from './browser.js';
import { run } from './main.js';

const controller = new AbortController();
let interrupted = false;

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    // A second Ctrl+C doesn't wait for a clean stop.
    if (interrupted) process.exit(130);
    interrupted = true;
    controller.abort();
  });
}

const ask = async (question: string) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
};

process.exitCode = await run(process.argv.slice(2), {
  env: process.env,
  cwd: process.cwd(),
  stdout: (text) => process.stdout.write(`${text}\n`),
  stderr: (text) => process.stderr.write(`${text}\n`),
  openUrl: openInBrowser,
  prompt: process.stdin.isTTY ? ask : undefined,
  signal: controller.signal,
});
