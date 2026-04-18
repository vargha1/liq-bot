import { createLogger, format, transports } from "winston";
import { CONFIG } from "./config";
import * as fs from "fs";
import * as path from "path";
import * as http from "http";

// ── Log directory ─────────────────────────────────────────────────────────────
// Always relative to the project root (where package.json lives), NOT process.cwd().
// This means logs are written to liq-bot/logs/ regardless of which directory you
// run `npm run dev` from.
const PROJECT_ROOT = path.resolve(__dirname, "..");
const LOG_DIR      = path.join(PROJECT_ROOT, "logs");
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

// ── Formatters ────────────────────────────────────────────────────────────────
const fmt = format.printf(({ level, message, timestamp: ts, stack }) => {
  const base = `${ts} [${level}] ${message}`;
  return (stack as string | undefined) ? `${base}\n${stack}` : base;
});

const fileFmt = format.combine(
  format.errors({ stack: true }),
  format.timestamp({ format: "YYYY-MM-DD HH:mm:ss.SSS" }),
  fmt,
);

const consoleFmt = format.combine(
  format.errors({ stack: true }),
  format.timestamp({ format: "YYYY-MM-DD HH:mm:ss.SSS" }),
  format.colorize({ all: true }),
  fmt,
);

// ── Logger instance ───────────────────────────────────────────────────────────
export const logger = createLogger({
  level: CONFIG.logLevel,
  transports: [
    new transports.Console({ format: consoleFmt }),
    new transports.File({
      filename: path.join(LOG_DIR, "liquidator.log"),
      format:   fileFmt,
      maxsize:  50 * 1024 * 1024,   // 50 MB — rotate at 50 MB
      maxFiles: 5,                   // keep 5 rotated files
      tailable: true,
    }),
    new transports.File({
      filename: path.join(LOG_DIR, "errors.log"),
      level:    "error",
      format:   fileFmt,
      maxsize:  10 * 1024 * 1024,
      maxFiles: 3,
      tailable: true,
    }),
  ],
});

// ── Runtime log-level switching ───────────────────────────────────────────────
//
// Three ways to change log level without restarting the bot:
//
//   1. Signals (Linux/macOS):
//        SIGUSR1  →  more verbose (e.g. info → debug)
//        SIGUSR2  →  less verbose (e.g. debug → info)
//      Usage: kill -USR1 <pid>   (PID printed at startup)
//
//   2. HTTP (localhost only):
//        GET  http://localhost:3099/loglevel          → show current level
//        POST http://localhost:3099/loglevel/<level>  → set level
//      Example: curl -X POST http://localhost:3099/loglevel/debug
//
//   3. File: echo debug > loglevel.ctrl
//      The file is consumed and deleted after the level is applied.
//
// Valid levels: error, warn, info, http, verbose, debug, silly

const LEVELS = ["error", "warn", "info", "http", "verbose", "debug", "silly"] as const;
type Level = typeof LEVELS[number];

function isValidLevel(s: string): s is Level {
  return (LEVELS as readonly string[]).includes(s);
}

export function setLogLevel(level: string): boolean {
  if (!isValidLevel(level)) {
    logger.warn(`setLogLevel: invalid level "${level}" — valid: ${LEVELS.join(", ")}`);
    return false;
  }
  if (logger.level === level) return true;
  const prev = logger.level;
  logger.level = level;
  logger.info(`Log level: ${prev} → ${level}`);
  return true;
}

function cycleLevel(direction: "up" | "down"): void {
  const idx = LEVELS.indexOf(logger.level as Level);
  if (idx === -1) return;
  const next = direction === "up"
    ? LEVELS[Math.min(idx + 1, LEVELS.length - 1)]
    : LEVELS[Math.max(idx - 1, 0)];
  if (next) setLogLevel(next);
}

// ── Signal handlers ───────────────────────────────────────────────────────────
process.on("SIGUSR1", () => cycleLevel("up"));    // more verbose
process.on("SIGUSR2", () => cycleLevel("down"));  // less verbose

// ── HTTP control server ───────────────────────────────────────────────────────
const LOG_CTRL_PORT = parseInt(process.env["LOG_CTRL_PORT"] ?? "3099", 10);

const ctrlServer = http.createServer((req, res) => {
  const url    = req.url  ?? "/";
  const method = req.method ?? "GET";

  if (method === "GET" && url === "/loglevel") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ level: logger.level, valid: LEVELS }));
    return;
  }

  const match = url.match(/^\/loglevel\/([a-z]+)$/);
  if (method === "POST" && match) {
    const ok = setLogLevel(match[1]!);
    res.writeHead(ok ? 200 : 400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok, level: logger.level }));
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found\n");
});

// Bind to localhost only — no need to expose on all interfaces
ctrlServer.listen(LOG_CTRL_PORT, "127.0.0.1", () => {
  logger.info(`Log-level control: http://127.0.0.1:${LOG_CTRL_PORT}/loglevel`);
});

ctrlServer.on("error", (e: Error & { code?: string }) => {
  if (e.code === "EADDRINUSE") {
    // Port already in use (e.g. two instances running, or previous process didn't exit cleanly).
    // Non-fatal — SIGUSR1/2 and file-watch still work.
    logger.warn(`Log-level HTTP server: port ${LOG_CTRL_PORT} already in use — use signals or loglevel.ctrl file instead`);
  } else {
    logger.warn(`Log-level HTTP server error (${e.code ?? e.message}) — signals still work`);
  }
});

// ── File watcher ──────────────────────────────────────────────────────────────
// Write a level name to ./loglevel.ctrl to change the level without signals.
// Useful inside Docker or when you don't have easy shell access.
// Example: echo debug > loglevel.ctrl
const CTRL_FILE = path.join(PROJECT_ROOT, "loglevel.ctrl");

fs.watchFile(CTRL_FILE, { interval: 1_000 }, () => {
  try {
    if (!fs.existsSync(CTRL_FILE)) return;
    const level = fs.readFileSync(CTRL_FILE, "utf8").trim().toLowerCase();
    fs.unlinkSync(CTRL_FILE);
    setLogLevel(level);
  } catch { /* ignore read/unlink races */ }
});

// ── Startup info ──────────────────────────────────────────────────────────────
logger.info(`PID ${process.pid} | log level: ${logger.level} | log dir: ${LOG_DIR}`);
logger.info(`SIGUSR1=more-verbose SIGUSR2=less-verbose | curl -X POST http://127.0.0.1:${LOG_CTRL_PORT}/loglevel/debug`);
