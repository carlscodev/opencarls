/**
 * OpenCarls — Enrutador Multi-Proveedor Universal.
 *
 * Proveedores de fábrica (todos con stream unificado + reasoning extractor):
 *   nvidia | openai | openai-compatible | anthropic | openrouter | moonshot |
 *   deepseek | groq | gemini | ollama | vllm
 *
 * - NVIDIA (default): 600 000 ms de timeout (API gratuita/ilimitada de ALTA
 *   latencia), keep-alive, reintentos exponenciales 429/502/503/504 y SSE
 *   tolerante a silencios largos.
 * - Lee `.env` del proyecto + variables de entorno (NVIDIA_API_KEY,
 *   OPENAI_API_KEY, OPENROUTER_API_KEY, …) y OPENCARLS_PROVIDER / OPENCARLS_MODEL.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "../core/logger";
import type {
  ChatRequest,
  ChatResult,
  ProviderDef,
  ProviderRequestOptions,
  StreamEvent,
} from "./types";
import { completeChatCompletions, streamChatCompletions } from "./adapters/openai_completions";
import { completeChatAnthropic, streamChatAnthropic } from "./adapters/anthropic";
import { completeChatResponses, streamChatResponses } from "./adapters/openai_responses";

const log = createLogger("providers");

/** 10 minutos — crítico para la alta latencia de NIM. */
const T_10MIN = 600_000;

export const PROVIDERS: Record<string, ProviderDef> = {
  nvidia: {
    id: "nvidia",
    label: "NVIDIA NIM",
    kind: "openai-completions",
    base_url: "https://integrate.api.nvidia.com/v1",
    api_key_env: "NVIDIA_API_KEY",
    timeout_ms: T_10MIN,
    idle_ms: T_10MIN,
    retry: { max: 5, base_delay_ms: 1_500 },
    default_model: "deepseek-ai/deepseek-v4.1-flash",
  },
  openai: {
    id: "openai",
    label: "OpenAI",
    kind: "openai-responses", // /v1/responses nativo (computer_use_preview)
    base_url: "https://api.openai.com/v1",
    api_key_env: "OPENAI_API_KEY",
    timeout_ms: 300_000,
    idle_ms: 300_000,
    retry: { max: 4, base_delay_ms: 1_000 },
    default_model: "gpt-4.1",
  },
  "openai-compatible": {
    id: "openai-compatible",
    label: "OpenAI-compatible (proxy/custom)",
    kind: "openai-completions",
    base_url: process.env.OPENAI_COMPAT_BASE_URL ?? "http://127.0.0.1:8080/v1",
    api_key_env: "OPENAI_COMPAT_API_KEY",
    timeout_ms: T_10MIN,
    idle_ms: T_10MIN,
    retry: { max: 4, base_delay_ms: 1_000 },
    default_model: process.env.OPENAI_COMPAT_MODEL,
  },
  anthropic: {
    id: "anthropic",
    label: "Anthropic (Claude)",
    kind: "anthropic",
    base_url: "https://api.anthropic.com/v1",
    api_key_env: "ANTHROPIC_API_KEY",
    timeout_ms: 300_000,
    idle_ms: 300_000,
    retry: { max: 4, base_delay_ms: 1_500 },
    default_model: "claude-sonnet-4-5",
  },
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    kind: "openai-completions",
    base_url: "https://openrouter.ai/api/v1",
    api_key_env: "OPENROUTER_API_KEY",
    default_headers: { "x-title": "OpenCarls" },
    timeout_ms: T_10MIN,
    idle_ms: T_10MIN,
    retry: { max: 5, base_delay_ms: 2_000 },
  },
  moonshot: {
    id: "moonshot",
    label: "Moonshot / Kimi",
    kind: "openai-completions",
    base_url: "https://api.moonshot.ai/v1",
    api_key_env: "MOONSHOT_API_KEY",
    timeout_ms: T_10MIN,
    idle_ms: T_10MIN,
    retry: { max: 4, base_delay_ms: 2_000 },
    default_model: "kimi-k2.5",
  },
  deepseek: {
    id: "deepseek",
    label: "DeepSeek",
    kind: "openai-completions",
    base_url: "https://api.deepseek.com/v1",
    api_key_env: "DEEPSEEK_API_KEY",
    timeout_ms: T_10MIN,
    idle_ms: T_10MIN,
    retry: { max: 4, base_delay_ms: 2_000 },
    default_model: "deepseek-reasoner",
  },
  groq: {
    id: "groq",
    label: "Groq",
    kind: "openai-completions",
    base_url: "https://api.groq.com/openai/v1",
    api_key_env: "GROQ_API_KEY",
    timeout_ms: 180_000,
    idle_ms: 180_000,
    retry: { max: 4, base_delay_ms: 800 },
  },
  gemini: {
    id: "gemini",
    label: "Google Gemini (openai endpoint)",
    kind: "openai-completions",
    base_url: "https://generativelanguage.googleapis.com/v1beta/openai",
    api_key_env: "GEMINI_API_KEY",
    timeout_ms: 300_000,
    idle_ms: 300_000,
    retry: { max: 4, base_delay_ms: 1_200 },
  },
  ollama: {
    id: "ollama",
    label: "Ollama (local)",
    kind: "openai-completions",
    base_url: "http://127.0.0.1:11434/v1",
    api_key_env: "",
    local: true,
    timeout_ms: T_10MIN,
    idle_ms: T_10MIN,
    retry: { max: 2, base_delay_ms: 500 },
    no_stream_options: true,
  },
  vllm: {
    id: "vllm",
    label: "vLLM (local)",
    kind: "openai-completions",
    base_url: "http://127.0.0.1:8000/v1",
    api_key_env: "",
    local: true,
    timeout_ms: T_10MIN,
    idle_ms: T_10MIN,
    retry: { max: 2, base_delay_ms: 500 },
    no_stream_options: true,
  },
};

let dotEnvLoaded = false;

/** Carga `.env` del proyecto sin pisar variables ya seteadas (idempotente). */
export function loadDotEnv(projectRoot?: string): void {
  if (dotEnvLoaded) return;
  dotEnvLoaded = true;
  const candidates = [
    join(projectRoot ?? join(import.meta.dir, "..", ".."), ".env"),
    join(process.cwd(), ".env"),
  ];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const text = readFileSync(p, "utf8");
      for (const raw of text.split("\n")) {
        const line = raw.trim();
        if (!line || line.startsWith("#")) continue;
        const eq = line.indexOf("=");
        if (eq <= 0) continue;
        const k = line.slice(0, eq).trim();
        let v = line.slice(eq + 1).trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
          v = v.slice(1, -1);
        }
        if (process.env[k] === undefined || process.env[k] === "") process.env[k] = v;
      }
      log.debug(".env cargado", { path: p });
      break;
    } catch (e) {
      log.warn(".env ilegible", { path: p, err: String(e) });
    }
  }
}

export function resolveProvider(id?: string): ProviderDef {
  loadDotEnv();
  const wanted = id ?? process.env.OPENCARLS_PROVIDER ?? "nvidia";
  const cfg = PROVIDERS[wanted];
  if (!cfg) {
    throw new Error(
      `proveedor desconocido '${wanted}'. Disponibles: ${Object.keys(PROVIDERS).join(", ")}`,
    );
  }
  // Permite override de base_url p/ custom proxies
  const baseOverride = process.env[
    `${wanted.toUpperCase().replace(/-/g, "_")}_BASE_URL`
  ];
  if (baseOverride && (wanted === "openai-compatible" || process.env.OPENCARLS_ALLOW_BASE_OVERRIDE === "1")) {
    return { ...cfg, base_url: baseOverride };
  }
  return cfg;
}

export function providerHasKey(cfg: ProviderDef): boolean {
  if (cfg.local || !cfg.api_key_env) return true;
  loadDotEnv();
  return Boolean(process.env[cfg.api_key_env]);
}

export function defaultModel(cfg: ProviderDef): string {
  loadDotEnv();
  const envModel = process.env.OPENCARLS_MODEL;
  if (envModel && envModel.trim()) return envModel.trim();
  if (cfg.default_model) return cfg.default_model;
  throw new Error(
    `no hay modelo para '${cfg.id}' — define OPENCARLS_MODEL o ${cfg.api_key_env}`,
  );
}

/** Stream unificado de cualquier proveedor (generador de StreamEvent). */
export async function* streamChat(
  req: ChatRequest,
  opts: ProviderRequestOptions = {},
): AsyncGenerator<StreamEvent> {
  const cfg = resolveProvider(opts.provider);
  if (!cfg.local && !providerHasKey(cfg)) {
    yield {
      type: "error",
      error: `falta la API key de ${cfg.id} (${cfg.api_key_env})`,
      retryable: false,
    };
    yield { type: "done" };
    return;
  }
  log.debug("streamChat", { provider: cfg.id, model: req.model, kind: cfg.kind });
  if (cfg.kind === "anthropic") {
    yield* streamChatAnthropic(cfg, req);
  } else if (cfg.kind === "openai-responses") {
    yield* streamChatResponses(cfg, req);
  } else {
    yield* streamChatCompletions(cfg, req);
  }
}

/** Completado no-stream (tests, compactor, crítica visual rápida). */
export async function completeChat(
  req: ChatRequest,
  opts: ProviderRequestOptions = {},
): Promise<ChatResult> {
  const cfg = resolveProvider(opts.provider);
  if (!cfg.local && !providerHasKey(cfg)) {
    throw new Error(`falta la API key de ${cfg.id} (${cfg.api_key_env})`);
  }
  if (cfg.kind === "anthropic") return completeChatAnthropic(cfg, req);
  if (cfg.kind === "openai-responses") return completeChatResponses(cfg, req);
  return completeChatCompletions(cfg, req);
}

/**
 * ¿Soporta el modo Computer-Use NATIVO del proveedor?
 * 'openai' → computer_use_preview / computer_call (responses)
 * 'anthropic' → computer_20250124
 * null → Set-of-Marks universal (modo 2)
 */
export function detectNativeComputerUse(
  providerId?: string,
  model?: string,
): "openai" | "anthropic" | null {
  const cfg = resolveProvider(providerId);
  const m = model ?? defaultModel(cfg);
  if (cfg.kind === "anthropic" && /^claude/i.test(m)) return "anthropic";
  if (cfg.kind === "openai-responses" || /computer-use|computer_use/i.test(m)) return "openai";
  return null;
}

export interface ProviderStatus {
  id: string;
  label: string;
  kind: string;
  base_url: string;
  key_present: boolean;
  key_env: string;
  is_default: boolean;
}

export function providerStatus(): ProviderStatus[] {
  loadDotEnv();
  const def = process.env.OPENCARLS_PROVIDER ?? "nvidia";
  return Object.values(PROVIDERS).map((p) => ({
    id: p.id,
    label: p.label,
    kind: p.kind,
    base_url: p.base_url,
    key_present: providerHasKey(p),
    key_env: p.api_key_env || "(local)",
    is_default: p.id === def,
  }));
}
