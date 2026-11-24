import { createDeepSeekEnricher } from './deepseek.js';
import { createOpenAIEnricher } from './openai.js';
import { createCompatibleEnricher } from './chat-completions.js';

/** Extend by adding a provider factory; model names are configuration, not branches. */
export const PROVIDER_FACTORIES = Object.freeze({
  deepseek: createDeepSeekEnricher,
  openai: createOpenAIEnricher,
  'openai-compatible': createCompatibleEnricher,
});

export function createEnricher({ provider = 'deepseek', ...options } = {}, registry = PROVIDER_FACTORIES) {
  if (typeof provider !== 'string' || !Object.hasOwn(registry, provider) || typeof registry[provider] !== 'function')
    throw new Error('unsupported_enrichment_provider');
  // No fallback: a missing key/model leaves jobs pending for this selected vendor.
  return registry[provider](options);
}

export { createDeepSeekEnricher, createOpenAIEnricher, createCompatibleEnricher };
