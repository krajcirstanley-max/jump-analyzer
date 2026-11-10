// Footage check: reads only the container metadata of a clip (no decoding) and
// decides whether it holds real high-frame-rate frames or a rendered/retimed copy.
// Works in the browser and in Node (tests), given the Mediabunny module.

export const VERDICT = {
  OK_240: 'ok240',       // true slo-mo original, ~240 fps
  HFR_120: 'hfr120',     // real 120 fps: usable, contact times less precise
  RENDERED: 'rendered',  // ~30/60 fps: normal video or a baked slo-mo render
};

export function median(xs) {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Pure: turns the per-packet timing list into the numbers the gate needs.
// packets: [{ ts, dur, key, seq }] in decode order, timestamps in seconds.
export function summarizePackets(packets) {
  const n = packets.length;
  if (n < 2) throw new Error('Clip has fewer than 2 video frames');

  let outOfOrder = false;
  for (let i = 1; i < n; i++) if (packets[i].ts < packets[i - 1].ts) { outOfOrder = true; break; }

  const pts = packets.map(p => p.ts).sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < n; i++) gaps.push(pts[i] - pts[i - 1]);
  const medGap = median(gaps);
  const first = pts[0];
  const last = pts[n - 1];
  const lastDur = packets.reduce((a, p) => (p.ts === last ? p.dur : a), medGap);

  // Keyframe spacing in decode order.
  const keyIdx = [];
  packets.forEach((p, i) => { if (p.key) keyIdx.push(i); });
  const gops = [];
  for (let i = 1; i < keyIdx.length; i++) gops.push(keyIdx[i] - keyIdx[i - 1]);
  if (keyIdx.length) gops.push(n - keyIdx[keyIdx.length - 1]);

  // Frames whose gap deviates >50% from the median: retiming or dropped frames.
  const irregular = gaps.filter(g => Math.abs(g - medGap) > 0.5 * medGap).length;

  return {
    frames: n,
    firstTs: first,
    duration: last - first + lastDur,
    medianGapMs: medGap * 1000,
    minGapMs: Math.min(...gaps) * 1000,
    maxGapMs: Math.max(...gaps) * 1000,
    fpsFromGap: 1 / medGap,
    fpsFromSpan: (n - 1) / (last - first),
    irregularGaps: irregular,
    keyframes: keyIdx.length,
    maxGop: gops.length ? Math.max(...gops) : n,
    hasReordering: outOfOrder,
  };
}

export function verdictFor(fps) {
  if (fps >= 200) return VERDICT.OK_240;
  if (fps >= 100) return VERDICT.HFR_120;
  return VERDICT.RENDERED;
}

// Collects metadata tags that hint at the capture device or slo-mo handling.
function interestingTags(tags) {
  const out = {};
  const raw = tags?.raw || {};
  for (const [k, v] of Object.entries(raw)) {
    if (!/apple|quicktime|fps|frame|make|model|software|slow|playback/i.test(k)) continue;
    out[k] = typeof v === 'string' || typeof v === 'number' ? v : Array.isArray(v) ? v.join(', ') : '[binary]';
  }
  if (tags?.creationTime) out.creationTime = tags.creationTime.toISOString?.() ?? String(tags.creationTime);
  return out;
}

// Reads the clip's header and every packet's timing, without decoding a frame.
export async function inspectClip(blob, mb, { name = blob.name, onProgress } = {}) {
  const input = new mb.Input({ formats: mb.ALL_FORMATS, source: new mb.BlobSource(blob) });
  try {
    const format = await input.getFormat();
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error('No video track found in this file');

    const sink = new mb.EncodedPacketSink(track);
    const packets = [];
    for await (const p of sink.packets(undefined, undefined, { metadataOnly: true })) {
      packets.push({ ts: p.timestamp, dur: p.duration, key: p.type === 'key', seq: p.sequenceNumber });
      if (onProgress && packets.length % 500 === 0) onProgress(packets.length);
    }
    const timing = summarizePackets(packets);
    let tags = {};
    try { tags = interestingTags(await input.getMetadataTags()); } catch { /* tags are optional */ }

    return {
      file: { name, sizeMB: blob.size / 1e6, mime: blob.type || '(none)' },
      container: format.name,
      codec: track.codec,
      codecString: await track.getCodecParameterString(),
      width: track.displayWidth,
      height: track.displayHeight,
      codedWidth: track.codedWidth,
      codedHeight: track.codedHeight,
      rotation: track.rotation,
      timing,
      tags,
      verdict: verdictFor(timing.fpsFromGap),
      packetTimestamps: packets.map(p => p.ts).sort((a, b) => a - b),
      keyTimestamps: packets.filter(p => p.key).map(p => p.ts).sort((a, b) => a - b),
      track, input,
    };
  } catch (e) {
    input.dispose?.();
    throw e;
  }
}
