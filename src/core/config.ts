/**
 * OpenCarls — Configuración central del runtime.
 * Rutas resueltas una sola vez; todo es sobre-escribible por variables de
 * entorno para despliegues multi-daemon en la misma máquina aislada.
 */
import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

/** Raíz del proyecto: src/core/config.ts → raíz = <root> */
const PROJECT_ROOT = resolve(import.meta.dir, "..", "..");

function envStr(key: string, fallback: string): string {
  const v = process.env[key];
  return v !== undefined && v !== "" ? v : fallback;
}

/** HOME del agente (memoria, skills, captures, logs). */
const AGENT_HOME_RAW = envStr("OPENCARLS_HOME", join(PROJECT_ROOT, ".agent"));
export const AGENT_HOME = isAbsolute(AGENT_HOME_RAW)
  ? AGENT_HOME_RAW
  : resolve(PROJECT_ROOT, AGENT_HOME_RAW);

export const CONFIG = {
  project_root: PROJECT_ROOT,
  agent_home: AGENT_HOME,
  db_path: envStr("OPENCARLS_DB", join(AGENT_HOME, "opencarls.db")),
  logs_dir: join(AGENT_HOME, "logs"),
  captures_dir: join(AGENT_HOME, "captures"),
  skills_dir: join(AGENT_HOME, "skills"),
  tmp_dir: join(AGENT_HOME, "tmp"),
  mcp_config_path: envStr("OPENCARLS_MCP_CONFIG", join(PROJECT_ROOT, "mcp_config.json")),

  /** Display X11 por defecto para gnome_vision / gnome_input. */
  display: envStr("DISPLAY", ":0"),

  /** Telemetría / límites operativos. */
  telemetry: {
    /** Anillo de logs en RAM que alimentará la CLI (Fase 4) y el gateway. */
    ring_size: 2000,
    /** Límite de captura por comando de bash_session (bytes retenidos). */
    bash_capture_limit_bytes: 512 * 1024,
    /** Timeouts por defecto. */
    bash_default_timeout_ms: 60_000,
    vision_default_timeout_ms: 15_000,
  },

  /** Identidad del daemon. */
  daemon: {
    name: "opencarls",
    version: "0.1.0",
    phase: 1,
  },
} as const;

/** Crea el árbol de directorios del agente si no existe (idempotente). */
export function ensureAgentDirs(): void {
  for (const dir of [
    AGENT_HOME,
    CONFIG.logs_dir,
    CONFIG.captures_dir,
    CONFIG.skills_dir,
    CONFIG.tmp_dir,
  ]) {
    mkdirSync(dir, { recursive: true });
  }
}

/** Único archivo temporal con nombre seguro dentro de .agent/tmp. */
export function tmpFile(prefix: string, ext: string): string {
  ensureAgentDirs();
  const safe = prefix.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);
  return join(CONFIG.tmp_dir, `${safe}-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}.${ext.replace(/^\./, "")}`);
}

export { dirname, join };
