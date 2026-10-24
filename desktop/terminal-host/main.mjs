import { fileURLToPath } from 'node:url';
import pty from 'node-pty';
import { startTerminalHost } from './host.mjs';

// The immutable runtime includes desktop/terminal-host and node_modules beside it.
const runtimeDirectory = fileURLToPath(new URL('../../', import.meta.url));
try {
  await startTerminalHost({ runtimeDirectory, spawnPty: pty.spawn, onIdle: () => process.exit(0) });
} catch {
  process.exitCode = 1;
}
