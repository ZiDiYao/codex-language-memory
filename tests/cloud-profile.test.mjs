import assert from "node:assert/strict";
import { test } from "node:test";
import { loginRedirectOptions, profileDetails } from "../web/cloud-profile.js";

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
