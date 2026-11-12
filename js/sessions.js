// Training sessions: there is at most one a day (Stanley, 2026-11-12), so a session is every
// attempt of one athlete recorded on the same calendar day. The day comes from the clip's own
// recording time, so clips analysed the next morning still count to the day they were filmed.
// The count is what was analysed in the app: a jump nobody uploaded isn't in it.

export function dayKey(iso) {
  const d = new Date(iso ?? NaN);
  if (Number.isNaN(+d)) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// records: one athlete's attempts. Returns [{ day, records }] oldest first, each in time order.
export function sessions(records) {
  const sorted = [...records].sort((a, b) => (+new Date(a.recordedAt) || 0) - (+new Date(b.recordedAt) || 0));
  const out = [];
  for (const r of sorted) {
    const day = dayKey(r.recordedAt);
    let s = out.at(-1);
    if (!s || s.day !== day) out.push(s = { day, records: [] });
    s.records.push(r);
  }
  return out;
}

// Where an attempt sits in its day: { n, total, day } (n from 1), or null when it isn't there.
export function sessionPlace(records, id) {
  for (const s of sessions(records)) {
    const i = s.records.findIndex(r => r.id === id);
    if (i >= 0) return { n: i + 1, total: s.records.length, day: s.day };
  }
  return null;
}

export const skoky = n => `${n} ${n === 1 ? 'skok' : n >= 2 && n <= 4 ? 'skoky' : 'skokov'}`;

const DAYS = ['nedeľa', 'pondelok', 'utorok', 'streda', 'štvrtok', 'piatok', 'sobota'];
// "streda 12. 11.", or "dnes" / "včera".
export function dayLabel(day, now = new Date()) {
  if (!day) return 'bez dátumu';
  const [y, m, d] = day.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const yest = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (day === dayKey(now.toISOString())) return 'dnes';
  if (day === dayKey(yest.toISOString())) return 'včera';
  return `${DAYS[date.getDay()]} ${d}. ${m}.`;
}
