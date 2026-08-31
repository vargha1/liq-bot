// sequencerFeed.ts — read Arbitrum's sequencer feed to learn about Chainlink
// price updates BEFORE the block containing them is published.
//
// Why this exists
// ---------------
// A log subscription (`eth_subscribe("logs")`) can only deliver an AnswerUpdated
// event after the block carrying it has been produced and processed. Every
// competitor watching logs therefore learns about a price move at the same
// instant. Racing on that signal is racing on network latency alone.
//
// Arbitrum's sequencer broadcasts transactions over a public feed as it orders
// them, ahead of block publication. Watching that feed for the Chainlink
// aggregator's `transmit()` call gives a head start measured in hundreds of
// milliseconds over anyone waiting on logs — which, on an FCFS sequencer, is
// the whole game.
//
// Degradation strategy
// --------------------
// Decoding an OCR report is version-specific and the least durable part of this.
// So the design never depends on it:
//
//   1. If the report decodes, the new price is reported and the trigger runs
//      immediately on it — full head start.
//   2. If it does not, we still know WHICH feed is about to update, and emit a
//      "feed touched" hint. The caller can pre-position on that alone.
//
// Either way the log subscription in trigger.ts remains the authoritative path;
// this is a pure accelerator layered on top, and is disabled by default.

import { ethers } from "ethers";
import WebSocket from "ws";
import { logger } from "./logger";

// Arbitrum message kinds (see arbos/parse_l2.go in nitro).
const L2_MESSAGE_KIND_BATCH     = 3;
const L2_MESSAGE_KIND_SIGNED_TX = 4;

// OCR aggregators expose one of these. Both carry the observation set we need.
const OCR_IFACE = new ethers.Interface([
  // OCR1 (AccessControlledOffchainAggregator)
  "function transmit(bytes _report, bytes32[] _rs, bytes32[] _ss, bytes32 _rawVs)",
  // OCR2
  "function transmit(bytes32[3] reportContext, bytes report, bytes32[] rs, bytes32[] ss, bytes32 rawVs)",
]);
const OCR1_SELECTOR = OCR_IFACE.getFunction("transmit(bytes,bytes32[],bytes32[],bytes32)")!.selector;
const OCR2_SELECTOR = OCR_IFACE.getFunction("transmit(bytes32[3],bytes,bytes32[],bytes32[],bytes32)")!.selector;

// Chainlink does NOT send transmit() straight to the aggregator on Arbitrum.
// Transmissions go through a shared Forwarder — verified live: ETH/USD and
// ARB/USD both update via 0x9cd5B3E0…, BTC/USD via 0xcD96e5a8…, each calling
// forward(targetAggregator, transmitCalldata). Matching on `tx.to == aggregator`
// therefore matches NOTHING, which is exactly what an early version of this file
// did. The aggregator is the forward() target, not the transaction recipient.
const FORWARDER_IFACE = new ethers.Interface(["function forward(address target, bytes data)"]);
const FORWARD_SELECTOR = FORWARDER_IFACE.getFunction("forward")!.selector;

const ABI = ethers.AbiCoder.defaultAbiCoder();

export interface FeedHint {
  feed:   string;        // lowercase aggregator address
  answer: bigint | null; // decoded median, or null when only the touch is known
}

export class SequencerFeedWatcher {
  private ws: WebSocket | null = null;
  private closed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffMs = 1_000;
  private watched = new Set<string>();   // lowercase aggregator addresses
  private seenHere = 0;

  constructor(
    private url: string,
    private onHint: (hint: FeedHint) => void,
  ) {}

  setWatchedFeeds(feeds: Iterable<string>): void {
    this.watched = new Set([...feeds].map(f => f.toLowerCase()));
  }

  start(): void {
    if (this.closed) return;
    this.connect();
  }

  stop(): void {
    this.closed = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    try { this.ws?.close(); } catch { /* ignore */ }
    this.ws = null;
  }

  get connected(): boolean { return this.ws?.readyState === WebSocket.OPEN; }
  get matched(): number { return this.seenHere; }

  private connect(): void {
    if (this.closed) return;
    try {
      logger.info(`Sequencer feed: connecting ${this.url}`);
      const ws = new WebSocket(this.url, { handshakeTimeout: 10_000 });
      this.ws = ws;

      ws.on("open", () => {
        this.backoffMs = 1_000;
        logger.info("Sequencer feed: connected — watching for Chainlink transmit() ahead of block publication");
      });

      ws.on("message", (data: WebSocket.RawData) => {
        try { this.handleMessage(data.toString()); }
        catch { /* never throw out of the feed handler */ }
      });

      ws.on("close", (code: number) => {
        if (this.closed) return;
        logger.warn(`Sequencer feed: closed (${code}) — reconnecting in ${this.backoffMs}ms`);
        this.scheduleReconnect();
      });

      ws.on("error", (err: Error) => {
        // 'close' always follows, which is where the reconnect is scheduled.
        logger.debug(`Sequencer feed error: ${err.message}`);
      });
    } catch (e: any) {
      logger.warn(`Sequencer feed: connect failed: ${e?.message ?? e}`);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  // Feed frame: { version, messages: [ { sequenceNumber, message: { message: {
  //   header, l2Msg (base64) }, delayedMessagesRead } } ] }
  private handleMessage(raw: string): void {
    if (this.watched.size === 0) return;
    let frame: any;
    try { frame = JSON.parse(raw); } catch { return; }
    const messages = frame?.messages;
    if (!Array.isArray(messages)) return;

    for (const entry of messages) {
      const l2Msg = entry?.message?.message?.l2Msg;
      if (typeof l2Msg !== "string") continue;
      let bytes: Buffer;
      try { bytes = Buffer.from(l2Msg, "base64"); } catch { continue; }
      for (const txBytes of extractSignedTxs(bytes)) this.inspectTx(txBytes);
    }
  }

  private inspectTx(txBytes: Buffer): void {
    let tx: ethers.Transaction;
    try { tx = ethers.Transaction.from("0x" + txBytes.toString("hex")); }
    catch { return; }

    const data = tx.data;
    if (!data || data.length < 10) return;

    const resolved = this.resolveTarget(tx.to, data);
    if (!resolved) return;

    const { feed, inner } = resolved;
    this.seenHere++;

    const selector = inner.slice(0, 10);
    if (selector !== OCR1_SELECTOR && selector !== OCR2_SELECTOR) {
      // A call that reaches a watched aggregator by some other shape. We still
      // know the feed is moving, which is worth acting on even without a price.
      this.onHint({ feed, answer: null });
      return;
    }
    this.onHint({ feed, answer: decodeOcrMedian(inner, selector) });
  }

  // Find which watched aggregator this transaction updates, and the calldata
  // that actually carries the OCR report.
  //
  // Three shapes, cheapest first:
  //   1. direct call to the aggregator
  //   2. forward(aggregator, transmitCalldata) — what Chainlink actually uses here
  //   3. anything else that embeds a watched aggregator address in its calldata,
  //      as a catch-all if the routing contract changes again
  private resolveTarget(to: string | null, data: string): { feed: string; inner: string } | null {
    const toLower = to?.toLowerCase();
    if (toLower && this.watched.has(toLower)) return { feed: toLower, inner: data };

    if (data.slice(0, 10) === FORWARD_SELECTOR) {
      try {
        const [target, inner] = FORWARDER_IFACE.decodeFunctionData("forward", data) as unknown as [string, string];
        const feed = target.toLowerCase();
        if (this.watched.has(feed)) return { feed, inner };
        return null;
      } catch { /* fall through to the scan */ }
    }

    // Catch-all: does the calldata mention a watched aggregator anywhere? Only
    // worth attempting on payloads large enough to be a wrapped transmit.
    if (data.length < 400) return null;
    const hay = data.toLowerCase();
    for (const feed of this.watched) {
      if (!hay.includes(feed.slice(2))) continue;
      const inner = extractTransmitCalldata(hay);
      return { feed, inner: inner ?? data };
    }
    return null;
  }
}

// Locate an embedded transmit() payload inside an arbitrary wrapper's calldata.
// Used only by the catch-all path, when the wrapper is not a shape we decode.
function extractTransmitCalldata(hexLower: string): string | null {
  for (const sel of [OCR2_SELECTOR, OCR1_SELECTOR]) {
    const idx = hexLower.indexOf(sel.slice(2), 2);
    if (idx > 0 && (idx - 2) % 2 === 0) return "0x" + hexLower.slice(idx);
  }
  return null;
}

// A signed transaction is either the whole L2 message (kind 4) or one entry in a
// batch (kind 3), where each entry is length-prefixed with an 8-byte big-endian
// count. Batches may nest, so recurse with a depth bound.
function extractSignedTxs(msg: Buffer, depth = 0): Buffer[] {
  const out: Buffer[] = [];
  if (msg.length < 1 || depth > 3) return out;

  const kind = msg[0]!;
  if (kind === L2_MESSAGE_KIND_SIGNED_TX) {
    out.push(msg.subarray(1));
    return out;
  }
  if (kind !== L2_MESSAGE_KIND_BATCH) return out;

  let offset = 1;
  while (offset + 8 <= msg.length) {
    const size = Number(msg.readBigUInt64BE(offset));
    offset += 8;
    if (size <= 0 || offset + size > msg.length) break;
    out.push(...extractSignedTxs(msg.subarray(offset, offset + size), depth + 1));
    offset += size;
  }
  return out;
}

// OCR reports carry a sorted observation list; the median is the answer the
// aggregator will store. Layouts differ by OCR version, so try both and give up
// quietly — the caller treats a null answer as "feed touched, price unknown".
function decodeOcrMedian(data: string, selector: string): bigint | null {
  try {
    let report: string;
    if (selector === OCR1_SELECTOR) {
      report = OCR_IFACE.decodeFunctionData("transmit(bytes,bytes32[],bytes32[],bytes32)", data)[0] as string;
    } else {
      report = OCR_IFACE.decodeFunctionData("transmit(bytes32[3],bytes,bytes32[],bytes32[],bytes32)", data)[1] as string;
    }
    if (!report || report === "0x") return null;

    // OCR2 numerical median: (uint32 observationsTimestamp, bytes32 rawObservers,
    //                         int192[] observations, int192 juelsPerFeeCoin)
    try {
      const d = ABI.decode(["uint32", "bytes32", "int192[]", "int192"], report);
      const obs = d[2] as bigint[];
      if (obs.length > 0) return obs[Math.floor(obs.length / 2)]!;
    } catch { /* try OCR1 layout */ }

    // OCR1: (bytes32 rawReportContext, bytes32 rawObservers, int192[] observations)
    try {
      const d = ABI.decode(["bytes32", "bytes32", "int192[]"], report);
      const obs = d[2] as bigint[];
      if (obs.length > 0) return obs[Math.floor(obs.length / 2)]!;
    } catch { /* unknown layout */ }

    return null;
  } catch {
    return null;
  }
}
