// svrFeed.ts — client for the Chainlink SVR searcher gateway.
//
// One WebSocket carries both directions: auction notifications arrive as
// `solver_subscription` messages, and bids go out as `solver_submitSolverOperation`
// requests on the same connection.
//
// The gateway drops long-lived connections, so reconnecting is part of normal
// operation, not an error path. Payloads can exceed default buffer sizes, hence
// the raised maxPayload.

import WebSocket from "ws";
import { parseAuction, isOurAuction, type SvrAuction } from "./svrAtlas";

const PING_MS          = 20_000;
const STALE_MS         = 60_000;     // no traffic for this long = assume the socket is dead
const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 15_000;
const RPC_TIMEOUT_MS   = 3_000;      // an auction lasts ~2s; a slower reply is useless
const SEEN_MAX         = 2_000;

export interface FeedLog { info(m: string): void; warn(m: string): void; error(m: string): void }

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

export class SvrFeed {
  private ws: WebSocket | null = null;
  private stopped = false;
  private backoff = RECONNECT_MIN_MS;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private lastTraffic = 0;
  private seen = new Set<string>();

  // Counters for the heartbeat.
  stats = { connects: 0, auctions: 0, ours: 0, duplicates: 0, malformed: 0 };

  constructor(
    private url: string,
    private onAuction: (a: SvrAuction) => void,
    private log: FeedLog,
  ) {}

  get connected(): boolean { return this.ws?.readyState === WebSocket.OPEN; }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    try { this.ws?.terminate(); } catch { /* already gone */ }
    this.ws = null;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error("feed stopped")); }
    this.pending.clear();
  }

  private connect(): void {
    if (this.stopped) return;
    const ws = new WebSocket(this.url, { maxPayload: 1 << 24, perMessageDeflate: false });
    this.ws = ws;

    ws.on("open", () => {
      this.backoff = RECONNECT_MIN_MS;
      this.lastTraffic = Date.now();
      this.stats.connects++;
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method: "solver_subscribe", params: ["userOperations"] }));
      this.log.info("SVR feed: connected, subscribed to auctions");
    });

    ws.on("message", (raw: WebSocket.RawData) => {
      this.lastTraffic = Date.now();
      let msg: any;
      try { msg = JSON.parse(raw.toString()); } catch { this.stats.malformed++; return; }

      // Reply to one of our requests.
      if (typeof msg?.id === "number" && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
        else p.resolve(msg.result);
        return;
      }

      if (msg?.method !== "solver_subscription") return;
      const a = parseAuction(msg);
      if (!a) { this.stats.malformed++; return; }
      this.stats.auctions++;
      if (!isOurAuction(a)) return;

      // The gateway can repeat a notification across a reconnect.
      if (this.seen.has(a.auctionId)) { this.stats.duplicates++; return; }
      this.seen.add(a.auctionId);
      if (this.seen.size > SEEN_MAX) {
        for (const id of this.seen) { this.seen.delete(id); if (this.seen.size <= SEEN_MAX / 2) break; }
      }
      this.stats.ours++;
      try { this.onAuction(a); } catch (e: any) {
        this.log.error(`SVR feed: auction handler threw: ${e?.message ?? e}`);
      }
    });

    ws.on("error", (e: Error) => this.log.warn(`SVR feed: socket error: ${e.message}`));

    ws.on("close", () => {
      if (this.ws === ws) this.ws = null;
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error("socket closed")); }
      this.pending.clear();
      if (this.stopped) return;
      const wait = this.backoff;
      this.backoff = Math.min(this.backoff * 2, RECONNECT_MAX_MS);
      this.log.warn(`SVR feed: disconnected, reconnecting in ${wait}ms`);
      setTimeout(() => this.connect(), wait);
    });

    if (!this.pingTimer) {
      this.pingTimer = setInterval(() => {
        const sock = this.ws;
        if (!sock || sock.readyState !== WebSocket.OPEN) return;
        if (Date.now() - this.lastTraffic > STALE_MS) {
          this.log.warn("SVR feed: no traffic, recycling the connection");
          try { sock.terminate(); } catch { /* close handler reconnects */ }
          return;
        }
        try { sock.ping(); } catch { /* close handler reconnects */ }
      }, PING_MS);
    }
  }

  // Submit a signed solver operation. Resolves with the gateway's result, rejects
  // on an RPC error or if no reply arrives within the auction window.
  submit(auctionId: string, solution: Record<string, string>): Promise<unknown> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error("feed not connected"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("submit timed out"));
      }, RPC_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({
        jsonrpc: "2.0", id, method: "solver_submitSolverOperation",
        params: [{ auction_id: auctionId, auction_solution: solution }],
      }), err => {
        if (err) { clearTimeout(timer); this.pending.delete(id); reject(err); }
      });
    });
  }
}
