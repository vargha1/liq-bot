// Run with: npm test   (node:test via tsx). No network access needed.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.RPC_URL ??= "http://localhost:8545";
process.env.RPC_WS ??= "ws://localhost:8546";
process.env.PRIVATE_KEY ??= "0x" + "11".repeat(32);
process.env.CONTRACT_ADDRESS ??= "0x" + "22".repeat(20);
process.env.LOG_CTRL_PORT ??= "0";

const holder = (n: number, value: bigint) => ({ address: { hash: "0x" + n.toString(16).padStart(40, "0").toUpperCase() }, value: value.toString() });
const noSleep = async () => {};

test("collects holders page by page and stops at the first balance under the floor", async () => {
  const { fetchDebtHolders } = await import("../src/explorerSeed");
  const urls: string[] = [];
  const pages = [
    { items: [holder(1, 900n), holder(2, 800n)], next_page_params: { value: "800", address_hash: "0x2", items_count: 2 } },
    { items: [holder(3, 500n), holder(4, 90n), holder(5, 80n)], next_page_params: { value: "80", items_count: 5 } },
    { items: [holder(6, 70n)], next_page_params: null },
  ];
  let i = 0;
  const r = await fetchDebtHolders({
    apiBase: "https://x.example/", token: "0xDebt", symbol: "T", minRaw: 100n,
    getPage: async url => { urls.push(url); return pages[i++]!; }, sleep: noSleep,
  });
  assert.deepEqual(r.holders.map(h => parseInt(h, 16)), [1, 2, 3]);
  assert.equal(r.pages, 2, "must not fetch a page past the floor");
  assert.equal(r.complete, true);
  assert.equal(urls[0], "https://x.example/api/v2/tokens/0xDebt/holders");
  assert.equal(urls[1], "https://x.example/api/v2/tokens/0xDebt/holders?value=800&address_hash=0x2&items_count=2");
  assert.ok(r.holders.every(h => h === h.toLowerCase()), "addresses are lowercased");
});

test("a list that ends before the floor is complete", async () => {
  const { fetchDebtHolders } = await import("../src/explorerSeed");
  const r = await fetchDebtHolders({
    apiBase: "https://x.example", token: "0xD", symbol: "T", minRaw: 1n, sleep: noSleep,
    getPage: async () => ({ items: [holder(1, 5n)], next_page_params: null }),
  });
  assert.equal(r.holders.length, 1);
  assert.equal(r.complete, true);
});

test("the page cap ends the walk and reports it incomplete", async () => {
  const { fetchDebtHolders } = await import("../src/explorerSeed");
  let n = 0;
  const r = await fetchDebtHolders({
    apiBase: "https://x.example", token: "0xD", symbol: "T", minRaw: 1n, maxPages: 3, sleep: noSleep,
    getPage: async () => ({ items: [holder(++n, 1_000n)], next_page_params: { items_count: n } }),
  });
  assert.equal(r.pages, 3);
  assert.equal(r.holders.length, 3);
  assert.equal(r.complete, false);
});

test("transient failures are retried, client errors end the walk with what was collected", async () => {
  const { fetchDebtHolders } = await import("../src/explorerSeed");
  let calls = 0;
  const waits: number[] = [];
  const ok = await fetchDebtHolders({
    apiBase: "https://x.example", token: "0xD", symbol: "T", minRaw: 1n, sleep: async ms => { waits.push(ms); },
    getPage: async () => {
      if (++calls < 3) throw Object.assign(new Error("busy"), { response: { status: 429, headers: { "retry-after": "2" } } });
      return { items: [holder(1, 10n)], next_page_params: null };
    },
  });
  assert.equal(ok.holders.length, 1);
  assert.deepEqual(waits, [2000, 2000], "honours Retry-After");

  calls = 0;
  const failed = await fetchDebtHolders({
    apiBase: "https://x.example", token: "0xD", symbol: "T", minRaw: 1n, sleep: noSleep,
    getPage: async () => { calls++; throw Object.assign(new Error("nope"), { response: { status: 404 } }); },
  });
  assert.equal(calls, 1, "a 404 is not retried");
  assert.equal(failed.complete, true, "a 404 on the first page means the token has no indexed holders");
  assert.equal(failed.holders.length, 0);
  assert.equal(failed.error, undefined);

  const denied = await fetchDebtHolders({
    apiBase: "https://x.example", token: "0xD", symbol: "T", minRaw: 1n, sleep: noSleep,
    getPage: async () => { throw Object.assign(new Error("forbidden"), { response: { status: 403 } }); },
  });
  assert.equal(denied.complete, false);
  assert.match(denied.error ?? "", /forbidden/);
});

test("a failure after some pages keeps the holders already collected", async () => {
  const { fetchDebtHolders } = await import("../src/explorerSeed");
  let n = 0;
  const r = await fetchDebtHolders({
    apiBase: "https://x.example", token: "0xD", symbol: "T", minRaw: 1n, sleep: noSleep,
    getPage: async () => {
      if (++n === 3) throw Object.assign(new Error("gateway"), { response: { status: 403 } });
      return { items: [holder(n, 1_000n), holder(n + 100, 900n)], next_page_params: { items_count: n } };
    },
  });
  assert.equal(r.holders.length, 4);
  assert.equal(r.pages, 2);
  assert.equal(r.complete, false);
  assert.ok(r.error);
  assert.equal(r.lastRaw, 900n, "reports how deep the walk got");
});

test("pacing slows while the server throttles and relaxes afterwards", async () => {
  const { fetchDebtHolders } = await import("../src/explorerSeed");
  const pauses: number[] = [];
  let n = 0;
  await fetchDebtHolders({
    apiBase: "https://x.example", token: "0xD", symbol: "T", minRaw: 1n, pauseMs: 100, maxPages: 8,
    sleep: async ms => { pauses.push(ms); },
    getPage: async () => {
      n++;
      if (n === 1) throw Object.assign(new Error("429"), { response: { status: 429, headers: {} } });
      return { items: [holder(n, 1_000n)], next_page_params: { items_count: n } };
    },
  });
  // First sleep is the retry wait (1000ms); the rest are page pauses.
  const pagePauses = pauses.slice(1);
  assert.ok(pagePauses[0]! > 100, `pause did not rise after a 429: ${pagePauses}`);
  assert.ok(pagePauses[pagePauses.length - 1]! < pagePauses[0]!, `pause did not relax: ${pagePauses}`);
});

test("items without an address or with an unparseable balance are skipped safely", async () => {
  const { fetchDebtHolders } = await import("../src/explorerSeed");
  const r = await fetchDebtHolders({
    apiBase: "https://x.example", token: "0xD", symbol: "T", minRaw: 1n, sleep: noSleep,
    getPage: async () => ({
      items: [{ value: "100" }, holder(1, 100n), { address: { hash: "0xabc" }, value: "not-a-number" }, holder(2, 100n)],
      next_page_params: null,
    } as any),
  });
  // The unparseable balance counts as zero, which is under the floor and ends the list.
  assert.deepEqual(r.holders.map(h => parseInt(h, 16)), [1]);
});
