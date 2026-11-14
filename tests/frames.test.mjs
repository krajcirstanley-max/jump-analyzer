// FrameSource survives a decoder that refuses to open (iOS "_createDecoder", 2026-11-14).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FrameSource } from '../js/frames.js';

globalThis.createImageBitmap ??= async c => ({ from: c.t, close() {} });

test('a failed decode run is retried, not left as an unhandled rejection', async () => {
  let calls = 0;
  const unhandled = [];
  const onUnhandled = e => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  const ts = Array.from({ length: 10 }, (_, i) => i / 10);
  const mb = {
    CanvasSink: class {
      canvases(t0) {
        calls++;
        const first = calls === 1;
        return (async function* () {
          if (first) throw new Error('_createDecoder');
          for (const t of ts) if (t >= t0 - 1e-9) yield { timestamp: t, canvas: { t } };
        })();
      }
    },
  };
  const src = new FrameSource(mb, { displayWidth: 100, displayHeight: 100 }, ts, [0]);
  const bmp = await Promise.race([src.get(3), new Promise(r => setTimeout(() => r('timeout'), 2000))]);
  src.dispose();
  await new Promise(r => setTimeout(r, 50));
  process.off('unhandledRejection', onUnhandled);
  assert.notEqual(bmp, 'timeout');
  assert.equal(calls, 2);
  assert.equal(unhandled.length, 0);
});
