# Deploying on Ubuntu 24.04

## A note on server location first

This bot competes on latency. Arbitrum's sequencer is in the US, so a German
server pays roughly **80–120 ms extra round-trip on every submission** compared
with a US-East host. On a first-come-first-served sequencer that is the whole
race for contested liquidations.

Germany is fine for running it, and every non-latency benefit here still
applies. But if you find you are consistently arriving second, move the host
closer to the sequencer before tuning anything else — no amount of code will
recover a 100 ms network handicap.

Everything below works regardless of region.

## 1. Node.js 22

Ubuntu 24.04's `apt` Node is 18.x, and — the trap — **Ubuntu's `nodejs` package
does not include npm**; it's a separate package there. NodeSource's does. So if
the NodeSource step silently fails, `apt install nodejs` falls back to Ubuntu's
package and you get `sudo: npm: command not found`.

```bash
sudo apt update && sudo apt install -y curl git build-essential

# Purge first — NodeSource's nodejs conflicts with Ubuntu's npm/libnode-dev.
sudo apt-get purge -y nodejs npm libnode-dev nodejs-doc
sudo apt-get autoremove -y

curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

node -v && npm -v      # must print v22.x and 10.x
```

Watch the `curl | bash` output. If it errors, stop and fix it — otherwise the
following `apt install` quietly gives you the wrong Node.

### Do not use nvm for the service

nvm installs per-user under `$HOME/.nvm` and is a shell function loaded from
`.bashrc`. That breaks in two places:

- `sudo -u liqbot npm ...` never sources `.bashrc`, and if nvm was installed as
  root the binaries sit under `/root` (mode 700) where `liqbot` cannot reach
  them.
- systemd has no `node` on PATH at all, and hardcoding
  `/root/.nvm/versions/node/vX/bin/node` breaks on every `nvm install`.

Keep nvm for interactive work if you like, but the service needs a system-wide
Node in `/usr/bin` or `/usr/local/bin`. If you prefer not to use apt, the
official tarball works anywhere:

```bash
NODE_VER=v22.21.1   # check current LTS at https://nodejs.org/dist/
curl -fsSL "https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-linux-x64.tar.xz" -o /tmp/node.tar.xz
sudo tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1
/usr/local/bin/node -v && /usr/local/bin/npm -v
```

## 2. Get the code

```bash
sudo adduser --system --group --home /opt/liq-bot liqbot
sudo -u liqbot git clone git@github.com:vargha1/liq-bot.git /opt/liq-bot/app
cd /opt/liq-bot/app
sudo chown -R liqbot:liqbot /opt/liq-bot   # if you cloned as root
sudo -u liqbot npm ci
```

`npm ci` (not `npm install`) so you get exactly the locked dependency versions.

## 3. Configure

```bash
sudo -u liqbot cp .env.example .env
sudo -u liqbot chmod 600 .env
sudo -u liqbot nano .env
```

Required: `RPC_URL`, `RPC_WS`, `PRIVATE_KEY`, `CONTRACT_ADDRESS`.

`chmod 600` matters — the file holds the key that controls your liquidator
contract.

**Raise `RPC_CALLS_PER_SECOND`.** The default of 4 is a floor chosen for a
throttled free tier and it starves every subsystem. Set it to whatever your
Chainstack plan actually allows (25+ is normal on a paid plan).

## 4. Verify before going live

```bash
sudo -u liqbot npx tsx src/checkFeeds.ts "$RPC_URL"
```
Expect ~19 reserves resolving to ~12 aggregators, none marked `STILL A PROXY`.

```bash
sudo -u liqbot npx tsx src/checkModel.ts "$RPC_URL" <someBorrowerAddress>
```
Expect `drift = 0.000 bps` and `Model agrees with Aave.` If this diverges, the
trigger engine is making decisions on wrong health factors — stop and
investigate before running.

```bash
sudo -u liqbot npm run check-feed        # optional accelerator
```
Only set `SEQUENCER_FEED_ENABLED=true` once this reports matched aggregator
calls with decoded answers. If it cannot connect from your host, leave it off —
the bot works fine without it.

## 5. Build and run under systemd

```bash
sudo -u liqbot npm run build
```

`/etc/systemd/system/liq-bot.service`:

```ini
[Unit]
Description=Aave V3 Liquidation Bot (Arbitrum)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=liqbot
Group=liqbot
WorkingDirectory=/opt/liq-bot/app
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=liq-bot

# The bot holds a hot wallet key — keep the blast radius small.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/liq-bot/app
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
MemoryMax=2G

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now liq-bot
sudo systemctl status liq-bot
journalctl -u liq-bot -f
```

`ProtectSystem=strict` + `ReadWritePaths` means the process can only write
inside its own directory — it needs that for the position caches and logs.

## 6. What healthy startup looks like

```
ReserveRegistry: 20/20 reserves loaded
Connected to Arbitrum | block ...
Trigger engine: resolved 19/19 reserves to 12 distinct aggregators
Trigger engine: subscribed to AnswerUpdated aggregator events
Subscribed to ReserveDataUpdated — indices now update without RPC
Bot ready — watching for blocks
```

Then within a few minutes the model fills in the background and you should see
`⚡ Trigger:` lines when prices move.

### Chainstack plan limits

On plans without archive access, `eth_getLogs` is rejected with
`-32002 Archive, Debug and Trace requests are not available on your current
plan` — even for very recent ranges. Live `eth_subscribe` still works, so
detection is unaffected, but two things degrade:

- **Gap-fill after a WS reconnect does nothing.** Aave events missed while the
  socket was down are not replayed; those positions are picked up again by the
  next sweep or their next on-chain event instead.
- **The cold-start on-chain scan cannot run.** Set `THEGRAPH_API_KEY` so seeding
  uses the subgraph, which is the faster path anyway.

Neither is fatal. Upgrading the plan restores both.

Red flags:
- `no resolvable Chainlink feeds` — feed resolution failed; run `checkFeeds`.
- `Multicall failed ... falling back to individual calls` repeatedly — your RPC
  is rejecting batch sizes; lower `MC_SUBCHUNK`.
- Watchdog warnings about no cycle processed — the RPC is too slow or rate
  limited.

## 7. Updating

```bash
cd /opt/liq-bot/app
sudo -u liqbot git pull
sudo -u liqbot npm ci
sudo -u liqbot npm run build
sudo systemctl restart liq-bot
```

## 8. Operational notes

- **Keep ETH in the bot wallet** for gas. It warns below 0.05 ETH and again
  below 0.02.
- **Re-run `checkModel` after any Aave upgrade.** Aave 3.2 changed the e-mode
  rules and the `UserReserveData` struct; both silently broke this bot before.
- **Log rotation**: `logs/` is gitignored but grows on disk. Add a logrotate
  rule or rely on journald if you drop the file logger.
- **First run is slow.** With no cache on disk it seeds the borrower list from
  the subgraph (set `THEGRAPH_API_KEY`) or, failing that, does a full on-chain
  scan that takes 15–25 minutes. That is one-time.
