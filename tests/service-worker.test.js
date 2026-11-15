import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const indexHtml = await readFile(new URL("../index.html", import.meta.url), "utf8");
const serviceWorker = await readFile(new URL("../service-worker.js", import.meta.url), "utf8");

test("the service worker shell cache tracks the versioned app module", () => {
  const appVersion = indexHtml.match(/src="\.\/src\/app\.js\?v=(\d+)"/)?.[1];
  const shellAppVersion = serviceWorker.match(/"\/src\/app\.js\?v=(\d+)"/)?.[1];
  const cacheVersion = serviceWorker.match(/steadlane-shell-v(\d+)/)?.[1];

  assert.ok(appVersion, "index.html should use an explicit app module version");
  assert.equal(shellAppVersion, appVersion, "the service worker must precache the same app module version");
  assert.equal(cacheVersion, appVersion, "the service worker cache must change with the app module version");
});
