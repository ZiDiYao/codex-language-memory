import { authorizationUrl } from "./local-profile.js";

let accountEpoch;
export function setAccountEpoch(value) {
  accountEpoch = Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

// Share the existing UI between a loopback browser page and a native MCP App.
export async function request(route, payload) {
  try {
    if (globalThis.languageMemoryRuntime) return await globalThis.languageMemoryRuntime.request(route, payload);
    if (route === "api" && typeof payload?.action === "string" && !payload.action.startsWith("account/") && accountEpoch !== undefined)
      payload = { ...payload, expected_epoch: accountEpoch };
    if (globalThis.languageMemoryHost) return await globalThis.languageMemoryHost.request(route, payload);
    return await fetch(route, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Language-Memory": "1" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(route === "export" ? 60000 : 15000),
    });
  } catch (error) {
    if (globalThis.languageMemoryRuntime && error instanceof Error) throw error;
    throw new Error("disconnected");
  }
}

export async function saveDownload(response) {
  if (globalThis.languageMemoryRuntime?.capabilities?.export === false) throw new Error("unavailable");
  const filename = response.headers.get("Content-Disposition")?.match(/filename="([^"]+)"/)?.[1] || "language-memory";
  const blob = await response.blob();
  if (globalThis.languageMemoryHost) {
    await globalThis.languageMemoryHost.download(blob, filename, response.headers.get("X-Export-Receipt"));
    return;
  }
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

export function capabilities() {
  return { export: true, speech: true, ...globalThis.languageMemoryRuntime?.capabilities };
}

export async function openExternal(url) {
  const target = authorizationUrl(url);
  if (globalThis.languageMemoryHost) return globalThis.languageMemoryHost.openExternal(target);
  window.open(target, "_blank", "noopener,noreferrer");
}
