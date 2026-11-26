import test from 'node:test';
import assert from 'node:assert/strict';
import fixtures from './python-parity-fixtures.json' with { type: 'json' };
import { encode, encodeAscii, fingerprint, normalized, serializeRecord } from '../src/parity.js';
import { validatePoint, validatePatch, validateReview, validateCapture, validateQuery, settingsWithDefaults, validateSettingsPatch } from '../src/schemas.js';
import { advance, memorySnapshot, recallRating } from '../src/learning.js';
import { inferScenes, uniqueScenes } from '../src/scenes.js';

function near(actual, expected, path = '') {
  if (typeof expected === 'number') assert.ok(Math.abs(actual - expected) <= 1e-11 * Math.max(1, Math.abs(expected)), `${path}: ${actual} != ${expected}`);
  else if (expected && typeof expected === 'object') {
    assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), path);
    for (const key of Object.keys(expected)) near(actual[key], expected[key], path + '.' + key);
  } else assert.equal(actual, expected, path);
}

test('Python Unicode casefold and whitespace normalization stays stable', () => {
  for (const { input, expected } of fixtures.normalization) assert.equal(normalized(input), expected);
  assert.equal(encode({ '𐐀': 1, '\ue000': 2, z: '中文' }), '{"z":"中文","":2,"𐐀":1}');
  assert.equal(encodeAscii({ text: '𐐀中文' }), '{"text":"\\ud801\\udc00\\u4e2d\\u6587"}');
  assert.equal(encodeAscii({ text: '\u007f' }), '{"text":"\\u007f"}');
  assert.equal(normalized('\ua7f1'), '\ua7f1');
  assert.equal(fingerprint({ b: '中文', a: 1 }), fingerprint({ a: 1, b: '中文' }));
});

test('public records, generated notes and revisions match Python fixtures', () => {
  for (const { raw, expected } of fixtures.records) assert.deepEqual(serializeRecord(raw), expected);
});

test('strict schemas preserve Python defaults and patch omission semantics', () => {
  const point = { kind: 'word', language: ' EN-ca ', title: ' rinse ', sense_key: 'clean', meaning: '冲洗', explanation: 'Wash using water.', examples: [{ text: 'Rinse the cup.' }, { text: 'Rinse your hands.' }] };
  const result = validatePoint(point);
  assert.equal(result.language, 'en-ca');
  assert.equal(result.context, null);
  assert.equal(result.examples[0].translation, null);
  assert.deepEqual(validatePatch({ examples: [{ text: 'Updated.' }] }), { examples: [{ text: 'Updated.' }] });
  assert.deepEqual(validateReview({ result: 'correct' }), { result: 'correct', assisted: false, effort: 'standard', prompt: null, answer: null });
  assert.deepEqual(settingsWithDefaults({}), { enabled: true, ui_language: 'en', first_language: null, explanation_language: null, enabled_types: ['word','expression','grammar','correction'], english_learning_instructions: '' });
  assert.equal(validatePoint({ ...point, title: '😀'.repeat(350) }).title.length, 700);
  for (const invalid of [
    { ...point, title: '😀'.repeat(351) }, { ...point, title: '\u0000' }, { ...point, title: '\ud800' },
    { ...point, user_id: 'another-user' }, { ...point, scenes: ['Work, meetings'] },
    { ...point, scenes: ['\ufdfa'.repeat(5)] }, { ...point, examples: [{ text: 'Same.' }, { text: ' SAME. ' }] },
  ]) assert.throws(() => validatePoint(invalid), /invalid_request/u);
  assert.throws(() => validateQuery({ user_id: 'another-user' }), /invalid_request/u);
  assert.throws(() => validateQuery({ limit: true }), /invalid_request/u);
  assert.throws(() => validateReview({ result: 'partial', effort: 'hard' }), /invalid_request/u);
  // Capture validation leaves per-item failures to the repository.
  assert.equal(validateCapture({ request_id: 'capture-raw-batch', items: [{ title: '\u0000' }, point] }).items.length, 2);
});

test('supplementary English instructions accept trimmed empty values and enforce Unicode scalar limits', () => {
  assert.deepEqual(validateSettingsPatch({ english_learning_instructions: '  Use cooking examples.\nCorrect gently.  ' }),
    { english_learning_instructions: 'Use cooking examples.\nCorrect gently.' });
  assert.equal(validateSettingsPatch({ english_learning_instructions: '\u3000\n ' }).english_learning_instructions, '');
  assert.equal(settingsWithDefaults({ english_learning_instructions: '😀'.repeat(1500) }).english_learning_instructions.length, 3000);
  for (const value of ['😀'.repeat(1501), '\u0000', '\ud800', false, {}])
    assert.throws(() => validateSettingsPatch({ english_learning_instructions: value }), /invalid_request/u);
  assert.throws(() => settingsWithDefaults({ english_learning_instructions: null }), /invalid_request/u);
  assert.deepEqual(validateSettingsPatch({ ui_language: 'zh' }), { ui_language: 'zh' }, 'an unrelated patch does not clear teaching preferences');
});

test('scene defaults are contextual and custom labels remain open-ended', () => {
  assert.deepEqual(uniqueScenes(['At home', 'ＡＴ　ＨＯＭＥ', 'at home', '旅行']), ['At home', '旅行']);
  assert.deepEqual(inferScenes({ kind: 'word', title: 'rinse' }), ['Cleaning & hygiene']);
  assert.deepEqual(inferScenes({ kind: 'word', title: 'rub', meaning: 'Massage a sore shoulder' }), []);
  assert.deepEqual(inferScenes({ kind: 'expression', title: 'turn off', meaning: 'Leave the highway' }), []);
  assert.deepEqual(inferScenes({ kind: 'word', title: 'rinse', note: '' }), []);
});

test('40 Python FSRS fixtures cover states, ratings, missing review and microseconds', () => {
  for (const item of fixtures.fsrs) {
    const actual = advance(17, item.serialized, item.rating, item.timestamp);
    near(JSON.parse(actual.card), item.expected.card, item.name + '.card');
    assert.deepEqual(JSON.parse(actual.log), item.expected.log, item.name + '.log');
    near(actual.prediction, item.expected.prediction, item.name + '.prediction');
    near(memorySnapshot(actual.card, item.timestamp, 3), item.expected.memory, item.name + '.memory');
    assert.equal(actual.due_at, item.expected.memory.due_at);
  }
  const first = advance(17, null, 2, '2026-01-01T10:20:30.012345+00:00');
  assert.equal(JSON.parse(first.card).due, '2026-01-01T10:26:00.012345+00:00');
  assert.throws(() => advance(17, first.card, 3, '2026-01-01T10:20:30.012344+00:00'), /clock_moved_backwards/u);
  assert.equal(recallRating({ result: 'correct', assisted: true }), null);
  assert.equal(recallRating('partial', false), 1);
});
