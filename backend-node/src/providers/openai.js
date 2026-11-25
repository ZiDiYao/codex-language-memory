import { CONTENT_SCHEMA, LEARNING_INSTRUCTIONS, NOTE_OUTPUT_TOKENS, configured, endpoint, requestJson, parseContent } from './shared.js';

/** Explicit OpenAI selection uses Responses strict structured output. */
export function createOpenAIEnricher({ apiKey, model, baseUrl = 'https://api.openai.com/v1', fetchImpl = fetch } = {}) {
  if (!configured({ apiKey, model })) return null;
  const url = endpoint(baseUrl, 'responses');
  return async (input, { signal } = {}) => {
    const body = await requestJson(fetchImpl, url, { apiKey, signal, body: {
      model, store: false, max_output_tokens: NOTE_OUTPUT_TOKENS, instructions: LEARNING_INSTRUCTIONS,
      input: JSON.stringify(input), text: { format: { type: 'json_schema', name: 'learning_note', strict: true, schema: CONTENT_SCHEMA } },
    } });
    if (body.status !== 'completed' || !Array.isArray(body.output)) throw new Error('provider_incomplete');
    if (body.output.some(item => !item || typeof item !== 'object')) throw new Error('invalid_provider_response');
    const messages = body.output.filter(item => item.type === 'message');
    if (!messages.length || messages.some(item => !Array.isArray(item.content))) throw new Error('invalid_provider_response');
    const texts = messages.flatMap(item => item.content);
    if (texts.some(item => !item || item.type === 'refusal')) throw new Error('provider_refused');
    return parseContent(texts.filter(item => item.type === 'output_text').map(item => item.text).join(''));
  };
}
