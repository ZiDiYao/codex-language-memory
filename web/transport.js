// Share the existing UI between a loopback browser page and a native MCP App.
export async function request(route, payload) {
  try {
    if (globalThis.languageMemoryHost) return await globalThis.languageMemoryHost.request(route, payload);
    return await fetch(route, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Language-Memory": "1" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(route === "export" ? 60000 : 15000),
    });
  } catch {
    throw new Error("disconnected");
  }
}

export async function saveDownload(response) {
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
