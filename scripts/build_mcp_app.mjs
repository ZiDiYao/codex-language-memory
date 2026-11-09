// Bundle the same markup, styles and behavior for the host's isolated iframe.
import { build } from "esbuild";
import { readFile, writeFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const output = await build({
  absWorkingDir: root.pathname,
  entryPoints: ["web/mcp-entry.js"],
  bundle: true, write: false, format: "esm", target: "es2022", minify: true,
  legalComments: "inline",
});
const html = await readFile(new URL("web/index.html", root), "utf8");
const css = await readFile(new URL("web/style.css", root), "utf8");
const script = output.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
const bundled = html.replace('<link rel="stylesheet" href="style.css" />', () => `<style>${css}</style>`)
  .replace('<script src="app.js" type="module"></script>', () => `<script type="module">${script}</script>`);
await writeFile(new URL("web/mcp-app.html", root), bundled);
console.log(`Built native MCP App (${Buffer.byteLength(bundled)} bytes). UI markup and styles unchanged.`);
