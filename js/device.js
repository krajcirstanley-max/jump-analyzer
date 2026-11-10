// What this phone and browser can do. Shown on the home screen so problems are
// visible before a clip is imported.

export function iosVersion(ua = navigator.userAgent) {
  const m = ua.match(/OS (\d+)[_.](\d+)(?:[_.](\d+))? like Mac OS X/);
  return m ? `${m[1]}.${m[2]}${m[3] ? '.' + m[3] : ''}` : null;
}

export function isStandalone() {
  return navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
}

async function decoderSupports(codec) {
  if (!('VideoDecoder' in window)) return false;
  try {
    const r = await VideoDecoder.isConfigSupported({ codec, codedWidth: 1920, codedHeight: 1080 });
    return !!r.supported;
  } catch { return false; }
}

export async function deviceReport() {
  const est = navigator.storage?.estimate ? await navigator.storage.estimate().catch(() => null) : null;
  const persisted = navigator.storage?.persisted ? await navigator.storage.persisted().catch(() => null) : null;
  return {
    ios: iosVersion(),
    standalone: isStandalone(),
    webcodecs: 'VideoDecoder' in window,
    hevc: await decoderSupports('hvc1.1.6.L123.B0'),
    h264: await decoderSupports('avc1.640028'),
    webgpu: 'gpu' in navigator,
    storageFreeGB: est ? (est.quota - est.usage) / 1e9 : null,
    storageUsedMB: est ? est.usage / 1e6 : null,
    persisted,
  };
}
