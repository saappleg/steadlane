import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const indexHtml = await readFile(new URL("../index.html", import.meta.url), "utf8");
const serviceWorker = await readFile(new URL("../service-worker.js", import.meta.url), "utf8");

test("service worker v6 keeps the app module query and includes the map module", () => {
  const appVersion = indexHtml.match(/src="\.\/src\/app\.js\?v=(\d+)"/)?.[1];
  const appShell = serviceWorker.match(/const APP_SHELL = \[([\s\S]*?)\];/)?.[1];
  const shellAppVersion = appShell?.match(/"\/src\/app\.js\?v=(\d+)"/)?.[1];
  const cacheVersion = serviceWorker.match(/const CACHE_NAME = "steadlane-shell-v(\d+)";/)?.[1];

  assert.ok(appVersion, "index.html should use an explicit app module version");
  assert.equal(appVersion, "5", "index.html should keep its existing app module query");
  assert.equal(shellAppVersion, appVersion, "the service worker must precache the same app module version");
  assert.equal(cacheVersion, "6", "the service worker shell cache must be explicitly v6");
  assert.match(appShell || "", /"\/src\/map\.js"/, "the service worker shell must include the map module");
});
