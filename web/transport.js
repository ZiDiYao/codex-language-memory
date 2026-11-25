import { authorizationUrl } from "./local-profile.js";

let accountEpoch;
const exportEpochs = new WeakMap();
export function setAccountEpoch(value) {
  accountEpoch = Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

// Share the existing UI between a loopback browser page and a native MCP App.
export async function request(route, payload) {
  const epoch = accountEpoch;
  try {
    if (globalThis.languageMemoryRuntime) return await globalThis.languageMemoryRuntime.request(route, payload);
    if (epoch !== undefined && (["audio", "export", "export_complete"].includes(route) ||
        (route === "api" && typeof payload?.action === "string" && !payload.action.startsWith("account/"))))
      payload = { ...payload, expected_epoch: epoch };
    const response = globalThis.languageMemoryHost
      ? await globalThis.languageMemoryHost.request(route, payload) : await fetch(route, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Language-Memory": "1" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(route === "export" ? 60000 : 15000),
    });
    if (["export", "export_complete"].includes(route)) {
      if (epoch !== accountEpoch) throw new Error("account_changed");
      if (route === "export") exportEpochs.set(response, epoch);
    }
    return response;
  } catch (error) {
    if (error?.message === "account_changed") throw error;
    if (globalThis.languageMemoryRuntime && error instanceof Error) throw error;
    throw new Error("disconnected");
  }
}

export async function saveDownload(response) {
  if (globalThis.languageMemoryRuntime?.capabilities?.export === false) throw new Error("unavailable");
  const epoch = exportEpochs.has(response) ? exportEpochs.get(response) : accountEpoch;
  const assertCurrent = () => { if (epoch !== accountEpoch) throw new Error("account_changed"); };
  assertCurrent();
  const filename = response.headers.get("Content-Disposition")?.match(/filename="([^"]+)"/)?.[1] || "sayrove";
  const blob = await response.blob();
  assertCurrent();
  const receipt = response.headers.get("X-Export-Receipt");
  if (globalThis.languageMemoryHost) {
    await globalThis.languageMemoryHost.download(blob, filename, receipt, { expectedEpoch: epoch, assertCurrent });
    return;
  }
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  if (receipt && epoch === accountEpoch) await request("export_complete", { receipt }).catch(() => {});
}

export function capabilities() {
  return { export: false, speech: true, ...globalThis.languageMemoryRuntime?.capabilities };
}

export async function openExternal(url) {
  const target = authorizationUrl(url);
  if (globalThis.languageMemoryHost) return globalThis.languageMemoryHost.openExternal(target);
  window.open(target, "_blank", "noopener,noreferrer");
}
