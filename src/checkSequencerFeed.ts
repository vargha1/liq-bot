// Validate the Arbitrum sequencer-feed accelerator before enabling it.
//
//   npx tsx src/checkSequencerFeed.ts [seconds] [rpcUrl]
//
// Connects to the feed, resolves the live Chainlink aggregators behind Aave's
// oracle, and reports what it actually sees: frames parsed, transactions
// decoded, aggregator calls matched, and whether OCR reports decode into a
// median answer.
//
// Run this FIRST. SEQUENCER_FEED_ENABLED should only be turned on once this
// reports matched aggregator calls — the feed is a pure accelerator, so if the
// framing or report layout has changed upstream it degrades silently rather
// than erroring, and this is the only way to notice.
import { ethers } from "ethers";
import { CONFIG, RESERVES, AAVE_ORACLE, ORACLE_ABI, MULTICALL3, MULTICALL3_ABI, ADDRESS_TO_SYMBOL } from "./config";
import { SequencerFeedWatcher } from "./sequencerFeed";

const FEED_WALK_FNS = ["aggregator", "ASSET_TO_USD_AGGREGATOR", "BASE_TO_USD_AGGREGATOR"] as const;
const FEED_WALK_IFACE = new ethers.Interface([
  "function aggregator() view returns (address)",
  "function ASSET_TO_USD_AGGREGATOR() view returns (address)",
  "function BASE_TO_USD_AGGREGATOR() view returns (address)",
]);

async function resolveAggregators(provider: ethers.Provider): Promise<Map<string, Set<string>>> {
  const mc = new ethers.Contract(MULTICALL3, MULTICALL3_ABI, provider);
  const oracleIface = new ethers.Interface(ORACLE_ABI);
  const assets = Object.values(RESERVES);

  const srcResults: Array<{ success: boolean; returnData: string }> = await mc.tryAggregate(
    false,
    assets.map(r => ({ target: AAVE_ORACLE, callData: oracleIface.encodeFunctionData("getSourceOfAsset", [r.address]) })),
  );

  let frontier = new Map<string, string>();
  for (let i = 0; i < assets.length; i++) {
    const r = srcResults[i];
    if (!r?.success || r.returnData === "0x") continue;
    const src = oracleIface.decodeFunctionResult("getSourceOfAsset", r.returnData)[0] as string;
    if (src && src !== ethers.ZeroAddress) frontier.set(assets[i]!.address.toLowerCase(), src);
  }

  const feeds = new Map<string, Set<string>>();
  const add = (node: string, asset: string) => {
    const k = node.toLowerCase();
    let s = feeds.get(k);
    if (!s) { s = new Set(); feeds.set(k, s); }
    s.add(asset);
  };

  for (let depth = 0; depth < 4 && frontier.size > 0; depth++) {
    const nodes = [...new Set(frontier.values())];
    const results: Array<{ success: boolean; returnData: string }> = await mc.tryAggregate(
      false,
      nodes.flatMap(n => FEED_WALK_FNS.map(fn => ({ target: n, callData: FEED_WALK_IFACE.encodeFunctionData(fn, []) }))),
    );
    const child = new Map<string, string>();
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]!;
      for (let k = 0; k < FEED_WALK_FNS.length; k++) {
        const r = results[i * FEED_WALK_FNS.length + k];
        if (!r?.success || r.returnData === "0x") continue;
        try {
          const next = FEED_WALK_IFACE.decodeFunctionResult(FEED_WALK_FNS[k]!, r.returnData)[0] as string;
          if (!next || next === ethers.ZeroAddress) continue;
          if (next.toLowerCase() === node.toLowerCase()) continue;
          child.set(node, next);
          break;
        } catch { /* not this accessor */ }
      }
    }
    const nextFrontier = new Map<string, string>();
    for (const [asset, node] of frontier) {
      const next = child.get(node);
      if (next) nextFrontier.set(asset, next);
      else add(node, asset);
    }
    frontier = nextFrontier;
  }
  for (const [asset, node] of frontier) add(node, asset);
  return feeds;
}

async function main() {
  const seconds = Number(process.argv[2] ?? 60);
  const rpcUrl  = process.argv[3] ?? CONFIG.rpcUrl;
  const provider = new ethers.JsonRpcProvider(rpcUrl, 42161, { staticNetwork: true });

  console.log(`Resolving Chainlink aggregators behind Aave's oracle…`);
  const feeds = await resolveAggregators(provider);
  console.log(`  ${feeds.size} aggregators for ${Object.keys(RESERVES).length} reserves\n`);

  let matched = 0, withAnswer = 0;
  const perFeed = new Map<string, { hits: number; answers: number }>();

  const watcher = new SequencerFeedWatcher(CONFIG.sequencerFeedUrl, hint => {
    matched++;
    const stat = perFeed.get(hint.feed) ?? { hits: 0, answers: 0 };
    stat.hits++;
    if (hint.answer !== null) { stat.answers++; withAnswer++; }
    perFeed.set(hint.feed, stat);
    const syms = [...(feeds.get(hint.feed) ?? [])].map(a => ADDRESS_TO_SYMBOL[a] ?? a.slice(0, 8)).join(",");
    console.log(
      `  hit ${hint.feed.slice(0, 12)}… [${syms}] answer=${hint.answer !== null ? hint.answer.toString() : "UNDECODED"}`
    );
  });
  watcher.setWatchedFeeds(feeds.keys());

  console.log(`Connecting to ${CONFIG.sequencerFeedUrl} for ${seconds}s…`);
  watcher.start();

  await new Promise(r => setTimeout(r, seconds * 1000));
  const wasConnected = watcher.connected;   // read BEFORE stop() closes the socket
  watcher.stop();

  console.log(`\n─── Result ─────────────────────────────────────────`);
  console.log(`connected            : ${wasConnected ? "yes" : "NO — check the URL / network access"}`);
  console.log(`aggregator calls seen: ${matched}`);
  console.log(`  with decoded answer: ${withAnswer}`);
  console.log(`  touch-only         : ${matched - withAnswer}`);
  if (matched === 0) {
    console.log(`\nNo matches. Either the feed rejected the connection, the message`);
    console.log(`framing changed, or no watched feed updated in ${seconds}s (try longer).`);
    console.log(`Leave SEQUENCER_FEED_ENABLED=false until this reports matches.`);
  } else if (withAnswer === 0) {
    console.log(`\nCalls matched but no OCR report decoded — the accelerator will still`);
    console.log(`give a pre-block "feed is moving" signal, just without the new price.`);
  } else {
    console.log(`\nWorking. Safe to set SEQUENCER_FEED_ENABLED=true.`);
  }
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
