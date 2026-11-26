import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { createCloudProfile, loginRedirectOptions, profileDetails } from "../web/cloud-profile.js";
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

test("desktop and web share a real lazy activity view while web keeps only its SSO sign-out action", async () => {
  const source = await readFile(new URL("../web/index.html", import.meta.url), "utf8");
  const shared = source.match(/<!-- profile-shared:start -->([\s\S]*?)<!-- profile-shared:end -->/)[1];
  const web = cloudProfileMarkup(source);
  for (const markup of [shared, web]) {
    for (const key of ["profileAccount", "profileActivity", "activityLoading"])
      assert.ok(markup.includes(`data-i18n="${key}"`));
    assert.equal((markup.match(/data-activity-view/g) || []).length, 1);
    const heatmap = markup.match(/<div class="profile-heatmap"[^>]*>([\s\S]*?)<\/div>/)[1];
    assert.equal(heatmap.trim(), "", "no activity cells or counts are invented before the server responds");
    assert.doesNotMatch(markup, /profileComingSoon|profileActivityHelp/);
    assert.doesNotMatch(markup, /data-activity-action="refresh"|data-activity-summary|data-activity-help|data-activity-weekdays|activityWeights/);
    assert.match(markup, /data-activity-action="retry"/);
    assert.match(markup, /class="dialog-body"/);
    assert.doesNotMatch(markup, /accountCloud|<input\b/);
    assert.equal((markup.match(/data-activity-year/g) || []).length, 1);
    assert.match(markup, /<div id="(?:local|cloud)-profile-activity-year" class="activity-year" data-activity-year>/);
    assert.doesNotMatch(markup, /<select\b/);
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

test("cloud profile resolves the current activity controller lazily and closes reads with the dialog", () => {
  const node = () => ({ handlers: new Map(), addEventListener(type, callback) { this.handlers.set(type, callback); },
    setAttribute() {}, focus() {}, fire(type, event = {}) { this.handlers.get(type)?.(event); } });
  const trigger = node(), panel = node(), closeButton = node();
  let activity, opens = 0, closes = 0, refreshes = 0;
  createCloudProfile({ trigger, panel, closeButton, primary: node(), secondary: node(), statusNode: node(),
    t: (key) => key, openDialog() {}, closeDialog() {}, activity: () => activity });
  trigger.fire("click");
  activity = { open() { ++opens; }, close() { ++closes; }, refresh() { ++refreshes; } };
  trigger.fire("click");
  panel.fire("click", { target: { closest: () => ({ dataset: { activityAction: "refresh" } }) } });
  panel.fire("close");
  assert.deepEqual({ opens, closes, refreshes }, { opens: 1, closes: 1, refreshes: 1 });
});
