# Backend pronunciation

`GET /v1/points/:id/audio` authorizes the caller using the normal REST JWT and
retrieves the point through that verified tenant. It speaks only the current
editable `note_title` (or original title when the field is absent), never a text
or URL supplied in the audio request. Empty or excessively long titles are
rejected. No query parameters or request body are accepted.

A successful response is audio bytes with `audio/wav` (DeepSeek) or `audio/mpeg`
(compatible providers), `Cache-Control: private, no-store`, `nosniff`, and
`X-Sayrove-Speech-Source: ai`. The client fetches with its bearer token and plays
the returned bytes using HTML audio. Standalone pages use a Blob URL; native
MCP Apps use a bounded `data:audio` source permitted by the default media policy.
No public audio URL, provider credential, or local operating-system voice is needed.
The listening UI should identify the pronunciation as AI-generated.

## DeepSeek

The current official [TTS guide](https://api-docs.deepseek.com/guides/tts/) and
[API reference](https://api-docs.deepseek.com/api/tts/) document a separate speech
endpoint using the same DeepSeek API key:

```sh
SAYROVE_SPEECH_PROVIDER=deepseek
SAYROVE_SPEECH_VOICE=stella
DEEPSEEK_API_KEY=your-existing-server-side-secret
```

`stella` and `tide` are the available voices. The provider sends `text`,
`voice_id`, `format=wav` and `filter_markdown=true` to
`https://api.deepseek.com/v1/tools/tts`; it does not send a model or language
parameter. Supported language families are Chinese, Cantonese, English,
Japanese, Korean, Malay, Arabic, Indonesian, Thai and Vietnamese. Unsupported
languages receive `speech_language_unavailable` rather than an OS-voice fallback.

Speech is disabled by default, even when an enrichment key exists. The setting
must be explicitly enabled. Missing credentials leave audio unavailable and
advertise `_capabilities.cloud_speech=false`; no fabricated audio is returned.
No additional database migration is required.

## Other speech providers

An explicit `/audio/speech`-compatible adapter preserves provider/model expansion:

```sh
SAYROVE_SPEECH_PROVIDER=openai-compatible
SAYROVE_SPEECH_API_KEY=your-speech-provider-secret
SAYROVE_SPEECH_MODEL=your-supported-speech-model
SAYROVE_SPEECH_VOICE=your-supported-voice
SAYROVE_SPEECH_BASE_URL=https://your-speech-provider.example/v1
```

This sends `model`, `input`, `voice`, and `response_format=mp3`. No automatic
cross-vendor credential or model fallback is performed. Roots require HTTPS and
cannot contain credentials, a query or fragment; redirects are rejected.

## Bounds and caching

The per-process cache is bounded to 64 entries / 16 MiB with a 24-hour TTL.
Keys include the verified tenant, provider, model, voice, API root, record
language and current title. Every request still reauthorizes and rereads the
record, so another tenant or a deleted record cannot obtain a cached result.
Editing a title selects a new cache key. Identical simultaneous requests share
one synthesis, but canceling one listener does not cancel other listeners.

Defaults are two global synthesis jobs, one job per tenant, and 30 new synthesis
requests per minute per tenant. Cached playback does not consume this budget.
Each synthesis has a 15-second deadline and a 2-MiB decoded-audio limit. Known
WAV/content-length truncation, bad MIME types, redirects and provider failures
are rejected and never cached. Disconnecting the final listener cancels provider
work; shutdown also aborts active jobs.

Errors remain JSON: `speech_unavailable` (503), `speech_busy` (429),
`speech_text_unavailable` or `speech_language_unavailable` (422), and ordinary
authenticated `not_found` (404). Provider bodies, API keys and raw titles are
never copied to error messages or logs.

Tests use fake audio and isolated signed JWT / HTTP fixtures. They do not
contact a paid speech endpoint or create production learning records.
