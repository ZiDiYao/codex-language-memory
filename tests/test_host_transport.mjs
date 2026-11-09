import test from "node:test";
import assert from "node:assert/strict";
import { createHostTransport } from "../web/host-transport.js";

test("native bridge forwards validated page requests and preserves HTTP error semantics", async () => {
  const calls = [];
  const host = createHostTransport({ callServerTool: async (request) => {
    calls.push(request);
    return { structuredContent: { status: 400, data: { error: "invalid_request" } } };
  } });
  const response = await host.request("api", { action: "settings/read", arguments: {} });
  assert.equal(calls[0].name, "memory_app_request");
  assert.equal(calls[0].arguments.route, "api");
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "invalid_request" });
});

test("native download preserves bytes and acknowledges only successful host delivery", async () => {
  const source = Uint8Array.from([0, 128, 255, 42]);
  const calls = [];
  let cancel = true;
  const host = createHostTransport({
    getHostCapabilities: () => ({ downloadFile: {} }),
    callServerTool: async ({ arguments: args }) => {
      calls.push(args.route);
      return { structuredContent: args.route === "export" ? { status: 200, file: {
        blob: Buffer.from(source).toString("base64"), mime_type: "application/pdf", filename: "notes.pdf", count: 2, receipt: "test-receipt",
      } } : { status: 200, data: { status: "ok" } } };
    },
    downloadFile: async ({ contents }) => {
      assert.deepEqual(Buffer.from(contents[0].resource.blob, "base64"), Buffer.from(source));
      assert.equal(contents[0].resource.uri, "file:///notes.pdf");
      return { isError: cancel };
    },
  });
  const response = await host.request("export", { format: "pdf" });
  const blob = await response.blob();
  assert.equal(response.headers.get("X-Record-Count"), "2");
  await assert.rejects(host.download(blob, "notes.pdf", "test-receipt"));
  assert.deepEqual(calls, ["export"]);
  cancel = false;
  await host.download(blob, "notes.pdf", "test-receipt");
  assert.deepEqual(calls, ["export", "export_complete"]);
});

test("host errors and malformed replies cannot masquerade as saved changes", async () => {
  for (const result of [{ isError: true }, {}, { structuredContent: { status: "ok" } }]) {
    const host = createHostTransport({ callServerTool: async () => result });
    await assert.rejects(host.request("api", { action: "settings/update", arguments: { ui_language: "en" } }));
  }
});
