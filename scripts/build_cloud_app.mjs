// Build a separate public SPA from the shared learning library. Local/MCP entrypoints stay independent.
import { build } from "esbuild";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const output = new URL("build/cloud-web/", root);
await mkdir(new URL("assets/", output), { recursive: true });
await build({
  absWorkingDir: root.pathname, entryPoints: ["web/cloud-entry.js"],
  outfile: new URL("assets/app.js", output).pathname,
  bundle: true, format: "esm", target: "es2022", minify: true,
  splitting: false, legalComments: "inline",
});
let html = await readFile(new URL("web/index.html", root), "utf8");
html = html
  .replace('<link rel="stylesheet" href="style.css" />', '<link rel="stylesheet" href="/assets/style.css" />')
  .replace('<script src="app.js" type="module"></script>', '<script src="/assets/app.js" type="module"></script>')
  .replace(/<title>[^<]*<\/title>/, '<title>Sayrove</title>')
  .replace('<html lang="en">', '<html lang="en" data-cloud="true">')
  .replace('<main>', `<section id="cloud-auth" class="cloud-auth" aria-labelledby="cloud-auth-title">
      <div class="cloud-auth-mark" aria-hidden="true">S</div>
      <h1 id="cloud-auth-title" data-cloud-copy="appTitle">Sayrove</h1>
      <p class="cloud-auth-description" data-cloud-copy="cloudLanding"></p>
      <button type="button" data-cloud-login data-cloud-copy="cloudLogin" disabled>Sign in</button>
      <p id="cloud-auth-status" class="help" role="status" data-cloud-copy="cloudLoading"></p>
    </section>
    <aside id="cloud-session" class="cloud-session" role="alert" hidden>
      <p id="cloud-session-message"></p>
      <button id="cloud-session-login" type="button" class="subtle" data-cloud-login data-i18n="cloudLogin">Sign in</button>
    </aside>
    <main hidden>`)
  .replace('<div class="header-actions">', `<div class="header-actions">
            <button id="cloud-logout" type="button" class="subtle cloud-account" data-i18n="cloudLogout">Sign out</button>`)
  .replace('id="export-open"', 'id="export-open" hidden');
await writeFile(new URL("index.html", output), html);
await copyFile(new URL("web/style.css", root), new URL("assets/style.css", output));
await copyFile(new URL("node_modules/@auth0/auth0-spa-js/dist/auth0-spa-js.worker.production.js", root), new URL("assets/auth0-worker.js", output));
console.log("Built public learning library in build/cloud-web (external scripts and styles). ");
