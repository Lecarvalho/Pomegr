import { createHash } from 'node:crypto';

process.stdin.setEncoding('utf8');
process.stdin.setRawMode(true);
let input = '';
let tick = 0;
const tickTimer = setInterval(() => process.stdout.write(`TICK ${++tick}\r\n`), 500);
process.stdout.write('READY synthetic \u{1f600}\r\n');
process.stdout.on('resize', () => process.stdout.write(`SIZE ${process.stdout.columns}x${process.stdout.rows}\r\n`));
process.stdin.on('end', () => process.exit(0));
process.on('SIGINT', () => process.stdout.write('SIGINT\r\n'));
process.stdin.on('data', (data) => {
  for (const character of data) {
    if (character === '\x03') { process.stdout.write('INTERRUPT\r\n'); continue; }
    if (character !== '\r' && character !== '\n') { input += character; continue; }
    if (input === '/exit') { process.stdout.write('BYE\r\n'); process.exit(0); }
    if (input === '/size') process.stdout.write(`SIZE ${process.stdout.columns}x${process.stdout.rows}\r\n`);
    else if (input === '/burst') {
      clearInterval(tickTimer);
      process.stdout.write('\x1b[0m+x'.repeat(20000) + 'BURST_DONE\r\n');
    }
    else process.stdout.write(`ECHO ${Buffer.byteLength(input)} ${createHash('sha256').update(input).digest('hex')}\r\n`);
    input = '';
  }
});

