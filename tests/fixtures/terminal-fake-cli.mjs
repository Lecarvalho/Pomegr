import { createHash } from 'node:crypto';

process.stdin.setEncoding('utf8');
process.stdin.setRawMode?.(true);
let input = '';
let tick = 0;
const tickTimer = setInterval(() => process.stdout.write(`TICK ${++tick}\r\n`), 500);
process.stdout.write('READY synthetic \u{1f600}\r\n');
process.stdout.on('resize', () => process.stdout.write(`SIZE ${process.stdout.columns}x${process.stdout.rows}\r\n`));
process.stdin.on('end', () => process.exit(0));
process.on('SIGINT', () => process.stdout.write('SIGINT\r\n'));
process.stdin.on('data', async (data) => {
  for (const character of data) {
    if (character === '\x03') { process.stdout.write('INTERRUPT\r\n'); continue; }
    if (character !== '\r' && character !== '\n') { input += character; continue; }
    if (input === '/exit') { process.stdout.write('BYE\r\n'); process.exit(0); }
    if (input === '/size') process.stdout.write(`SIZE ${process.stdout.columns}x${process.stdout.rows}\r\n`);
    else if (input === '/burst') {
      clearInterval(tickTimer);
      process.stdout.write('\x1b[0m+x'.repeat(20000) + 'BURST_DONE\r\n');
    }
    else if (input === '/screen') {
      clearInterval(tickTimer);
      for (let start = 0; start < 10000; start += 100) {
        process.stdout.write(Array.from({ length: 100 }, (_, i) => `LINE ${String(start + i + 1).padStart(5, '0')} ${'x'.repeat(50)}\r\n`).join(''));
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      process.stdout.write('status: waiting\x1b[9Gready\x1b[K');
    }
    else if (input === '/alt') {
      clearInterval(tickTimer);
      process.stdout.write('\x1b[?1049h\x1b[Hfull screen');
    }
    else if (input === '/normal') process.stdout.write('\x1b[?1049l');
    else process.stdout.write(`ECHO ${Buffer.byteLength(input)} ${createHash('sha256').update(input).digest('hex')}\r\n`);
    input = '';
  }
});

