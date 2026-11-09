// Only the MCP entry imports this adapter. Standalone pages need no host SDK.
export function createHostTransport(app) {
  async function call(route, payload) {
    const result = await app.callServerTool({ name: "memory_app_request", arguments: { route, payload } },
      { timeout: route === "export" ? 60000 : 15000 });
    if (result.isError) throw new Error("unavailable");
    const reply = result.structuredContent;
    if (!reply || !Number.isInteger(reply.status)) throw new Error("unavailable");
    return reply;
  }
  return {
    async request(route, payload) {
      const reply = await call(route, payload);
      if (reply.file && reply.status === 200) {
        const file = reply.file;
        return new Response(Uint8Array.from(atob(file.blob), (c) => c.charCodeAt(0)), {
          headers: { "Content-Type": file.mime_type,
            "Content-Disposition": `attachment; filename="${file.filename}"`,
            "X-Record-Count": String(file.count), "X-Export-Receipt": file.receipt },
        });
      }
      return Response.json(reply.data, { status: reply.status });
    },
    async download(blob, filename, receipt) {
      if (app.getHostCapabilities()?.downloadFile) {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let binary = "";
        for (let start = 0; start < bytes.length; start += 8192)
          binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
        const result = await app.downloadFile({ contents: [{ type: "resource", resource: {
          uri: `file:///${encodeURIComponent(filename)}`, mimeType: blob.type, blob: btoa(binary),
        } }] });
        if (result.isError) throw new Error("unavailable");
      } else {
        // Some hosts support sandbox downloads but not ui/download-file yet.
        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.download = filename;
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(link.href), 1000);
      }
      // Keep the same delivery semantics as the loopback download endpoint.
      // Receipt failure must not misreport an already delivered file as failed.
      await call("export_complete", { receipt }).catch(() => {});
    },
  };
}
