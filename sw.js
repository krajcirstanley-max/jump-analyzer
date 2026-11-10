// Service worker for push notifications only. The app is online by nature now, so there
// is no fetch handler and nothing is cached; pages always come from the network.

self.addEventListener('install', e => e.waitUntil(self.skipWaiting()));

// People on the old offline version still have the shell and ~300 MB of models cached.
// The old worker served the shell cache-first, so reload once to get the current files.
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const old = (await caches.keys()).filter(k => k.startsWith('ja-'));
    await Promise.all(old.map(k => caches.delete(k)));
    await self.clients.claim();
    if (!old.length) return;
    const windows = await self.clients.matchAll({ type: 'window' });
    await Promise.all(windows.map(c => Promise.resolve().then(() => c.navigate(c.url)).catch(() => {})));
  })());
});

// iOS revokes the subscription after pushes that show nothing, so every push notifies.
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data?.json() ?? {}; } catch { /* malformed payload, show the default */ }
  e.waitUntil(self.registration.showNotification(d.title || 'Analýza je hotová', {
    body: d.body || 'Otvor aplikáciu a pozri si výsledok.',
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
    tag: d.jobId ? `job-${d.jobId}` : 'job',
    data: { jobId: d.jobId ?? null },
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil((async () => {
    const [win] = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (win) {
      win.postMessage({ type: 'cloud-job', jobId: e.notification.data?.jobId ?? null });
      return win.focus();
    }
    return self.clients.openWindow('./');
  })());
});
