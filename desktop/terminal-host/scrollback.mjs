// Replay is a bounded raw stream, not a screen snapshot. Incomplete escape sequences
// and surrogate pairs stay out of replay until their following chunk completes them.
export class Scrollback {
  constructor(limit = 256 * 1024) {
    this.limit = limit; this.bytes = 0; this.parts = []; this.escape = ''; this.mode = ''; this.high = ''; this.overflow = false; this.previousEscape = false;
  }
  append(data) {
    let text = '';
    const flush = () => { if (text) this.push(text, false); text = ''; };
    for (const character of this.high + data) {
      this.high = '';
      if (this.mode) {
        if (this.escape.length < 4096) this.escape += character; else this.overflow = true;
        const code = character.charCodeAt(0);
        let finished = false;
        if (this.mode === 'start') {
          this.mode = character === '[' ? 'csi' : ']PX^_'.includes(character) ? 'string' : 'esc';
          this.osc = character === ']';
          finished = this.mode === 'esc' && code >= 0x30 && code <= 0x7e;
        } else if (this.mode === 'csi') finished = code >= 0x40 && code <= 0x7e;
        else if (this.mode === 'string') finished = (this.osc && character === '\x07') || character === '\x9c' || (this.previousEscape && character === '\\');
        else finished = code >= 0x30 && code <= 0x7e;
        this.previousEscape = character === '\x1b';
        if (finished) {
          if (!this.overflow) this.push(this.escape, true);
          this.escape = ''; this.mode = ''; this.overflow = false; this.previousEscape = false;
        }
      } else if (character === '\x1b') { flush(); this.escape = character; this.mode = 'start'; }
      else if ('\x90\x98\x9b\x9d\x9e\x9f'.includes(character)) {
        flush(); this.escape = character; this.mode = character === '\x9b' ? 'csi' : 'string'; this.osc = character === '\x9d';
      }
      else if (character.length === 1 && character.charCodeAt(0) >= 0xd800 && character.charCodeAt(0) <= 0xdbff) this.high = character;
      else text += character;
    }
    flush();
  }
  push(text, escape) {
    const last = this.parts.at(-1);
    if (!escape && last && !last.escape && last.text.length < 8192) last.text += text;
    else this.parts.push({ text, escape });
    this.bytes += Buffer.byteLength(text);
    while ((this.bytes > this.limit || this.parts.length > 4096) && this.parts.length) {
      const first = this.parts[0]; const size = Buffer.byteLength(first.text);
      if (first.escape || this.parts.length > 4096 || size <= this.bytes - this.limit) { this.parts.shift(); this.bytes -= size; continue; }
      const buffer = Buffer.from(first.text); let offset = this.bytes - this.limit;
      while (offset < buffer.length && (buffer[offset] & 0xc0) === 0x80) offset++;
      const newline = buffer.indexOf(10, offset);
      if (newline !== -1) offset = newline + 1;
      first.text = buffer.subarray(offset).toString('utf8'); this.bytes -= offset;
    }
  }
  read() { return this.parts.map((part) => part.text); }
  clear() { this.parts = []; this.bytes = 0; this.escape = ''; this.high = ''; this.mode = ''; }
}

