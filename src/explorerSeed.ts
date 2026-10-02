// Borrower seeding from a Blockscout explorer, for chains where neither the Aave
// subgraph nor historical eth_getLogs is available to the bot.
//
// Aave's variable-debt token has one holder per address with open variable debt, and
// Blockscout lists a token's holders sorted by balance, largest first. So the current
// borrowers of a reserve are just the first pages of
//   GET {api}/api/v2/tokens/{variableDebtToken}/holders
// and we can stop as soon as balances fall below the smallest debt worth watching.
// That is a few hundred small requests instead of a scan over ~50M blocks of logs.
//
// The output is only a candidate list: the usual startup prune reads every address's
// real health factor and drops the ones without debt, so an imprecise balance here
// (Aave debt tokens hold scaled amounts) costs a few extra reads, never correctness.
import axios from "axios";
import { logger } from "./logger";

export interface HolderPage {
  items?: Array<{ address?: { hash?: string }; value?: string }>;
  next_page_params?: Record<string, string | number> | null;
}

export interface FetchHoldersOptions {
  apiBase:    string;
  token:      string;       // variable debt token address
  symbol:     string;       // for logging
  minRaw:     bigint;       // stop once a holder's balance falls below this (raw token units)
  maxPages?:  number;       // hard cap per token
  deadlineMs?: number;      // absolute Date.now() cutoff for the whole seed
  pauseMs?:   number;       // base delay between pages (rises while the server throttles, then relaxes)
  // Injectable for tests.
  getPage?:   (url: string) => Promise<HolderPage>;
  sleep?:     (ms: number) => Promise<void>;
}

const realSleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

async function httpGetPage(url: string): Promise<HolderPage> {
  const r = await axios.get(url, { timeout: 20_000, headers: { accept: "application/json" } });
  return r.data as HolderPage;
}

function pageUrl(base: string, token: string, next?: Record<string, string | number> | null): string {
  const root = `${base.replace(/\/+$/, "")}/api/v2/tokens/${token}/holders`;
  if (!next) return root;
  const q = Object.entries(next).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join("&");
  return `${root}?${q}`;
}

// Retry transient failures (429 rate limit, 5xx, network) with backoff, honouring
// Retry-After; give up after a few attempts so a dead endpoint cannot stall startup.
// `throttled` tells the caller the server pushed back, so it can slow down.
async function getWithRetry(
  url: string, get: (u: string) => Promise<HolderPage>, sleep: (ms: number) => Promise<void>,
): Promise<{ page: HolderPage; throttled: boolean }> {
  let lastErr: any;
  let throttled = false;
  // Blockscout's public limit can stay closed for a minute or more, so be patient: up
  // to 12 attempts with waits capped at 30s (a few minutes in the worst case).
  for (let attempt = 0; attempt < 12; attempt++) {
    try { return { page: await get(url), throttled }; }
    catch (e: any) {
      lastErr = e;
      const status = e?.response?.status;
      if (status !== undefined && status !== 429 && status < 500) throw e;   // a 4xx will not fix itself
      if (status === 429) throttled = true;
      const retryAfter = Number(e?.response?.headers?.["retry-after"]);
      await sleep(Math.min(30_000, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1_000 * 2 ** attempt));
    }
  }
  throw lastErr;
}

// Never throws: whatever was collected before a failure is returned (complete=false,
// error set), because a partial borrower list is far better than none.
export interface FetchHoldersResult {
  holders:  string[];
  pages:    number;
  complete: boolean;   // reached the floor or the end of the list
  error?:   string;
  lastRaw?: bigint;    // smallest balance read: how deep into the list the walk got
}

export async function fetchDebtHolders(opts: FetchHoldersOptions): Promise<FetchHoldersResult> {
  const get   = opts.getPage ?? httpGetPage;
  const sleep = opts.sleep ?? realSleep;
  const basePause = opts.pauseMs ?? 250;
  let pause = basePause;
  const holders: string[] = [];
  let next: Record<string, string | number> | null | undefined;
  let pages = 0;
  let complete = false;
  let error: string | undefined;
  let lastRaw: bigint | undefined;

  while (pages < (opts.maxPages ?? 600)) {
    if (opts.deadlineMs !== undefined && Date.now() > opts.deadlineMs) break;
    let page: HolderPage;
    try {
      const r = await getWithRetry(pageUrl(opts.apiBase, opts.token, next), get, sleep);
      page = r.page;
      // Adaptive pacing: back off hard when throttled, ease back slowly otherwise.
      pause = r.throttled ? Math.min(3_000, pause * 2) : Math.max(basePause, Math.floor(pause * 0.9));
    } catch (e: any) {
      // 404 = the explorer has never seen this token move, so it has no holders. That
      // is a complete (empty) answer, not a failure: reserves nobody has borrowed from
      // are simply not indexed.
      if (e?.response?.status === 404 && pages === 0) { complete = true; break; }
      error = `${e?.response?.status ?? ""} ${e?.message ?? e}`.trim();
      break;
    }
    pages++;

    let belowFloor = false;
    for (const it of page.items ?? []) {
      const hash = it.address?.hash;
      if (!hash) continue;
      let value = 0n;
      try { value = BigInt(it.value ?? "0"); } catch { /* unparseable balance: treat as zero */ }
      lastRaw = value;
      // Sorted descending: the first holder under the floor ends the list.
      if (value < opts.minRaw) { belowFloor = true; break; }
      holders.push(hash.toLowerCase());
    }
    if (belowFloor || !page.next_page_params) { complete = true; break; }
    next = page.next_page_params;
    await sleep(pause);
  }
  return { holders, pages, complete, error, lastRaw };
}
