import { App } from "@modelcontextprotocol/ext-apps";
import { createHostTransport } from "./host-transport.js";

const app = new App({ name: "Sayrove", version: "1.0.0" }, {}, { autoResize: false });
// Register handlers before initialization so launch notifications are accepted.
let seenInput = false, seenResult = false, lastResume = 0;
const resume = () => {
  if (!globalThis.sayroveHistoryLifecycle || Date.now() - lastResume < 1000) return;
  lastResume = Date.now();
  void globalThis.sayroveHistoryLifecycle.resume();
};
app.ontoolinput = () => { if (seenInput) resume(); seenInput = true; };
app.ontoolresult = () => { if (seenResult) resume(); seenResult = true; };
app.onteardown = async () => { await globalThis.sayroveHistoryLifecycle?.flush(); return {}; };
try {
  await app.connect();
  globalThis.languageMemoryHost = createHostTransport(app);
  await import("./app.js");
} catch {
  const notice = document.querySelector("#notice");
  notice.textContent = "Could not connect to Sayrove. Reopen the app to retry.";
  notice.className = "error";
  notice.hidden = false;
}
