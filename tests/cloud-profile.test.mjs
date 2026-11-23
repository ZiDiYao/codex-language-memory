import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { loginRedirectOptions, profileDetails } from "../web/cloud-profile.js";
import { cloudProfileMarkup } from "../scripts/profile_markup.mjs";

test("profile identity never falls back to raw account IDs or invented personal details", () => {
  assert.deepEqual(profileDetails({ sub: "auth0|private-user-id" }), { primary: null, secondary: null });
  assert.deepEqual(profileDetails({ sub: "auth0|private-user-id", name: "auth0|private-user-id" }), { primary: null, secondary: null });
  assert.deepEqual(profileDetails({ sub: "user-id", name: " Learner Name ", email: " learner@example.com " }),
    { primary: "Learner Name", secondary: "learner@example.com" });
  assert.deepEqual(profileDetails({ sub: "user-id", name: "learner@example.com", email: "learner@example.com" }),
    { primary: "learner@example.com", secondary: null });
  assert.deepEqual(profileDetails({ email: "not-an-email" }), { primary: null, secondary: null });
  assert.deepEqual(profileDetails(null), { primary: null, secondary: null });
});

test("create-account intent changes only the hosted signup hint without requesting credentials or scopes", () => {
  assert.deepEqual(loginRedirectOptions("signup"), {
    appState: { returnTo: "/" }, authorizationParams: { screen_hint: "signup" },
  });
  assert.deepEqual(loginRedirectOptions("login"), { appState: { returnTo: "/" } });
  assert.deepEqual(loginRedirectOptions("unexpected"), { appState: { returnTo: "/" } });
});

test("desktop and web share account and neutral activity sections while web keeps only its SSO sign-out action", async () => {
  const source = await readFile(new URL("../web/index.html", import.meta.url), "utf8");
  const shared = source.match(/<!-- profile-shared:start -->([\s\S]*?)<!-- profile-shared:end -->/)[1];
  const web = cloudProfileMarkup(source);
  for (const markup of [shared, web]) {
    for (const key of ["profileAccount", "profileActivity", "profileComingSoon", "profileActivityHelp"])
      assert.ok(markup.includes(`data-i18n="${key}"`));
    const heatmap = markup.match(/<div class="profile-heatmap" aria-hidden="true">([\s\S]*?)<\/div>/)[1];
    assert.equal(heatmap.replaceAll("<span></span>", "").trim(), "");
    assert.ok(heatmap.match(/<span><\/span>/g).length > 0);
    assert.doesNotMatch(markup, /accountCloud|<input\b|<select\b/);
  }
  assert.equal((web.match(/<dialog\b/g) || []).length, 1);
  assert.ok(web.includes('aria-controls="cloud-profile"'));
  assert.ok(web.includes('id="cloud-profile-name"'));
  assert.ok(web.includes('id="cloud-profile-email"'));
  assert.ok(web.includes('id="cloud-profile-status" data-i18n="accountSignedIn"'));
  assert.doesNotMatch(web, /local-profile-|data-account-action|id="cloud-profile-connect"|id="cloud-profile-authorize"/);
  assert.doesNotMatch(web.match(/<button\b[^>]*id="cloud-logout"[^>]*>/)[0], /\bhidden\b/);
  assert.throws(() => cloudProfileMarkup("<main></main>"));
});
