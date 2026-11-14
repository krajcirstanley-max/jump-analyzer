import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionFor, trainings } from '../js/freelap-view.js';

const at = (h, m = 0, d = 13) => new Date(2026, 10, d, h, m).getTime();

test('freelap trainings: a run joins the open training the same day', () => {
  const open = sessionFor(null, at(14));
  assert.equal(sessionFor(open, at(15)), open);
  assert.notEqual(sessionFor({ ...open, ended: true }, at(15)).id, open.id);   // ended
  assert.notEqual(sessionFor(open, at(9, 0, 14)).id, open.id);                  // next day
});

test('freelap trainings: grouped newest first with the best run per athlete', () => {
  const reps = [
    { key: 'c', who: 'miska', chip: 'BD-4125', lap: 6.95, at: at(15, 5), session: 's2' },
    { key: 'b', who: 'stanley', chip: 'BA-8358', lap: 3.85, at: at(15, 2), session: 's2' },
    { key: 'a', who: 'stanley', chip: 'BA-8358', lap: 3.91, at: at(15, 0), session: 's2' },
    { key: 'z', who: 'stanley', chip: 'BA-8358', lap: 4.10, at: at(10, 0, 12) },   // before trainings: by day
  ];
  const t = trainings(reps);
  assert.deepEqual(t.map(x => x.runs.length), [3, 1]);
  assert.equal(t[0].best['stanley|letmý'].key, 'b');   // no splits: counted as letmý
  assert.equal(t[0].best['miska|letmý'].key, 'c');
  assert.equal(t[1].id, 'd2026-11-12');
});
