import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickAthlete } from '../server/identify.mjs';

const roster = [{ id: 'stanley', sex: 'male' }, { id: 'miska', sex: 'female' }];

test('who is in the clip: a man is Stanley, a woman is Miška', () => {
  assert.equal(pickAthlete('man', roster), 'stanley');
  assert.equal(pickAthlete('woman', roster), 'miska');
});

test('who is in the clip: unsure, or two athletes of that sex, leaves it to the app', () => {
  assert.equal(pickAthlete('unsure', roster), null);
  assert.equal(pickAthlete(undefined, roster), null);
  assert.equal(pickAthlete('man', [...roster, { id: 'other', sex: 'male' }]), null);
});
