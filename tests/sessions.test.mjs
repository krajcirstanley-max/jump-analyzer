import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayKey, sessions, sessionPlace, skoky, dayLabel } from '../js/sessions.js';

const at = (y, m, d, h, min = 0) => new Date(y, m - 1, d, h, min).toISOString();
const rec = (id, iso) => ({ id, recordedAt: iso });

test('sessions: one per calendar day, in time order whatever the input order', () => {
  const r = [rec('c', at(2026, 11, 12, 18, 40)), rec('a', at(2026, 11, 10, 17)), rec('b', at(2026, 11, 12, 18, 5)), rec('d', at(2026, 11, 12, 19))];
  const s = sessions(r);
  assert.deepEqual(s.map(x => x.day), ['2026-11-10', '2026-11-12']);
  assert.deepEqual(s[1].records.map(x => x.id), ['b', 'c', 'd']);
});

test('sessionPlace: number within the day and the day total', () => {
  const r = [rec('a', at(2026, 11, 10, 17)), rec('b', at(2026, 11, 12, 18)), rec('c', at(2026, 11, 12, 18, 30))];
  assert.deepEqual(sessionPlace(r, 'c'), { n: 2, total: 2, day: '2026-11-12' });
  assert.deepEqual(sessionPlace(r, 'a'), { n: 1, total: 1, day: '2026-11-10' });
  assert.equal(sessionPlace(r, 'x'), null);
});

test('a clip filmed late in the evening counts to that local day', () => {
  assert.equal(dayKey(at(2026, 11, 12, 23, 50)), '2026-11-12');
  assert.equal(dayKey(null), null);
});

test('Slovak counts and day labels', () => {
  assert.deepEqual([1, 2, 4, 5, 11].map(skoky), ['1 skok', '2 skoky', '4 skoky', '5 skokov', '11 skokov']);
  const now = new Date(2026, 10, 12, 20);
  assert.equal(dayLabel('2026-11-12', now), 'dnes');
  assert.equal(dayLabel('2026-11-11', now), 'včera');
  assert.equal(dayLabel('2026-11-08', now), 'nedeľa 8. 11.');
});
