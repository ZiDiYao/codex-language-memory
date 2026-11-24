import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '../src/config.js';
import { createEnricher } from '../src/providers/index.js';

const base = {
  DATABASE_URL: 'postgresql://test@127.0.0.1/test', PUBLIC_URL: 'https://memory.example',
  AUTH_ISSUER: 'https://identity.example/', AUTH_AUDIENCE: 'memory',
  AUTH_JWKS_URL: 'https://identity.example/jwks',
};

test('DeepSeek defaults to its documented model and uses only its own credential', () => {
  const config = loadConfig({ ...base, OPENAI_API_KEY: 'unrelated-openai', SAYROVE_ENRICHMENT_API_KEY: 'unrelated-generic' });
  assert.equal(config.enrichmentProvider, 'deepseek');
  assert.equal(config.enrichmentModel, 'deepseek-flash');
  assert.equal(config.enrichmentApiKey, null);
  assert.equal(createEnricher({ provider: config.enrichmentProvider, model: config.enrichmentModel, apiKey: config.enrichmentApiKey }), null);
  const ready = loadConfig({ ...base, DEEPSEEK_API_KEY: 'deepseek-test', SAYROVE_ENRICHMENT_MODEL: 'deepseek-v4-pro' });
  assert.equal(ready.enrichmentApiKey, 'deepseek-test');
  assert.equal(ready.enrichmentModel, 'deepseek-v4-pro');
});

test('OpenAI selection is explicit and never borrows DeepSeek credentials or model defaults', () => {
  const config = loadConfig({ ...base, SAYROVE_ENRICHMENT_PROVIDER: 'openai', DEEPSEEK_API_KEY: 'unrelated' });
  assert.equal(config.enrichmentApiKey, null); assert.equal(config.enrichmentModel, null);
  const ready = loadConfig({ ...base, SAYROVE_ENRICHMENT_PROVIDER: 'openai', OPENAI_API_KEY: 'openai-test', SAYROVE_ENRICHMENT_MODEL: 'explicit-model' });
  assert.equal(ready.enrichmentApiKey, 'openai-test'); assert.equal(ready.enrichmentModel, 'explicit-model');
});

test('generic providers require their own explicit API root and credential', () => {
  assert.throws(() => loadConfig({ ...base, SAYROVE_ENRICHMENT_PROVIDER: 'openai-compatible' }), /BASE_URL/);
  const config = loadConfig({ ...base, SAYROVE_ENRICHMENT_PROVIDER: 'openai-compatible',
    SAYROVE_ENRICHMENT_BASE_URL: 'https://provider.example/v1/', SAYROVE_ENRICHMENT_API_KEY: 'generic-test',
    SAYROVE_ENRICHMENT_MODEL: 'another-model', OPENAI_API_KEY: 'unrelated', DEEPSEEK_API_KEY: 'unrelated' });
  assert.equal(config.enrichmentBaseUrl, 'https://provider.example/v1');
  assert.equal(config.enrichmentApiKey, 'generic-test'); assert.equal(config.enrichmentModel, 'another-model');
});

test('unknown vendors and unsafe endpoint configuration fail without echoing credentials', () => {
  for (const provider of ['typo', '', '__proto__', 'constructor', 1])
    assert.throws(() => loadConfig({ ...base, SAYROVE_ENRICHMENT_PROVIDER: provider }), /registered provider/);
  for (const value of ['http://127.0.0.1', 'https://user:private@provider.example', 'https://provider.example/?key=private', 'https://provider.example/#secret', 'relative']) {
    assert.throws(() => loadConfig({ ...base, SAYROVE_ENRICHMENT_BASE_URL: value }), error => {
      assert.ok(!error.message.includes('private') && !error.message.includes('secret')); return true;
    });
  }
});

test('blank optional compose variables leave the worker disabled and defaults deterministic', () => {
  const config = loadConfig({ ...base, DEEPSEEK_API_KEY: '', SAYROVE_ENRICHMENT_MODEL: '', SAYROVE_ENRICHMENT_BASE_URL: '' });
  assert.equal(config.enrichmentApiKey, null); assert.equal(config.enrichmentModel, 'deepseek-flash');
  assert.equal(config.enrichmentBaseUrl, null);
  assert.throws(() => loadConfig({ ...base, DEEPSEEK_API_KEY: 123 }), /API key/);
  assert.throws(() => loadConfig({ ...base, SAYROVE_ENRICHMENT_MODEL: 123 }), /model/);
});
