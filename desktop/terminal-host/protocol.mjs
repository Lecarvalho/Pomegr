export const VERSION = 1;
export const MAX_FRAME_BYTES = 64 * 1024;

export function encodeFrame(frame) {
  const body = Buffer.from(JSON.stringify(frame), 'utf8');
  if (!body.length || body.length > MAX_FRAME_BYTES) throw new Error('TERMINAL_INVALID');
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}

export function decodeFrames(socket, onFrame) {
  let pending = Buffer.alloc(0);
  let failed = false;
  socket.on('data', (chunk) => {
    if (failed) return;
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 4) {
      const length = pending.readUInt32BE(0);
      if (!length || length > MAX_FRAME_BYTES) { failed = true; socket.destroy(); return; }
      if (pending.length < length + 4) return;
      const body = pending.subarray(4, length + 4);
      pending = pending.subarray(length + 4);
      let frame;
      try {
        const json = new TextDecoder('utf-8', { fatal: true }).decode(body);
        frame = JSON.parse(json);
        if (!frame || typeof frame !== 'object' || Array.isArray(frame)) throw new Error();
      } catch { failed = true; socket.destroy(); return; }
      if (frame.command === 'input' && length + 4 > 16 * 1024) { failed = true; socket.destroy(); return; }
      onFrame(frame);
      if (socket.destroyed) return;
    }
  });
}

