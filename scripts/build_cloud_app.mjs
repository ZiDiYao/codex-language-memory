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
  .replace('</title>', '</title>\n    <link rel="icon" type="image/svg+xml" href="/assets/sayrove-mark.svg" />')
  .replace('<html lang="en">', '<html lang="en" data-cloud="true">')
  .replace('<main>', `<section id="cloud-auth" class="cloud-auth" aria-labelledby="cloud-auth-title">
      <img class="cloud-auth-mark" src="/assets/sayrove-mark.svg" width="64" height="64" alt="" />
      <h1 id="cloud-auth-title" data-cloud-copy="appTitle">Sayrove</h1>
      <p class="cloud-auth-description" data-cloud-copy="cloudLanding"></p>
      <div class="cloud-auth-actions">
        <button type="button" class="cloud-signin" data-cloud-login="login" data-cloud-copy="cloudLogin" disabled>Sign in</button>
        <button type="button" class="cloud-signup subtle" data-cloud-login="signup" data-cloud-copy="cloudCreateAccount" disabled>Create account</button>
      </div>
      <p id="cloud-auth-status" class="help" role="status" data-cloud-copy="cloudLoading"></p>
    </section>
    <aside id="cloud-session" class="cloud-session" role="alert" hidden>
      <p id="cloud-session-message"></p>
      <button id="cloud-session-login" type="button" class="subtle" data-cloud-login data-i18n="cloudLogin">Sign in</button>
    </aside>
    <main hidden>`)
  .replace('<div class="header-actions">', `<div class="header-actions">
            <button id="cloud-profile-open" type="button" class="subtle cloud-account" popovertarget="cloud-profile" aria-haspopup="dialog" aria-controls="cloud-profile" aria-expanded="false">
              <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="12" cy="8" r="3.2"/><path d="M5 21v-2a7 7 0 0 1 14 0v2"/></svg>
              <span data-i18n="cloudProfile">Profile</span>
            </button>
            <section id="cloud-profile" class="cloud-profile" popover="auto" role="dialog" aria-labelledby="cloud-profile-title">
              <div class="cloud-profile-heading">
                <h2 id="cloud-profile-title" data-i18n="cloudProfile">Profile</h2>
                <button id="cloud-profile-close" type="button" class="icon-button"><span aria-hidden="true">×</span><span class="sr-only" data-i18n="close">Close</span></button>
              </div>
              <p class="cloud-profile-status"><span aria-hidden="true"></span><span data-i18n="cloudSignedIn">Signed in</span></p>
              <p id="cloud-profile-name" class="cloud-profile-name" hidden></p>
              <p id="cloud-profile-email" class="cloud-profile-email" hidden></p>
              <button id="cloud-logout" type="button" class="subtle cloud-profile-logout" data-i18n="cloudLogout">Sign out</button>
            </section>`)
  .replace(/(<div class="app-heading">\s*)<svg[\s\S]*?<\/svg>/, '$1<img class="cloud-brand-mark" src="/assets/sayrove-mark.svg" width="24" height="24" alt="" />')
  .replace('id="export-open"', 'id="export-open" hidden');
await writeFile(new URL("index.html", output), html);
await copyFile(new URL("web/style.css", root), new URL("assets/style.css", output));
await copyFile(new URL("web/assets/sayrove-mark.svg", root), new URL("assets/sayrove-mark.svg", output));
await copyFile(new URL("node_modules/@auth0/auth0-spa-js/dist/auth0-spa-js.worker.production.js", root), new URL("assets/auth0-worker.js", output));
console.log("Built public learning library in build/cloud-web (external scripts and styles). ");
