// The copy of a clip the app plays (2026-11-18, Stanley: "ako pretáčať video aby nesekalo"). The
// camera's file has a keyframe every 116 frames, so every frame-exact seek decodes up to 115
// frames; the native side writes H.264 with a keyframe every 4 frames and no B-frames
// (SprintCamera.viewCopy). The original still goes to the server.
export async function viewCopy(path, cap = globalThis.Capacitor) {
  if (!path || !cap?.isNativePlatform?.() || !cap.nativePromise) return null;
  try {
    const r = await cap.nativePromise('SprintCamera', 'viewCopy', { path });
    const blob = await (await fetch(cap.convertFileSrc(r.path))).blob();
    return new File([blob], 'view.mp4', { type: 'video/mp4' });
  } catch (e) { console.warn('view copy failed', e); return null; }
}
// a File read from a native path keeps the path, so the copy can be made from it later
export const withPath = (file, path) => { try { file.nativePath = path; } catch { /* frozen */ } return file; };

// The drop jump alone from a clip over 3.5 s (SprintCamera.trimJump): only standing still is cut,
// written like the watching copy, so it is uploaded, kept and played as the clip. null when the
// clip is short or the phone can't cut it.
export async function trimJump(path, cap = globalThis.Capacitor) {
  if (!path || !cap?.isNativePlatform?.() || !cap.nativePromise) return null;
  try {
    const r = await cap.nativePromise('SprintCamera', 'trimJump', { path });
    if (!r?.trimmed) return null;
    const blob = await (await fetch(cap.convertFileSrc(r.path))).blob();
    return { file: new File([blob], 'rsi.mp4', { type: 'video/mp4' }), from: r.from, to: r.to, dur: r.dur };
  } catch (e) { console.warn('trim failed', e); return null; }
}
