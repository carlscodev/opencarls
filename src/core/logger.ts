/**
 * OpenCarls — Logger con anillo en memoria (alimenta CLI TUI y gateway SSE)
 * y persistencia en .agent/logs/daemon.log con rotación simple por tamaño.
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { CONFIG, ensureAgentDirs } from "./config";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  ts: number;
  level: LogLevel;
  scope: string;
  msg: string;
  data?: unknown;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN_LEVEL: number = LEVEL_ORDER[(process.env.OPENCARLS_LOG_LEVEL as LogLevel) ?? "info"] ?? 20;

const MAX_LOG_BYTES = 32 * 1024 * 1024; // rotación simple: daemon.log → .1

const ring: LogEntry[] = [];
let fileReady = false;

function logFile(): string {
  ensureAgentDirs();
  return join(CONFIG.logs_dir, "daemon.log");
}

function rotateIfNeeded(): void {
  try {
    const st = statSync(logFile());
    if (st.size > MAX_LOG_BYTES) {
      renameSync(logFile(), `${logFile()}.1`);
    }
  } catch {
    /* archivo aún no existe */
  }
}

function emit(level: LogLevel, scope: string, msg: string, data?: unknown): void {
  if (LEVEL_ORDER[level] < MIN_LEVEL) return;

  const entry: LogEntry = { ts: Date.now(), level, scope, msg, ...(data !== undefined ? { data } : {}) };
  ring.push(entry);
  if (ring.length > CONFIG.telemetry.ring_size) ring.splice(0, ring.length - CONFIG.telemetry.ring_size);

  const iso = new Date(entry.ts).toISOString();
  const line =
    data !== undefined
      ? `${iso} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg} ${safeJson(data)}\n`
      : `${iso} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}\n`;

  // Consola con color cuando es TTY — SIEMPRE por stderr para que stdout
  // quede reservado al JSON de resultados (pipeable a jq).
  const useColor = Boolean(process.stderr.isTTY);
  const c =
    level === "error" ? "\x1b[31m" : level === "warn" ? "\x1b[33m" : level === "debug" ? "\x1b[90m" : "\x1b[36m";
  const out = useColor ? `${c}${line}\x1b[0m` : line;
  process.stderr.write(out);

  // Persistencia best-effort (nunca debe tumbar al daemon)
  try {
    if (!fileReady) {
      mkdirSync(CONFIG.logs_dir, { recursive: true });
      rotateIfNeeded();
      fileReady = true;
    }
    appendFileSync(logFile(), line);
  } catch {
    fileReady = false;
  }
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, (_k, val) => (typeof val === "bigint" ? String(val) : val));
  } catch {
    return String(v);
  }
}

export interface Logger {
  debug(msg: string, data?: unknown): void;
  info(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  error(msg: string, data?: unknown): void;
  child(scope: string): Logger;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (m, d) => emit("debug", scope, m, d),
    info: (m, d) => emit("info", scope, m, d),
    warn: (m, d) => emit("warn", scope, m, d),
    error: (m, d) => emit("error", scope, m, d),
    child: (s) => createLogger(`${scope}:${s}`),
  };
}

/** Snapshot del anillo (CLI/gateway lo consumen para render en tiempo real). */
export function ringBuffer(): readonly LogEntry[] {
  return ring;
}

export const logger = createLogger("opencarls");
