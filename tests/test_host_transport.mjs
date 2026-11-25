import test from "node:test";
import assert from "node:assert/strict";
import { createHostTransport } from "../web/host-transport.js";
import { MAX_AUDIO_BYTES } from "../web/pronunciation.js";

test("native pronunciation preserves binary audio without a file download or export receipt", async () => {
  const bytes = Uint8Array.from([0, 128, 255, 42]);
  const calls = [];
  const host = createHostTransport({
    callServerTool: async (request) => {
      calls.push(request.arguments);
      return { structuredContent: { status: 200, audio: {
        blob: Buffer.from(bytes).toString("base64"), mime_type: "audio/wav",
      } } };
    },
    downloadFile() { assert.fail("pronunciation is never a download"); },
  });
  const response = await host.request("audio", { record_id: 7, expected_epoch: 2 });
  assert.equal(response.headers.get("Content-Type"), "audio/wav");
  assert.equal(response.headers.get("Content-Disposition"), null);
  assert.equal(response.headers.get("X-Export-Receipt"), null);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
  assert.deepEqual(calls, [{ route: "audio", payload: { record_id: 7, expected_epoch: 2 } }]);
});

test("native audio rejects malformed, unsupported and oversized replies, preserving backend error status", async () => {
  for (const audio of [undefined, { blob: "!bad", mime_type: "audio/wav" },
    { blob: "AA==", mime_type: "text/html" }, { blob: "", mime_type: "audio/wav" },
    { blob: Buffer.alloc(MAX_AUDIO_BYTES + 1).toString("base64"), mime_type: "audio/mpeg" }]) {
    const host = createHostTransport({ callServerTool: async () => ({ structuredContent: { status: 200, audio } }) });
    await assert.rejects(host.request("audio", { record_id: 7 }), /speechUnavailable/);
  }
  const host = createHostTransport({ callServerTool: async () => ({
    structuredContent: { status: 429, data: { error: "speech_busy" } },
  }) });
  const response = await host.request("audio", { record_id: 7 });
  assert.equal(response.status, 429);
  assert.deepEqual(await response.json(), { error: "speech_busy" });
});

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

test("export delivery retains its original epoch and cannot acknowledge after an account changes", async () => {
  const calls = [];
  let epoch = 7, delivered = 0;
  const host = createHostTransport({
    getHostCapabilities: () => ({ downloadFile: {} }),
    downloadFile: async () => { delivered++; return { isError: false }; },
    callServerTool: async ({ arguments: args }) => { calls.push(args); return { structuredContent: { status: 200, data: { status: "ok" } } }; },
  });
  const assertCurrent = () => { if (epoch !== 7) throw new Error("account_changed"); };
  await host.download(new Blob(["fixture"]), "notes.json", "receipt-a", { expectedEpoch: 7, assertCurrent });
  assert.deepEqual(calls, [{ route: "export_complete", payload: { receipt: "receipt-a", expected_epoch: 7 } }]);
  const delayed = { type: "application/json", arrayBuffer: async () => { epoch = 8; return new ArrayBuffer(1); } };
  await assert.rejects(host.download(delayed, "notes.json", "receipt-b", { expectedEpoch: 7, assertCurrent }), /account_changed/);
  assert.equal(delivered, 1); assert.equal(calls.length, 1);
});

test("native sign-in links use the host SDK and preserve declined-link errors", async () => {
  const links = [];
  let declined = false;
  const host = createHostTransport({ openLink: async ({ url }) => { links.push(url); return { isError: declined }; } });
  await host.openExternal("https://language-memory.ca.auth0.com/authorize?state=test");
  declined = true;
  await assert.rejects(host.openExternal("https://language-memory.ca.auth0.com/authorize?state=test"));
  assert.equal(links.length, 2);
});
