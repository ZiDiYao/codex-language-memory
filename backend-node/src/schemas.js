/** Strict Pydantic-compatible public shapes, with Unicode scalar length checks. */
import { z } from 'zod';
import { collapseWhitespace, normalized, pyTrim, nfkc } from './parity.js';
import { uniqueScenes } from './scenes.js';

export class ValidationError extends Error {
  constructor() { super('invalid_request'); this.name = 'ValidationError'; this.code = 'invalid_request'; }
}
export function validateDatabaseText(value) {
  if (typeof value === 'string') {
    for (const char of value) {
      const cp = char.codePointAt(0);
      if (cp === 0 || (cp >= 0xd800 && cp <= 0xdfff)) throw new ValidationError();
    }
  } else if (Array.isArray(value)) value.forEach(validateDatabaseText);
  else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) { validateDatabaseText(key); validateDatabaseText(item); }
  return value;
}
function string({ min = 1, max, trim = true, transform = value => value, pattern } = {}) {
  return z.string().transform((raw, context) => {
    let value;
    try { validateDatabaseText(raw); value = transform(trim ? pyTrim(raw) : raw); }
    catch { context.addIssue({ code: 'custom', message: 'invalid_request' }); return z.NEVER; }
    const length = [...value].length;
    if (length < min || (max !== undefined && length > max) || (pattern && !pattern.test(value))) {
      context.addIssue({ code: 'custom', message: 'invalid_request' }); return z.NEVER;
    }
    return value;
  });
}
export const title = string({ max: 350 });
export const text = string({ max: 2000 });
export const senseKey = string({ max: 150 });
export const language = string({ max: 35, transform: value => value.toLowerCase(), pattern: /^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/u });
export const sceneName = string({ max: 80, transform: value => collapseWhitespace(nfkc(value)), pattern: /^[^,;]+$/u });
export const requestId = string({ trim: false, max: 100, min: 8, pattern: /^[a-zA-Z0-9_-]{8,100}$/u });
export const revision = string({ trim: false, min: 64, max: 64, pattern: /^[a-f0-9]{64}$/u });
export const recordId = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
export const limit = z.number().int().min(1).max(50);
export const kind = z.enum(['word', 'expression', 'grammar', 'correction']);
export const status = z.enum(['new', 'mastered']);
const reviewResult = z.enum(['correct', 'partial', 'incorrect', 'skipped']);
const uiLanguage = z.enum(['en', 'zh', 'ja', 'ko', 'fr', 'es']);
const scenes = z.array(sceneName).max(12).transform(uniqueScenes);
const example = z.object({ text, translation: text.nullable().default(null) }).strict();
const patchExample = z.object({ text, translation: text.nullable().optional() }).strict();
const optional = schema => schema.nullable().optional();
const defaultNull = schema => schema.nullable().default(null);
const content = {
  meaning: defaultNull(text), context: defaultNull(text), corrected_sentence: defaultNull(text),
  explanation: defaultNull(text), examples: defaultNull(z.array(example).max(5)), scenes: defaultNull(scenes),
};
const point = z.object({ ...content, kind, language, title, sense_key: senseKey,
  meaning: text, explanation: text, examples: z.array(example).min(2).max(5),
}).strict().refine(value => new Set(value.examples.map(item => normalized(item.text))).size === value.examples.length, { message: 'invalid_request' });
const patch = z.object({
  meaning: optional(text), context: optional(text), corrected_sentence: optional(text),
  explanation: optional(text), examples: optional(z.array(patchExample).max(5)), scenes: optional(scenes),
  note: optional(string({ min: 0, max: 30000, trim: false })), title: optional(title),
  sense_key: optional(senseKey), status: optional(status), review_result: optional(reviewResult),
}).strict();
const review = z.object({ result: reviewResult, assisted: z.boolean().default(false),
  effort: z.enum(['standard', 'hard', 'easy']).default('standard'),
  prompt: defaultNull(text), answer: defaultNull(text),
}).strict().refine(value => value.effort === 'standard' || (value.result === 'correct' && !value.assisted), { message: 'invalid_request' });
const settingsFields = { enabled: z.boolean(), ui_language: uiLanguage,
  first_language: language.nullable(), explanation_language: language.nullable(), enabled_types: z.array(kind).max(4) };
const settings = z.preprocess(value => {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const result = { ...value }; for (const name of ['capture_mode','target_language','target_languages']) delete result[name]; return result;
  }
  return value;
}, z.object({ enabled: z.boolean().default(true), ui_language: uiLanguage.default('en'),
  first_language: language.nullable().default(null), explanation_language: language.nullable().default(null),
  enabled_types: z.array(kind).max(4).default(['word','expression','grammar','correction']),
}).strict());
const settingsPatch = z.object(Object.fromEntries(Object.entries(settingsFields).map(([key, schema]) => [key, schema.nullable().optional()]))).strict();
const sceneScope = { language: defaultNull(language), kind: defaultNull(kind), include_variants: z.boolean().default(false) };
const query = z.object({ ...sceneScope, keyword: defaultNull(title), scene: defaultNull(sceneName), status: defaultNull(status),
  limit: limit.default(20), offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  cursor: defaultNull(string({ min: 0, max: 300, trim: false })), needs_enrichment: z.boolean().default(false),
}).strict();
const sceneQuery = z.object(sceneScope).strict();
const reviewQuery = z.object({ ...sceneScope, scene: defaultNull(sceneName), limit: limit.default(5), include_upcoming: z.boolean().default(false) }).strict();
const capture = z.object({ request_id: requestId, items: z.array(z.record(z.string(), z.unknown())).min(1).max(20), source: z.enum(['automatic','explicit']).default('automatic') }).strict();
const pointUpdate = z.object({ patch, expected_revision: defaultNull(revision) }).strict();
const reviewAttempt = z.object({ record_id: recordId, request_id: requestId, review }).strict();
export const schemas = { point, patch, review, settings, settingsPatch, query, sceneQuery, reviewQuery, capture, pointUpdate, reviewAttempt,
  KnowledgePoint: point, Patch: patch, Review: review, LearningSettings: settings, SettingsPatch: settingsPatch,
  Query: query, SceneQuery: sceneQuery, ReviewQuery: reviewQuery, Capture: capture, PointUpdate: pointUpdate, ReviewAttempt: reviewAttempt,
};
export function parse(name, value) {
  const schema = typeof name === 'string' ? schemas[name] : name;
  if (!schema) throw new ValidationError();
  try {
    // Capture items are validated individually by the repository. One invalid
    // item must not prevent valid items in the same batch from being saved.
    if (schema !== capture) validateDatabaseText(value);
    return schema.parse(value);
  } catch { throw new ValidationError(); }
}
export const validatePoint = value => parse('point', value);
export const validatePatch = value => parse('patch', value);
export const validateReview = value => parse('review', value);
export const settingsWithDefaults = value => parse('settings', value);
export const validateSettingsPatch = value => parse('settingsPatch', value);
export const validateRequestId = value => parse(requestId, value);
export const validateCapture = value => parse('capture', value);
export const validateQuery = value => parse('query', value);
export const validateSceneQuery = value => parse('sceneQuery', value);
export const validateReviewQuery = value => parse('reviewQuery', value);
export const validatePointUpdate = value => parse('pointUpdate', value);
export const validateReviewAttempt = value => parse('reviewAttempt', value);
