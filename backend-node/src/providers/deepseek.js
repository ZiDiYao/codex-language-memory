import { createChatEnricher } from './chat-completions.js';

/** DeepSeek's current default enables thinking; note enrichment explicitly disables it. */
export function createDeepSeekEnricher({ baseUrl = 'https://api.deepseek.com', ...options } = {}) {
  return createChatEnricher({ ...options, baseUrl, deepseek: true });
}
