import { Auth0Client } from "@auth0/auth0-spa-js";
import { messages } from "./i18n.js";
import { applyCloudMessages, detectCloudLocale } from "./cloud-i18n.js";
import { auth0Options, CloudSession, completeCloudCallback } from "./cloud-auth.js";
import { createCloudTransport, validateCloudConfig } from "./cloud-transport.js";
import { createCloudProfile, loginRedirectOptions } from "./cloud-profile.js";
import { openDialog, closeDialog } from "./motion.js";

const $ = (selector) => document.querySelector(selector);
const locale = detectCloudLocale(navigator.languages || [navigator.language]);
document.documentElement.lang = locale;
applyCloudMessages("Sayrove");
function t(key) { return messages[document.documentElement.lang]?.[key] || messages.en[key]; }
function translateShell() {
  for (const node of document.querySelectorAll("[data-cloud-copy]")) node.textContent = t(node.dataset.cloudCopy);
  document.title = t("appTitle");
}
function status(key) {
  const node = $("#cloud-auth-status");
  node.dataset.cloudCopy = key;
  node.textContent = t(key);
}
function sessionMessage(key, login = true) {
  const banner = $("#cloud-session");
  const message = $("#cloud-session-message");
  message.dataset.i18n = key;
  message.textContent = t(key);
  $("#cloud-session-login").hidden = !login;
  banner.hidden = false;
}
translateShell();
status("cloudLoading");
// Browser back/forward caching must not restore a previous account's library.
window.addEventListener("pagehide", () => { runtime?.stopPronunciation?.(); runtime?.activity?.invalidate(); runtime?.invalidateLearningInstructions?.(); $("main").hidden = true; });
window.addEventListener("pageshow", (event) => { if (event.persisted) window.location.reload(); });
let client;
let session;
let runtime;
let navigating = false;
const profile = createCloudProfile({
  trigger: $("#cloud-profile-open"), panel: $("#cloud-profile"), closeButton: $("#cloud-profile-close"),
  primary: $("#cloud-profile-name"), secondary: $("#cloud-profile-email"),
  statusNode: $("#cloud-profile-status"), t, openDialog, closeDialog,
});

async function login(mode = "login") {
  if (!client || navigating) return;
  navigating = true;
  document.querySelectorAll("[data-cloud-login]").forEach((button) => { button.disabled = true; });
  status("cloudSigningIn");
  try {
    // A new document after the callback clears every previous account's UI state.
    // Existing beforeunload protection warns if an expired session has a draft.
    await client.loginWithRedirect(loginRedirectOptions(mode));
  } catch {
    status("cloudAuthFailure");
    if (!$("main").hidden) sessionMessage("cloudAuthFailure");
  } finally {
    navigating = false;
    document.querySelectorAll("[data-cloud-login]").forEach((button) => { button.disabled = false; });
  }
}
document.querySelectorAll("[data-cloud-login]").forEach((button) => button.addEventListener("click", () => login(button.dataset.cloudLogin)));
$("#cloud-logout").addEventListener("click", async () => {
  if (!session || navigating) return;
  profile.close();
  navigating = true;
  $("#cloud-logout").disabled = true;
  try {
    if (!(await session.signOut(() => runtime.beforeAccountChange(), window.location.origin)))
      sessionMessage("cloudUnsavedDraft", false);
  } catch { sessionMessage("cloudAuthFailure"); }
  finally { navigating = false; $("#cloud-logout").disabled = false; }
});

async function initialize() {
  try {
    const response = await fetch("/config.json", { cache: "no-store", credentials: "same-origin", signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error();
    const config = validateCloudConfig(await response.json(), window.location.origin);
    applyCloudMessages(config.appName);
    translateShell();
    client = new Auth0Client(auth0Options(config, window.location.origin));
    session = new CloudSession(client, {
      issuer: `https://${config.auth0Domain}/`,
      onRequired: (reason) => {
        runtime?.stopPronunciation?.();
        runtime?.activity?.invalidate();
        runtime?.invalidateLearningInstructions?.();
        profile.setStatus("accountSignedOut");
        sessionMessage(reason === "accountChanged" ? "cloudAccountChanged" : "cloudSessionExpired");
      },
    });
    if (!(await completeCloudCallback(client, window.location, window.history))) {
      // Memory caching intentionally avoids persisted bearer/refresh tokens.
      // A provider session may restore silently; otherwise the learner signs in.
      try { await client.checkSession(); } catch { /* Present the explicit sign-in action below. */ }
    }
    document.querySelectorAll("[data-cloud-login]").forEach((button) => { button.disabled = false; });
    if (!(await client.isAuthenticated())) { status("cloudLoginHelp"); return; }
    await session.getToken();
    profile.setStatus("accountSignedIn");
    profile.setUser(await client.getUser());
    runtime = {
      ...createCloudTransport({ apiBaseUrl: config.apiBaseUrl, session }),
      beforeAccountChange: async () => true,
      isPaused: () => session.blocked,
    };
    globalThis.languageMemoryRuntime = runtime;
    $("#cloud-auth").hidden = true;
    $("main").hidden = false;
    await import("./app.js");
  } catch {
    // SDK and provider errors can contain callback details; never print them.
    status("cloudAuthFailure");
    if (client) document.querySelectorAll("[data-cloud-login]").forEach((button) => { button.disabled = false; });
  }
}
initialize();
