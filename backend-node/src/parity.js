/** Data compatibility with the retained Python backend. No Python process is used. */
import { createHash } from 'node:crypto';
import unicode from './unicode-python.json' with { type: 'json' };

const whitespace = new Set([...unicode.whitespace]);
export function nfkc(value) {
  // ICU may know characters newer than Python's pinned Unicode tables. Those
  // codepoints are normalization boundaries in Python; preserve their mapping
  // instead of silently changing identities when Node upgrades its ICU data.
  let result = '', chunk = '';
  for (const char of value) {
    if (Object.hasOwn(unicode.nfkc_protected, char)) {
      result += chunk.normalize('NFKC') + unicode.nfkc_protected[char]; chunk = '';
    } else chunk += char;
  }
  return result + chunk.normalize('NFKC');
}
export function pyTrim(value) {
  const chars = [...value];
  let start = 0, end = chars.length;
  while (start < end && whitespace.has(chars[start])) start++;
  while (end > start && whitespace.has(chars[end - 1])) end--;
  return chars.slice(start, end).join('');
}
export function collapseWhitespace(value) {
  let result = '', pending = false;
  for (const char of value) {
    if (whitespace.has(char)) { if (result) pending = true; }
    else { if (pending) result += ' '; result += char; pending = false; }
  }
  return result;
}
export function normalized(value) {
  return collapseWhitespace([...nfkc(value)].map(char => unicode.casefold[char] ?? char).join(''));
}
function compareKeys(left, right) {
  const a = [...left], b = [...right];
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const delta = a[i].codePointAt(0) - b[i].codePointAt(0);
    if (delta) return delta;
  }
  return a.length - b.length;
}
export function encode(value, { ensureAscii = false } = {}) {
  function dump(item) {
    if (item === null) return 'null';
    if (typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'number' && Number.isFinite(item)) return JSON.stringify(item);
    if (Array.isArray(item)) return '[' + item.map(dump).join(',') + ']';
    if (typeof item === 'object') return '{' + Object.keys(item).sort(compareKeys).map(key => JSON.stringify(key) + ':' + dump(item[key])).join(',') + '}';
    throw new TypeError('invalid_json');
  }
  const result = dump(value);
  return ensureAscii ? result.replace(/[\u007f-\uffff]/g, char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0')) : result;
}
export const encodeAscii = value => encode(value, { ensureAscii: true });
export const fingerprint = (value, options) => createHash('sha256').update(encode(value, options)).digest('hex');
export const fingerprintAscii = value => fingerprint(value, { ensureAscii: true });

const contentFields = ['sense_key', 'meaning', 'explanation', 'context', 'corrected_sentence', 'examples'];
const arrayValue = value => typeof value === 'string' ? JSON.parse(value || '[]') : value || [];
export function capturedSense(point) {
  const result = Object.fromEntries(contentFields.map(key => [key, point[key] ?? null]));
  if (typeof result.examples === 'string') result.examples = JSON.parse(result.examples);
  return result;
}
export function allSenses(point) { return [capturedSense(point), ...arrayValue(point.additional_senses)]; }
export function generatedNote(point) {
  const texts = allSenses(point).map(sense => [
    sense.meaning, sense.explanation, sense.context, sense.corrected_sentence,
    ...(sense.examples || []).map(example => [example.text, example.translation].filter(Boolean).join('\n')),
  ].filter(Boolean).join('\n\n'));
  return [point.title, ...texts].filter(Boolean).join('\n\n');
}
export function mergeSense(point, incoming) {
  const senses = allSenses(point), candidate = capturedSense(incoming);
  if (senses.some(sense => normalized(sense.sense_key) === normalized(candidate.sense_key) || normalized(sense.meaning) === normalized(candidate.meaning))) return senses.slice(1);
  return [...senses.slice(1), candidate];
}
const publicFields = ['id', 'kind', 'language', 'title', 'sense_key', 'meaning', 'context',
  'corrected_sentence', 'explanation', 'note', 'status', 'encounter_count', 'repeat_priority',
  'last_review_result', 'created_at', 'last_seen_at', 'last_reviewed_at'];
const revisionFields = ['title', 'sense_key', 'meaning', 'context', 'corrected_sentence',
  'explanation', 'examples', 'status', 'note', 'additional_senses', 'scenes'];
export function serializeRecord(point) {
  const result = Object.fromEntries(publicFields.map(key => [key, point[key] ?? null]));
  for (const key of ['examples', 'additional_senses', 'scenes']) result[key] = arrayValue(point[key]);
  result.content_ready = result.note !== null || Boolean(result.explanation && pyTrim(result.explanation) && new Set(result.examples.map(example => normalized(example.text))).size >= 2);
  result.revision = fingerprint(Object.fromEntries(revisionFields.map(key => [key, result[key] ?? null])));
  result.note_is_custom = result.note !== null;
  if (result.note === null) result.note = generatedNote(result);
  const lines = result.note.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/u).map(pyTrim).filter(Boolean);
  result.note_title = [...(lines[0] || '')].slice(0, 350).join('');
  result.note_preview = [...(lines[1] || '')].slice(0, 500).join('');
  return result;
}
