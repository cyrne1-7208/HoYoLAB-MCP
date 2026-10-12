import test from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { createHoYoLabClient } from "../src/hoyolab/api.mjs";

const configurationKeys = ["HOYOLAB_API_MIN_REQUEST_INTERVAL_MS", "HOYOLAB_API_CONCURRENCY", "HOYOLAB_API_MAX_QUEUE", "HOYOLAB_API_TIMEOUT_MS"];
const article = { postId: "101" };
const response = () => new Response(JSON.stringify({ retcode: 0, data: { text: "Unchanged response body" } }));

function configure(t, values) {
  const saved = new Map(configurationKeys.map((key) => [key, process.env[key]]));
  for (const key of configurationKeys) {
    if (values[key] === undefined) delete process.env[key];
    else process.env[key] = String(values[key]);
  }
  t.after(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test("environment pacing is shared across article, Wiki and reply requests without changing bodies", async (t) => {
  configure(t, { HOYOLAB_API_MIN_REQUEST_INTERVAL_MS: 200, HOYOLAB_API_TIMEOUT_MS: 5000 });
  const starts = [];
  const api = createHoYoLabClient({ maxRetries: 0, fetchImpl: async () => { starts.push(performance.now()); return response(); } });
  const results = await Promise.all([api.getArticle(article), api.getWiki({ wikiApp: "hsr", entryPageId: "202" }), api.getReplies(article)]);
  assert.equal(starts.length, 3);
  assert.ok(starts.slice(1).every((time, index) => time - starts[index] >= 200));
  for (const result of results) {
    assert.equal(result.status, 200);
    assert.deepEqual(result.data, { text: "Unchanged response body" });
  }
});

test("environment concurrency queues accepted requests and rejects only queue overflow", async (t) => {
  configure(t, { HOYOLAB_API_MIN_REQUEST_INTERVAL_MS: 0, HOYOLAB_API_CONCURRENCY: 1, HOYOLAB_API_MAX_QUEUE: 1 });
  let announce;
  let release;
  let calls = 0;
  const ready = new Promise((resolve) => { announce = resolve; });
  const blocked = new Promise((resolve) => { release = resolve; });
  const api = createHoYoLabClient({ fetchImpl: async () => { calls += 1; if (calls === 1) { announce(); await blocked; } return response(); } });
  const first = api.getArticle(article);
  let second;
  t.after(async () => { release(); await Promise.allSettled([first, second]); });
  await ready;
  second = api.getArticle(article);
  await assert.rejects(api.getArticle(article), (error) => error.code === "BUSY" && error.retryable);
  assert.equal(calls, 1);
  release();
  await Promise.all([first, second]);
  assert.equal(calls, 2);
});

test("a zero environment queue limit is honored rather than replaced by the default", async (t) => {
  configure(t, { HOYOLAB_API_MIN_REQUEST_INTERVAL_MS: 0, HOYOLAB_API_CONCURRENCY: 1, HOYOLAB_API_MAX_QUEUE: 0 });
  let announce;
  let release;
  const ready = new Promise((resolve) => { announce = resolve; });
  const blocked = new Promise((resolve) => { release = resolve; });
  const api = createHoYoLabClient({ fetchImpl: async () => { announce(); await blocked; return response(); } });
  const first = api.getArticle(article);
  t.after(async () => { release(); await Promise.allSettled([first]); });
  await ready;
  await assert.rejects(api.getArticle(article), (error) => error.code === "BUSY");
  release();
  await first;
});

test("explicit client options override environment limits", async (t) => {
  configure(t, { HOYOLAB_API_MIN_REQUEST_INTERVAL_MS: 10000, HOYOLAB_API_CONCURRENCY: 1, HOYOLAB_API_MAX_QUEUE: 0 });
  let release;
  let announce;
  let calls = 0;
  const blocked = new Promise((resolve) => { release = resolve; });
  const ready = new Promise((resolve) => { announce = resolve; });
  const api = createHoYoLabClient({ minRequestIntervalMs: 0, concurrency: 2, maxQueue: 1, timeoutMs: 5000,
    fetchImpl: async () => { calls += 1; if (calls === 2) announce(); await blocked; return response(); } });
  const first = api.getArticle(article);
  const second = api.getArticle(article);
  let third;
  t.after(async () => { release(); await Promise.allSettled([first, second, third]); });
  await ready;
  third = api.getArticle(article);
  await assert.rejects(api.getArticle(article), (error) => error.code === "BUSY");
  assert.equal(calls, 2);
  release();
  await Promise.all([first, second, third]);
  assert.equal(calls, 3);
});

test("invalid environment interval values retain the existing 100ms default", async (t) => {
  configure(t, { HOYOLAB_API_MIN_REQUEST_INTERVAL_MS: "invalid", HOYOLAB_API_CONCURRENCY: 1, HOYOLAB_API_MAX_QUEUE: 1 });
  for (const value of ["invalid", "-1", "1.5", "10001"]) {
    process.env.HOYOLAB_API_MIN_REQUEST_INTERVAL_MS = value;
    const starts = [];
    const api = createHoYoLabClient({ fetchImpl: async () => { starts.push(performance.now()); return response(); } });
    await Promise.all([api.getArticle(article), api.getArticle(article)]);
    assert.ok(starts[1] - starts[0] >= 100);
  }
});

test("request timeout includes environment pacing waits and prevents an extra fetch", async (t) => {
  configure(t, { HOYOLAB_API_MIN_REQUEST_INTERVAL_MS: 500, HOYOLAB_API_TIMEOUT_MS: 25 });
  let calls = 0;
  const api = createHoYoLabClient({ fetchImpl: async () => { calls += 1; return response(); } });
  await api.getArticle(article);
  await assert.rejects(api.getArticle(article), (error) => error.code === "TIMEOUT" && error.retryable);
  assert.equal(calls, 1);
});
