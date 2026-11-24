import { JSON_INSTRUCTIONS, configured, endpoint, requestJson, parseContent } from './shared.js';

/** Shared Chat JSON transport; only explicitly selected vendor features are sent. */
export function createChatEnricher({ apiKey, model, baseUrl, fetchImpl = fetch, deepseek = false } = {}) {
  if (!configured({ apiKey, model })) return null;
  const url = endpoint(baseUrl, 'chat/completions');
  return async (input, { signal } = {}) => {
    const body = await requestJson(fetchImpl, url, { apiKey, signal, body: {
      model, stream: false, max_tokens: 1600, response_format: { type: 'json_object' },
      ...(deepseek ? { thinking: { type: 'disabled' } } : {}),
      messages: [{ role: 'system', content: JSON_INSTRUCTIONS }, { role: 'user', content: JSON.stringify(input) }],
    } });
    if (!Array.isArray(body.choices)) throw new Error('invalid_provider_response');
    const choice = body.choices[0];
    if (!choice || choice.finish_reason !== 'stop') throw new Error('provider_incomplete');
    const message = choice.message;
    if (!message || message.role !== 'assistant' || message.refusal || (message.tool_calls != null && (!Array.isArray(message.tool_calls) || message.tool_calls.length))
      || message.function_call || (message.server_tool_calls != null && (!Array.isArray(message.server_tool_calls) || message.server_tool_calls.length))) throw new Error('invalid_provider_response');
    // Reasoning content is deliberately ignored. A blank final answer cannot be
    // rescued by parsing thinking tokens, a later choice, or another vendor.
    return parseContent(message.content);
  };
}

export function createCompatibleEnricher(options = {}) {
  if (!configured(options)) return null;
  if (!options.baseUrl) throw new Error('provider_base_url_required');
  return createChatEnricher({ ...options, deepseek: false });
}
