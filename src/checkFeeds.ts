// One-shot diagnostic: resolve every Aave reserve to the Chainlink aggregator
// that actually emits AnswerUpdated, and print the mapping.
//
//   npx tsx src/checkFeeds.ts [rpcUrl]
//
// Mirrors TriggerEngine.resolveFeeds(). Run it after any Aave oracle change to
// confirm the trigger engine is subscribed to live emitters.
import { ethers } from "ethers";
import { RESERVES, AAVE_ORACLE, ORACLE_ABI, MULTICALL3, MULTICALL3_ABI, ADDRESS_TO_SYMBOL } from "./config";

const FEED_WALK_FNS = ["aggregator", "ASSET_TO_USD_AGGREGATOR", "BASE_TO_USD_AGGREGATOR"] as const;
const FEED_WALK_IFACE = new ethers.Interface([
  "function aggregator() view returns (address)",
  "function ASSET_TO_USD_AGGREGATOR() view returns (address)",
  "function BASE_TO_USD_AGGREGATOR() view returns (address)",
]);
const ANSWER_UPDATED_TOPIC = new ethers.Interface([
  "event AnswerUpdated(int256 indexed current, uint256 indexed roundId, uint256 updatedAt)",
]).getEvent("AnswerUpdated")!.topicHash;

async function main() {
  const url = process.argv[2] ?? process.env.RPC_URL;
  if (!url) throw new Error("Pass an RPC url as argv[2] or set RPC_URL");
  const provider = new ethers.JsonRpcProvider(url, 42161, { staticNetwork: true });
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
    if (!r?.success || r.returnData === "0x") { console.log(`${assets[i]!.symbol}: no source`); continue; }
    const src = oracleIface.decodeFunctionResult("getSourceOfAsset", r.returnData)[0] as string;
    if (src && src !== ethers.ZeroAddress) frontier.set(assets[i]!.address.toLowerCase(), src);
  }

  const feeds = new Map<string, Set<string>>();
  const addFeed = (node: string, asset: string) => {
    const key = node.toLowerCase();
    let s = feeds.get(key);
    if (!s) { s = new Set(); feeds.set(key, s); }
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
      else addFeed(node, asset);
    }
    frontier = nextFrontier;
  }
  for (const [asset, node] of frontier) addFeed(node, asset);

  console.log(`\nResolved ${assets.length} reserves to ${feeds.size} aggregators:\n`);
  const latestIface = new ethers.Interface(["function latestRound() view returns (uint256)"]);
  for (const [feed, set] of feeds) {
    const syms = [...set].map(a => ADDRESS_TO_SYMBOL[a] ?? a.slice(0, 8)).join(", ");
    // A real OCR aggregator answers latestRound(); a proxy we failed to walk
    // through would answer it too, so also confirm it is NOT itself a proxy.
    let isProxy = false;
    try { await new ethers.Contract(feed, ["function aggregator() view returns (address)"], provider).aggregator(); isProxy = true; } catch { /* good */ }
    let round = "?";
    try { round = String(await new ethers.Contract(feed, latestIface, provider).latestRound()); } catch { round = "ERR"; }
    console.log(`${feed}  round=${round.padEnd(12)} ${isProxy ? "!! STILL A PROXY !!" : "emitter"}  ← ${syms}`);
  }
  console.log(`\nAnswerUpdated topic: ${ANSWER_UPDATED_TOPIC}`);
}

main().catch(e => { console.error(e); process.exit(1); });
