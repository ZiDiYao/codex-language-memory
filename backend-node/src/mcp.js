import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { schemas, ValidationError } from "./schemas.js";

const empty = z.object({}).strict();
const recordId = z.number().int().positive();
const revision = z.string().regex(/^[a-f0-9]{64}$/).nullable().default(null);
const read = { readOnlyHint: true, openWorldHint: false };
const write = { destructiveHint: false, openWorldHint: false };

/** Every transport and tool closure belongs to exactly one verified principal. */
export function createMcpServer({ repositoryFactory, principal, logger = console }) {
  const server = new McpServer({ name: "language_memory_cloud", version: "0.1.0-beta.1" }, {
    instructions: "Authenticated cloud language memory. Every operation is isolated to the authenticated learner. " +
      "Supported features are captures, notes, scenes, settings and actual reviews. " +
      "No desktop UI, local speech, exports or persistent guided-study sessions are provided.",
    maxToolInputElements: 20000,
  });
  async function call(method, ...arguments_) {
    try { return await repositoryFactory(principal)[method](...arguments_); }
    catch (error) {
      if (error instanceof ValidationError || error?.code === "invalid_request") return { status: "failed", error: "invalid_request" };
      logger.error("cloud_repository_failed");
      return { status: "failed", error: "unavailable" };
    }
  }
  function tool(name, description, inputSchema, operation, annotations = read) {
    server.registerTool(name, { description, inputSchema, annotations }, async (arguments_) => {
      const result = await operation(arguments_);
      return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
    });
  }
  tool("get_settings", "Read this learner's recording and language preferences.", empty, async () => ({ ...await call("settings"), _capabilities: { lightweight_capture: true } }));
  tool("update_settings", "Update only supplied preferences for this learner.", z.object({ patch: schemas.settingsPatch }).strict(),
    ({ patch }) => call("settings", patch), write);
  tool("get_recording", "Read whether new language-learning captures are enabled.", empty, async () => {
    const result = await call("settings");
    return "enabled" in result ? { enabled: result.enabled } : result;
  });
  tool("set_recording", "Enable or pause new captures; retain existing notes.", z.object({ enabled: z.boolean() }).strict(), async ({ enabled }) => {
    const result = await call("settings", { enabled });
    return "enabled" in result ? { enabled: result.enabled } : result;
  }, write);
  tool("capture_points", "Record only real learning targets and necessary context. Supply kind, language and title; " +
    "optional context and corrected_sentence. Backend normalization deduplicates targets and a durable background job enriches content. " +
    "Do not generate definitions, examples or scenes. Reuse request_id and exact items on uncertain retries.", schemas.observations,
  ({ request_id, items, source }) => call("observe", request_id, items, source), write);
  tool("save_points", "Save a real learning encounter. Supply kind, language, title, sense_key, meaning, explanation, " +
    "two distinct examples and contextual scenes. A point can belong to several scenes. Reuse existing scene names. " +
    "Retry uncertain results with the same request_id and exact items; never fabricate encounters.", schemas.capture,
  ({ request_id, items, source }) => call("save", request_id, items, source), write);
  tool("find_points", "Search this learner's current notes, combining language, scene and type filters. Follow next_cursor.",
    schemas.query.extend({ limit: z.number().int().min(1).max(50).default(10) }), (filters) => call("query", filters));
  tool("list_scenes", "List this learner's scene names and counts, optionally restricted by language or type.",
    schemas.sceneQuery, (filters) => call("scenes", filters));
  tool("list_languages", "List only languages observed in this learner's saved notes.", empty, () => call("languages"));
  tool("update_point", "Edit this learner's note, scenes or mastery. Pass expected_revision to protect concurrent edits. " +
    "Record quizzes with record_review.", z.object({ record_id: recordId, patch: schemas.patch, expected_revision: revision }).strict(),
  ({ record_id, patch, expected_revision }) => call("update", record_id, patch, expected_revision), write);
  tool("delete_point", "Delete a specified note belonging to this learner.", z.object({ record_id: recordId }).strict(),
    ({ record_id }) => call("delete", record_id), { destructiveHint: true, openWorldHint: false });
  tool("review_queue", "Retrieve due reviews or explicitly requested early practice, without recording a result.",
    schemas.reviewQuery.extend({ exclude_ids: z.array(recordId).max(100).nullable().default(null) }), (filters) => call("review", filters));
  tool("record_review", "Record one actual quiz answer idempotently. Mark assisted after hints or recent answer exposure. " +
    "Reading is not a quiz result.", schemas.reviewAttempt,
  ({ record_id, request_id, review }) => call("record_review", record_id, request_id, review), write);
  return server;
}

export async function handleMcpRequest(request, response, body, { config, repositoryFactory, principal, logger }) {
  const server = createMcpServer({ repositoryFactory, principal, logger });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, enableJsonResponse: true,
    enableDnsRebindingProtection: true,
    allowedHosts: [new URL(config.publicUrl).host], allowedOrigins: [new URL(config.publicUrl).origin],
    maxRequestBodySize: 1024 * 1024,
  });
  const close = () => { server.close().catch(() => {}); };
  response.once("close", close);
  try {
    await server.connect(transport);
    await transport.handleRequest(request, response, body);
  } finally {
    response.off("close", close);
    await server.close().catch(() => {});
  }
}
