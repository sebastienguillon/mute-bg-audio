#!/usr/bin/env node
// Runs a command with LOOKAHEAD_MODEL set (the look-ahead model of a build, see scripts/models.mjs),
// so that the package.json scripts choose the model without shell syntax: pnpm runs scripts with
// cmd.exe on Windows, which has no `VAR=value command`. The exit status is the command's.
//
// Usage: node scripts/with-model.mjs <kim|scnet> <command> [args...]
//   e.g. node scripts/with-model.mjs scnet pnpm dev
import { spawn } from 'node:child_process';

const [model, command, ...args] = process.argv.slice(2);
if (!model || !command) {
  console.error('Usage: node scripts/with-model.mjs <kim|scnet> <command> [args...]');
  process.exit(2);
}
const env = { ...process.env, LOOKAHEAD_MODEL: model };
// On Windows the commands in node_modules/.bin are .cmd files, which only cmd.exe runs.
const child =
  process.platform === 'win32'
    ? spawn([command, ...args].map(quoteForCmd).join(' '), { stdio: 'inherit', env, shell: true })
    : spawn(command, args, { stdio: 'inherit', env });
child.on('error', (e) => {
  console.error(`with-model.mjs: ${command}: ${e.message}`);
  process.exit(1);
});
// Ctrl+C reaches the command as well (same process group): wait until it has stopped. A
// termination of this process is passed on.
process.on('SIGINT', () => {});
process.on('SIGTERM', () => child.kill('SIGTERM'));
child.on('exit', (code, signal) => {
  if (signal === null) process.exit(code ?? 1);
  process.removeAllListeners(signal);
  process.kill(process.pid, signal);
});

/** An argument as cmd.exe and the program's argument parsing pass it on: quoted unless plain. */
function quoteForCmd(arg) {
  if (/^[\w\-.:/\\=@+,]+$/.test(arg)) return arg;
  return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}
