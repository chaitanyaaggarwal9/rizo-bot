// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

import { describe, expect, it } from 'vitest';
import { crc32, encodeEventStreamMessage, EventStreamDecoder } from './eventStream';

const text = (b: Uint8Array) => new TextDecoder().decode(b);

describe('crc32', () => {
  it('matches the standard check value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });
});

describe('EventStreamDecoder', () => {
  it('decodes headers and payload, one byte at a time', () => {
    const msg = encodeEventStreamMessage({ ':event-type': 'contentBlockDelta', ':message-type': 'event' }, '{"a":1}');
    const d = new EventStreamDecoder();
    const out = [];
    for (const byte of msg) out.push(...d.push(Uint8Array.of(byte)));
    expect(out).toHaveLength(1);
    expect(out[0].headers).toEqual({ ':event-type': 'contentBlockDelta', ':message-type': 'event' });
    expect(text(out[0].payload)).toBe('{"a":1}');
    expect(d.pending).toBe(false);
  });

  it('decodes several messages from one chunk and keeps a partial one', () => {
    const a = encodeEventStreamMessage({ x: '1' }, 'one');
    const b = encodeEventStreamMessage({ x: '2' }, 'two');
    const both = new Uint8Array(a.length + b.length - 2);
    both.set(a);
    both.set(b.slice(0, b.length - 2), a.length);
    const d = new EventStreamDecoder();
    expect(d.push(both).map((m) => text(m.payload))).toEqual(['one']);
    expect(d.pending).toBe(true);
    expect(d.push(b.slice(b.length - 2)).map((m) => text(m.payload))).toEqual(['two']);
  });

  it('reads the other header value types', () => {
    // name "b" bool true, "i" int32 7, "s" short -2
    const headers = Uint8Array.of(1, 98, 0, 1, 105, 4, 0, 0, 0, 7, 1, 115, 3, 0xff, 0xfe);
    const total = 12 + headers.length + 4;
    const msg = new Uint8Array(total);
    const v = new DataView(msg.buffer);
    v.setUint32(0, total);
    v.setUint32(4, headers.length);
    v.setUint32(8, crc32(msg, 0, 8));
    msg.set(headers, 12);
    v.setUint32(total - 4, crc32(msg, 0, total - 4));
    expect(new EventStreamDecoder().push(msg)[0].headers).toEqual({ b: true, i: 7, s: -2 });
  });

  it('rejects a corrupted payload', () => {
    const msg = encodeEventStreamMessage({ x: '1' }, 'hello');
    msg[msg.length - 6] ^= 0xff;
    expect(() => new EventStreamDecoder().push(msg)).toThrow('checksum');
  });

  it('rejects a corrupted prelude before waiting for a huge message', () => {
    const msg = encodeEventStreamMessage({ x: '1' }, 'hello');
    msg[1] = 0x7f; // claims ~2 GB
    expect(() => new EventStreamDecoder().push(msg)).toThrow('invalid event length');
  });

  it('rejects headers that run past their declared length', () => {
    const headers = Uint8Array.of(5, 97); // name length 5, but only 1 byte follows
    const total = 12 + headers.length + 4;
    const msg = new Uint8Array(total);
    const v = new DataView(msg.buffer);
    v.setUint32(0, total);
    v.setUint32(4, headers.length);
    v.setUint32(8, crc32(msg, 0, 8));
    msg.set(headers, 12);
    v.setUint32(total - 4, crc32(msg, 0, total - 4));
    expect(() => new EventStreamDecoder().push(msg)).toThrow('malformed');
  });
});
