import { spawn } from 'node:child_process';

// A synthetic stand-in for a provider CLI that runs helper processes (such as MCP servers): it starts three, one of
// them with a helper of its own, and prints their process IDs. Nothing here is a provider.
const idle = ['-e', 'setInterval(() => {}, 1000)'];
const nested = ['-e', `const { spawn } = require('node:child_process'); const child = spawn(process.execPath, ${JSON.stringify(idle)}, { stdio: 'ignore', windowsHide: true }); console.log('NESTED ' + child.pid); setInterval(() => {}, 1000)`];
const helpers = [
  spawn(process.execPath, idle, { stdio: 'ignore', windowsHide: true }),
  spawn(process.execPath, idle, { stdio: 'ignore' }),
  spawn(process.execPath, nested, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }),
];
helpers[2].stdout.on('data', (data) => process.stdout.write(String(data).replace('NESTED', 'NESTED_PID')));
process.stdout.write(`HELPER_PIDS ${helpers.map((helper) => helper.pid).join(',')}\r\n`);
setInterval(() => {}, 1000);
