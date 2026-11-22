// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

// Decoder for AWS's binary event-stream framing
// (application/vnd.amazon.eventstream), used by Bedrock's ConverseStream.
// Each message is:
//   total length (uint32 BE) | headers length (uint32 BE) | prelude CRC32
//   headers | payload | message CRC32
// Both CRCs are checked, and lengths are bounded, so a corrupted or
// hostile stream fails loudly instead of being misread.
// No 'vscode' import: tested in eventStream.test.ts.

export interface EventStreamMessage {
  headers: Record<string, string | number | boolean>;
  payload: Uint8Array;
}

const PRELUDE = 12;
const MIN_MESSAGE = 16;
// AWS caps event-stream messages at 16 MB; anything larger is corrupt.
const MAX_MESSAGE = 16 * 1024 * 1024;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array, start = 0, end = bytes.length): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const utf8 = new TextDecoder();

function parseHeaders(bytes: Uint8Array, view: DataView, start: number, end: number): EventStreamMessage['headers'] {
  const headers: EventStreamMessage['headers'] = {};
  let i = start;
  const need = (n: number) => {
    if (i + n > end) throw new Error('Bedrock stream: malformed event header.');
  };
  while (i < end) {
    need(1);
    const nameLen = bytes[i++];
    need(nameLen + 1);
    const name = utf8.decode(bytes.subarray(i, i + nameLen));
    i += nameLen;
    const type = bytes[i++];
    switch (type) {
      case 0: headers[name] = true; break;
      case 1: headers[name] = false; break;
      case 2: need(1); headers[name] = view.getInt8(i); i += 1; break;
      case 3: need(2); headers[name] = view.getInt16(i); i += 2; break;
      case 4: need(4); headers[name] = view.getInt32(i); i += 4; break;
      case 5: case 8: need(8); headers[name] = Number(view.getBigInt64(i)); i += 8; break;
      case 6: case 7: {
        need(2);
        const len = view.getUint16(i);
        i += 2;
        need(len);
        if (type === 7) headers[name] = utf8.decode(bytes.subarray(i, i + len));
        i += len;
        break;
      }
      case 9: need(16); i += 16; break;
      default: throw new Error('Bedrock stream: unknown event header type.');
    }
  }
  return headers;
}

// Incremental decoder: push bytes as they arrive, get back every message
// that is now complete. Partial messages wait for the next push.
export class EventStreamDecoder {
  private buf = new Uint8Array(0);

  push(chunk: Uint8Array): EventStreamMessage[] {
    if (chunk.length) {
      const next = new Uint8Array(this.buf.length + chunk.length);
      next.set(this.buf);
      next.set(chunk, this.buf.length);
      this.buf = next;
    }
    const out: EventStreamMessage[] = [];
    while (this.buf.length >= PRELUDE) {
      const view = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
      const total = view.getUint32(0);
      const headersLen = view.getUint32(4);
      if (total < MIN_MESSAGE || total > MAX_MESSAGE || headersLen > total - MIN_MESSAGE) {
        throw new Error('Bedrock stream: invalid event length.');
      }
      if (view.getUint32(8) !== crc32(this.buf, 0, 8)) throw new Error('Bedrock stream: event checksum mismatch.');
      if (this.buf.length < total) break;
      if (view.getUint32(total - 4) !== crc32(this.buf, 0, total - 4)) throw new Error('Bedrock stream: event checksum mismatch.');
      const headers = parseHeaders(this.buf, view, PRELUDE, PRELUDE + headersLen);
      const payload = this.buf.slice(PRELUDE + headersLen, total - 4);
      out.push({ headers, payload });
      this.buf = this.buf.slice(total);
    }
    return out;
  }

  // True when bytes of an unfinished message are still waiting.
  get pending(): boolean {
    return this.buf.length > 0;
  }
}

// Test helper and reference: builds one message with string headers.
export function encodeEventStreamMessage(headers: Record<string, string>, payload: Uint8Array | string): Uint8Array {
  const enc = new TextEncoder();
  const body = typeof payload === 'string' ? enc.encode(payload) : payload;
  const headerParts: number[] = [];
  for (const [name, value] of Object.entries(headers)) {
    const n = enc.encode(name);
    const v = enc.encode(value);
    headerParts.push(n.length, ...n, 7, (v.length >> 8) & 0xff, v.length & 0xff, ...v);
  }
  const total = PRELUDE + headerParts.length + body.length + 4;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, total);
  view.setUint32(4, headerParts.length);
  view.setUint32(8, crc32(out, 0, 8));
  out.set(headerParts, PRELUDE);
  out.set(body, PRELUDE + headerParts.length);
  view.setUint32(total - 4, crc32(out, 0, total - 4));
  return out;
}
