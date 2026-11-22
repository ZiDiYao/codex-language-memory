/** Pinned py-fsrs 6.3.2 default scheduler compatibility (fuzzing disabled).
 * Adapted from Open Spaced Repetition, MIT; see LICENSE.py-fsrs.txt.
 * ts-fsrs is not used for scheduling: its rounded arithmetic and learning-step
 * rounding change existing Python schedules. All timestamps retain microseconds.
 */

export const ALGORITHM = Object.freeze({ name: 'FSRS-6', implementation: 'fsrs 6.3.2',
  desired_retention: 0.9, parameter_source: 'population_defaults', personal_parameters_trained: false });
const W = Object.freeze([0.212,1.2931,2.3065,8.2956,6.4133,0.8334,3.0194,0.001,1.8722,0.1666,0.796,1.4835,0.0614,0.2629,1.6483,0.6014,1.8729,0.5425,0.0912,0.0658,0.1542]);
const DECAY = -W[20], FACTOR = 0.9 ** (1 / DECAY) - 1;
const DAY = 86_400_000_000n;
const clampS = value => Math.max(value, 0.001);
const clampD = value => Math.min(Math.max(value, 1), 10);

export function recallRating(result, assisted = false, effort = 'standard') {
  if (result && typeof result === 'object') ({ result, assisted = false, effort = 'standard' } = result);
  if (assisted || result === 'skipped') return null;
  if (['partial','incorrect'].includes(result)) return 1;
  if (result !== 'correct' || !['standard','hard','easy'].includes(effort)) throw new Error('invalid_review');
  return { standard: 3, hard: 2, easy: 4 }[effort];
}
function instant(value) {
  const source = value instanceof Date ? value.toISOString() : value;
  if (typeof source !== 'string') throw new Error('invalid_timestamp');
  const match = source.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/u);
  const milliseconds = match ? Date.parse(match[1] + match[3]) : NaN;
  if (!Number.isFinite(milliseconds)) throw new Error('invalid_timestamp');
  return BigInt(milliseconds) * 1000n + BigInt((match[2] || '').padEnd(6, '0'));
}
function iso(value, fixed = false) {
  let seconds = value / 1_000_000n, fraction = value % 1_000_000n;
  if (fraction < 0) { seconds--; fraction += 1_000_000n; }
  const prefix = new Date(Number(seconds * 1000n)).toISOString().replace(/\.000Z$/u, '');
  return prefix + (fixed || fraction ? '.' + fraction.toString().padStart(6, '0') : '') + '+00:00';
}
const elapsedDays = (now, previous) => Number((now - previous) / DAY);
function parseCard(serialized, id, timestamp) {
  if (!serialized) return { card_id: id, state: 1, step: 0, stability: null, difficulty: null,
    due: iso(timestamp), last_review: null };
  const card = typeof serialized === 'string' ? JSON.parse(serialized) : { ...serialized };
  if (![1,2,3].includes(card.state) || !Number.isSafeInteger(card.card_id)) throw new Error('invalid_card');
  card.step ??= card.state === 1 ? 0 : null;
  card.stability = card.stability || null;
  card.difficulty = card.difficulty || null;
  instant(card.due);
  if (card.last_review) instant(card.last_review);
  return card;
}
function retrievability(card, now) {
  if (!card.last_review || card.stability === null) return 0;
  const elapsed = Math.max(0, elapsedDays(now, instant(card.last_review)));
  return (1 + FACTOR * elapsed / card.stability) ** DECAY;
}
const initialDifficulty = rating => W[4] - Math.E ** (W[5] * (rating - 1)) + 1;
function nextDifficulty(difficulty, rating) {
  const delta = -(W[6] * (rating - 3));
  return clampD(W[7] * initialDifficulty(4) + (1 - W[7]) * (difficulty + (10 - difficulty) * delta / 9));
}
function shortStability(stability, rating) {
  let increase = Math.E ** (W[17] * (rating - 3 + W[18])) * stability ** -W[19];
  if (rating !== 1) increase = Math.max(increase, 1);
  return clampS(stability * increase);
}
function nextStability(difficulty, stability, recall, rating) {
  if (rating === 1) return clampS(Math.min(
    W[11] * difficulty ** -W[12] * ((stability + 1) ** W[13] - 1) * Math.E ** ((1 - recall) * W[14]),
    stability / Math.E ** (W[17] * W[18]),
  ));
  const hard = rating === 2 ? W[15] : 1, easy = rating === 4 ? W[16] : 1;
  return clampS(stability * (1 + Math.E ** W[8] * (11 - difficulty) * stability ** -W[9] * (Math.E ** ((1 - recall) * W[10]) - 1) * hard * easy));
}
function roundEven(value) {
  const lower = Math.floor(value), fraction = value - lower;
  return fraction === 0.5 ? lower + (lower % 2) : Math.round(value);
}
function interval(stability) {
  return Math.min(Math.max(roundEven(stability / FACTOR * (0.9 ** (1 / DECAY) - 1)), 1), 36500);
}
function json(value) {
  // Python Card/ReviewLog.to_json uses the default comma/colon whitespace.
  return '{' + Object.entries(value).map(([key, item]) => JSON.stringify(key) + ': ' + JSON.stringify(item)).join(', ') + '}';
}
export function advance(recordId, serialized, rating, timestamp) {
  if (![1,2,3,4].includes(rating)) throw new Error('invalid_rating');
  if (typeof timestamp === 'string' && !/(?:Z|[+-]00:00)$/u.test(timestamp)) throw new Error('datetime must be timezone-aware and set to UTC');
  const now = instant(timestamp), card = parseCard(serialized, recordId, now);
  if (card.last_review && now < instant(card.last_review)) throw new Error('clock_moved_backwards');
  const prediction = card.last_review ? retrievability(card, now) : null;
  const days = card.last_review ? elapsedDays(now, instant(card.last_review)) : null;
  if (card.state === 1 && (card.stability === null || card.difficulty === null)) {
    card.stability = clampS(W[rating - 1]); card.difficulty = clampD(initialDifficulty(rating));
  } else {
    if (card.stability === null || card.difficulty === null) throw new Error('invalid_card');
    card.stability = days !== null && days < 1 ? shortStability(card.stability, rating)
      : nextStability(card.difficulty, card.stability, retrievability(card, now), rating);
    card.difficulty = nextDifficulty(card.difficulty, rating);
  }
  let seconds;
  if (card.state === 2) {
    if (rating === 1) { card.state = 3; card.step = 0; seconds = 600; }
    else seconds = interval(card.stability) * 86400;
  } else {
    const steps = card.state === 1 ? [60,600] : [600];
    if (!Number.isInteger(card.step) || card.step < 0) throw new Error('invalid_card');
    if ((card.step >= steps.length && rating !== 1) || rating === 4 || (rating === 3 && card.step + 1 === steps.length)) {
      card.state = 2; card.step = null; seconds = interval(card.stability) * 86400;
    } else if (rating === 1) { card.step = 0; seconds = steps[0]; }
    else if (rating === 2) seconds = card.step === 0 ? steps.length === 1 ? steps[0] * 1.5 : (steps[0] + steps[1]) / 2 : steps[card.step];
    else { card.step++; seconds = steps[card.step]; }
  }
  card.due = iso(now + BigInt(seconds) * 1_000_000n);
  card.last_review = iso(now);
  const output = Object.fromEntries(['card_id','state','step','stability','difficulty','due','last_review'].map(key => [key, card[key]]));
  const log = { card_id: card.card_id, rating, review_datetime: iso(now), review_duration: null };
  return { card: json(output), due_at: iso(instant(card.due), true), log: json(log), prediction };
}
export function memorySnapshot(serialized, timestamp, ratedReviews = 0) {
  if (!serialized) return { assessed: false, rated_reviews: 0, estimated_recall: null, due_at: null, estimate_calibrated: false };
  const now = instant(timestamp), card = parseCard(serialized, 0, now);
  return { assessed: true, rated_reviews: ratedReviews, estimated_recall: retrievability(card, now),
    stability_days: card.stability, difficulty: card.difficulty, due_at: iso(instant(card.due), true), estimate_calibrated: false };
}
