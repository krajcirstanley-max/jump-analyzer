// Who is in the clip. Stanley and Miška share the app and there is no athlete switch any more
// (Stanley, 2026-11-12: "každé video je automaticky tagnuté"); they are a man and a woman, so
// telling a man from a woman tells them apart. Claude looks at a few frames cropped around the
// athlete where they are biggest. When it can't tell, or the athletes on file can't be told apart
// that way, the app keeps its own guess and the athlete can be changed by a tap.
import { contactSheet } from './grid.mjs';
import { ask } from './locate.mjs';

export const IDENTIFY_MODEL = 'claude-sonnet-5-5';
// Man or woman from eight crops is an easy look: the fast model first (2026-11-15, speed), the
// careful one only when the fast one is unsure or names nobody on the roster.
export const IDENTIFY_FAST = 'claude-haiku-5-5';
const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['athlete'],
  properties: { athlete: { type: 'string', enum: ['man', 'woman', 'unsure'] } },
};
const PROMPT = `You see frames of one athlete at a track-and-field session (a long jump run-up or a jumping drill), cropped around the athlete and stamped with frame numbers.
Is this athlete a man or a woman? Judge from build, hair and clothing over all the frames. Answer unsure only if the frames really don't show it.`;

// athletes: [{ id, sex }]. Returns the id of the only athlete of the sex Claude saw, or null.
export function pickAthlete(answer, athletes) {
  const sex = { man: 'male', woman: 'female' }[answer];
  const match = sex ? athletes.filter(a => a.sex === sex) : [];
  return match.length === 1 ? match[0].id : null;
}

// near: the frame the athlete is closest to the camera around (the board touchdown), or null.
export async function identifyAthlete({ frames, boxes, first, last, fps, near = null, athletes, client }) {
  const t0 = Date.now();
  const a = near != null ? Math.max(first, near - Math.round(1.2 * fps)) : Math.round((first + last) / 2);
  const b = near != null ? Math.min(last, near) : last;
  const list = [];
  for (let k = 0; k < 8; k++) list.push(Math.round(a + ((b - a) * k) / 7));
  const sheet = await contactSheet(frames, [...new Set(list)], { boxes, cols: 4, tileW: 240 });
  let ans = await ask(client, IDENTIFY_FAST, PROMPT, [sheet], SCHEMA).catch(() => null), model = IDENTIFY_FAST;
  if (!pickAthlete(ans?.athlete, athletes)) { ans = await ask(client, IDENTIFY_MODEL, PROMPT, [sheet], SCHEMA); model = IDENTIFY_MODEL; }
  return { id: pickAthlete(ans?.athlete, athletes), said: ans?.athlete ?? null, ms: Date.now() - t0, model };
}
