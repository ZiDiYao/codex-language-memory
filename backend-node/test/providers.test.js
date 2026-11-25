import test from 'node:test';
import assert from 'node:assert/strict';
import { createEnricher, PROVIDER_FACTORIES } from '../src/providers/index.js';
import { createOpenAIEnricher as legacyOpenAI } from '../src/enrichment.js';
import { createOpenAIEnricher } from '../src/providers/openai.js';
import { CONTENT_SCHEMA, NOTE_OUTPUT_TOKENS, LEARNING_INSTRUCTIONS } from '../src/providers/shared.js';

const input = { target: { kind: 'word', language: 'en', title: 'celery', context: '芹菜的英文咋说' },
  explanation_language: 'zh', existing_senses: [], scene_names: ['Food & cooking'] };
const note = { sense_key: 'vegetable', meaning: '芹菜', explanation: 'Usually uncountable.', corrected_sentence: null,
  examples: [{ text: 'Buy some celery.', translation: '买点芹菜。' }, { text: 'Add celery to the soup.', translation: null }], scenes: ['Food & cooking'] };
const chat = (overrides = {}) => ({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(note) }, ...overrides }] });
const response = body => ({ ok: true, status: 200, json: async () => body });
const options = { apiKey: 'isolated-test-key', model: 'test-model' };

function mock(body = chat()) {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, ...init, body: JSON.parse(init.body) }); return response(body); };
  return { calls, fetchImpl };
}

test('DeepSeek is the factory default and has an isolated non-thinking JSON request contract', async () => {
  const { calls, fetchImpl } = mock(); const controller = new AbortController();
  const provider = createEnricher({ ...options, model: 'deepseek-flash', fetchImpl });
  assert.deepEqual(await provider(input, { signal: controller.signal }), note);
  assert.equal(calls.length, 1);
  const request = calls[0];
  assert.equal(request.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(request.method, 'POST'); assert.equal(request.redirect, 'error');
  assert.equal(request.signal, controller.signal);
  assert.equal(request.headers.Authorization, 'Bearer isolated-test-key');
  assert.equal(request.body.model, 'deepseek-flash');
  assert.equal(request.body.stream, false); assert.equal(request.body.max_tokens, 3600);
  assert.deepEqual(request.body.thinking, { type: 'disabled' });
  assert.deepEqual(request.body.response_format, { type: 'json_object' });
  assert.equal(Object.hasOwn(request.body, 'store'), false);
  assert.match(request.body.messages[0].content, /JSON Schema/u);
  assert.match(request.body.messages[0].content, /Example JSON/u);
  assert.match(request.body.messages[0].content, /Codex has already identified/u);
  assert.match(request.body.messages[0].content, /Do not identify new gaps/u);
  assert.deepEqual(JSON.parse(request.body.messages[1].content), input);
});

test('DeepSeek model and API root are explicit overrides, with no hardcoded model routing', async () => {
  const { calls, fetchImpl } = mock();
  await createEnricher({ provider: 'deepseek', ...options, model: 'future-model-id', baseUrl: 'https://api.deepseek.com/v1/', fetchImpl })(input);
  assert.equal(calls[0].url, 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(calls[0].body.model, 'future-model-id');
});

test('OpenAI keeps Responses strict schema semantics and backwards-compatible reexport', async () => {
  assert.equal(legacyOpenAI, createOpenAIEnricher);
  const { calls, fetchImpl } = mock({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(note) }] }] });
  assert.deepEqual(await createEnricher({ provider: 'openai', ...options, fetchImpl })(input), note);
  assert.equal(calls[0].url, 'https://api.openai.com/v1/responses');
  assert.equal(calls[0].body.store, false); assert.equal(calls[0].body.max_output_tokens, 3600);
  assert.equal(calls[0].body.text.format.strict, true);
  assert.deepEqual(calls[0].body.text.format.schema, CONTENT_SCHEMA);
  assert.equal(Object.hasOwn(calls[0].body, 'thinking'), false);
});

test('all enrichment adapters allow a substantial same-target word lesson without losing examples or Unicode', async () => {
  const target = { ...input, target: { kind: 'word', language: 'en', title: 'secure', context: 'They secured funding.' } };
  const expanded = { sense_key: 'obtain', meaning: '（动词）争取到、获得。', corrected_sentence: null,
    explanation: '当前用法：secure funding 是争取到资金。\n常见词性：动词还可表示固定、使安全；形容词表示安全可靠或稳定。\n' +
      '搭配：secure permission 获得许可；a secure job 稳定的工作；feel secure 感到安心。\n' +
      '句型：secure something with something，用某物固定某物。secure a job 是获得工作，a secure job 是稳定工作。',
    examples: [
      { text: 'They secured funding for the project.', translation: '他们为项目争取到了资金。' },
      { text: 'Secure the bag with a strap.', translation: '用带子固定好包。' },
      { text: 'Choose a secure password.', translation: '选一个安全性高的密码。' },
      { text: 'She has a secure job.', translation: '她有一份稳定的工作。' },
      { text: 'The children feel secure at home.', translation: '孩子们在家感到安心。' },
    ], scenes: ['Work & projects', 'Safety & security'] };
  for (const providerName of ['deepseek', 'openai-compatible', 'openai']) {
    const body = providerName === 'openai'
      ? { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(expanded) }] }] }
      : chat({ message: { role: 'assistant', content: JSON.stringify(expanded) } });
    const { calls, fetchImpl } = mock(body);
    const provider = createEnricher({ provider: providerName, ...options,
      ...(providerName === 'openai-compatible' ? { baseUrl: 'https://compatible.example/v1' } : {}), fetchImpl });
    assert.deepEqual(await provider(target), expanded);
    const request = calls[0].body;
    assert.equal(request.max_tokens ?? request.max_output_tokens, NOTE_OUTPUT_TOKENS);
    const instructions = request.instructions ?? request.messages[0].content;
    assert.ok(instructions.startsWith(LEARNING_INSTRUCTIONS));
    assert.match(instructions, /other common, practically relevant uses/u);
    assert.match(instructions, /supporting material inside this one note/u);
    assert.match(instructions, /hard field limit 2000/u);
    assert.match(instructions, /sense_key represents the observed sense/u);
  }
});

test('Generic compatible provider requires its own API root and sends no DeepSeek-only options', async () => {
  const { calls, fetchImpl } = mock();
  const generic = { provider: 'openai-compatible', ...options, baseUrl: 'https://private-provider.example/custom/v1', fetchImpl };
  assert.deepEqual(await createEnricher(generic)(input), note);
  assert.equal(calls[0].url, 'https://private-provider.example/custom/v1/chat/completions');
  assert.equal(Object.hasOwn(calls[0].body, 'thinking'), false);
  assert.equal(Object.hasOwn(calls[0].body, 'store'), false);
  assert.deepEqual(calls[0].body.response_format, { type: 'json_object' });
  assert.throws(() => createEnricher({ provider: 'openai-compatible', ...options }), /provider_base_url_required/u);
});

test('Missing provider key/model disables work and unknown providers fail without fallback', () => {
  for (const provider of Object.keys(PROVIDER_FACTORIES)) {
    assert.equal(createEnricher({ provider }), null);
    assert.equal(createEnricher({ provider, apiKey: 'test-only' }), null);
    assert.equal(createEnricher({ provider, model: 'test-model' }), null);
  }
  assert.throws(() => createEnricher({ provider: 'unknown' }), /unsupported_enrichment_provider/u);
  assert.throws(() => createEnricher({ provider: '__proto__', ...options }), /unsupported_enrichment_provider/u);
  assert.throws(() => createEnricher({ ...options, model: ' ' }), /invalid_provider_configuration/u);
});

test('Provider registry can be extended without editing worker or built-in model routing', async () => {
  let received;
  const registry = { ...PROVIDER_FACTORIES, 'future-vendor': configured => { received = configured; return async () => note; } };
  const custom = createEnricher({ provider: 'future-vendor', ...options }, registry);
  assert.deepEqual(received, options); assert.deepEqual(await custom(input), note);
  assert.equal(Object.hasOwn(PROVIDER_FACTORIES, 'future-vendor'), false);
});

test('Provider endpoints require HTTPS and never embed credentials or opaque URL parts', () => {
  for (const baseUrl of ['http://api.deepseek.com', 'http://127.0.0.1:1234', 'file:///etc/passwd', 'https://user:secret@api.deepseek.com',
    'https://api.deepseek.com?secret=x', 'https://api.deepseek.com#fragment', 'invalid']) {
    for (const provider of Object.keys(PROVIDER_FACTORIES))
      assert.throws(() => createEnricher({ provider, ...options, baseUrl }), /invalid_provider_base_url/u);
  }
});

for (const [label, body] of [
  ['missing choices', {}], ['not an array', { choices: { 0: chat().choices[0] } }], ['no first choice', { choices: [] }],
  ['truncated', chat({ finish_reason: 'length' })], ['filtered', chat({ finish_reason: 'content_filter' })],
  ['aborted', chat({ finish_reason: 'aborted' })], ['tool finish', chat({ finish_reason: 'tool_calls' })],
  ['blank', chat({ message: { role: 'assistant', content: '   ', reasoning_content: JSON.stringify(note) } })],
  ['null content', chat({ message: { role: 'assistant', content: null } })],
  ['malformed JSON', chat({ message: { role: 'assistant', content: '{"partial":' } })],
  ['array JSON', chat({ message: { role: 'assistant', content: '[]' } })],
  ['null JSON', chat({ message: { role: 'assistant', content: 'null' } })],
  ['scalar JSON', chat({ message: { role: 'assistant', content: '1' } })],
  ['refusal', chat({ message: { role: 'assistant', content: JSON.stringify(note), refusal: 'blocked' } })],
  ['tool calls', chat({ message: { role: 'assistant', content: JSON.stringify(note), tool_calls: [{ id: 'call' }] } })],
  ['server tool calls', chat({ message: { role: 'assistant', content: JSON.stringify(note), server_tool_calls: [{ id: 'call' }] } })],
  ['legacy function call', chat({ message: { role: 'assistant', content: JSON.stringify(note), function_call: {} } })],
  ['wrong role', chat({ message: { role: 'tool', content: JSON.stringify(note) } })],
]) test(`Chat provider rejects ${label} without vendor fallback`, async () => {
  const { calls, fetchImpl } = mock(body);
  await assert.rejects(createEnricher({ ...options, fetchImpl })(input));
  assert.equal(calls.length, 1);
});

test('Only the first final content is parsed; reasoning and alternate choices are not substitutes', async () => {
  const body = chat({ message: { role: 'assistant', content: ' ', reasoning_content: JSON.stringify(note) } });
  body.choices.push(chat().choices[0]);
  const { fetchImpl } = mock(body);
  await assert.rejects(createEnricher({ ...options, fetchImpl })(input), /invalid_provider_content/u);
});

test('HTTP errors, redirect responses and invalid JSON responses do not expose provider errors', async () => {
  for (const value of [
    { ok: false, status: 401, json: async () => ({ error: { message: 'secret provider detail' } }) },
    { ok: true, status: 200, redirected: true, json: async () => chat() },
    { ok: true, status: 302, json: async () => chat() },
    { ok: true, status: 200, json: async () => { throw new Error('secret parse detail'); } },
  ]) {
    let calls = 0;
    const provider = createEnricher({ ...options, fetchImpl: async () => { calls++; return value; } });
    await assert.rejects(provider(input), error => !error.message.includes('secret'));
    assert.equal(calls, 1);
  }
});

test('Request cancellation signal reaches the selected provider transport unchanged', async () => {
  const controller = new AbortController();
  const provider = createEnricher({ ...options, fetchImpl: async (_url, init) => {
    assert.equal(init.signal, controller.signal);
    return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  } });
  const pending = provider(input, { signal: controller.signal }); controller.abort();
  await assert.rejects(pending, /aborted/u);
});
