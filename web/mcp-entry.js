import { App } from "@modelcontextprotocol/ext-apps";
import { createHostTransport } from "./host-transport.js";

const app = new App({ name: "Language memory", version: "1.0.0" }, {}, { autoResize: false });
// Register handlers before initialization so launch notifications are accepted.
app.ontoolresult = () => {};
app.ontoolinput = () => {};
try {
  await app.connect();
  globalThis.languageMemoryHost = createHostTransport(app);
  await import("./app.js");
} catch {
  const notice = document.querySelector("#notice");
  notice.textContent = "Could not connect to Language memory. Reopen the app to retry.";
  notice.className = "error";
  notice.hidden = false;
}
