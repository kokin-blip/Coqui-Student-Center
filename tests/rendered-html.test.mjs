import assert from "node:assert/strict";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(new Request("http://localhost/", { headers:{ accept:"text/html" } }), { ASSETS:{ fetch:async()=>new Response("Not found",{status:404}) } }, { waitUntil(){}, passThroughOnException(){} });
}

test("server renders the Student Center product shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<title>Student Center/);
  assert.match(html, /Good morning, Alex/);
  assert.match(html, /Your next best action/);
  assert.match(html, /Read Chapter 6: Social Influence/);
  assert.doesNotMatch(html, /codex-preview|Building your site|react-loading-skeleton/);
});
