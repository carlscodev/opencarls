/**
 * OpenCarls — Compactor: compactación de contexto del agente.
 *
 * Cuando la ventana supera `threshold_ratio` del presupuesto, resume TODO lo
 * que no esté en la ventana reciente en un bloque `[contexto compactado]`
 * (vía `completeChat` del proveedor; fallback heurístico offline si no hay
 * key), lo persiste en `episodic_memory` (kind='compaction') y devuelve el
 * hilo reescrito. Nunca lanza.
 */
import type { ChatMessage } from "../providers/types";
import { completeChat, resolveProvider, providerHasKey, defaultModel } from "../providers/router";
import { createLogger } from "../core/logger";
import { remember } from "./db";

const log = createLogger("compactor");

/** Aproximación estable de tokens (≈4 chars/token para ES/EN mezclado). */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4) + (text.match(/\n/g)?.length ?? 0);
}

export function estimateMessagesTokens(messages: ChatMessage[]): number {
  let total = 0;
  for (const m of messages) {
    total += estimateTokens(m.content ?? "");
    for (const tc of m.tool_calls ?? []) {
      total += estimateTokens(tc.name) + estimateTokens(tc.arguments);
    }
    total += 4; // overhead de rol/estructura
  }
  return total;
}

export interface CompactOptions {
  /** tokens de ventana SIEMPRE preservados (recientes) */
  keep_recent_tokens?: number;
  /** fracción del presupuesto que dispara la compactación (default 0.75) */
  threshold_ratio?: number;
  /** presupuesto de contexto del modelo (default 60_000) */
  budget_tokens?: number;
  provider?: string;
  model?: string;
  /** id de sesión para persistir el resumen */
  session_id?: string;
}

export interface CompactResult {
  messages: ChatMessage[];
  compacted: boolean;
  tokens_before: number;
  tokens_after: number;
  summary_tokens: number;
  dropped_messages: number;
  summary: string;
  mode: "llm" | "offline" | "none";
}

const COMPACTION_PROMPT = `Eres un compactador de contexto de un agente programador. Resume en MAXIMO 800 tokens, en markdown estructurado y en español, lo esencial del hilo anterior:
- Objetivo de la tarea y restricciones activas (los NO negociables)
- Decisiones tomadas (con rutas/archivos concretos)
- Estado actual: qué funciona, qué está pendiente, errores abiertos
- Resultados clave (comandos, valores, IDs) que NO se pueden perder
Solo hechos del hilo; nada de cortesías.`;

function offlineSummary(messages: ChatMessage[]): string {
  const lines: string[] = ["**[Contexto compactado — resumen heurístico]**"];
  for (const m of messages.slice(0, 60)) {
    const text = (m.content ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
    if (!text) continue;
    lines.push(`- \`${m.role}\`: ${text}`);
  }
  if (messages.length > 60) lines.push(`- … +${messages.length - 60} mensajes anteriores`);
  return lines.join("\n").slice(0, 12_000);
}

/**
 * Compacta `messages` si supera el umbral. Idempotente: un bloque previo
 * `[contexto compactado]` se REEMPLAZA (no se apila).
 */
export async function compactContext(
  messages: ChatMessage[],
  opts: CompactOptions = {},
): Promise<CompactResult> {
  const budget = opts.budget_tokens ?? 60_000;
  const threshold = opts.threshold_ratio ?? 0.75;
  const keepRecent = opts.keep_recent_tokens ?? Math.floor(budget * 0.3);
  const before = estimateMessagesTokens(messages);

  const empty: CompactResult = {
    messages,
    compacted: false,
    tokens_before: before,
    tokens_after: before,
    summary_tokens: 0,
    dropped_messages: 0,
    summary: "",
    mode: "none",
  };
  if (before <= budget * threshold) return empty;

  // Particionar: todo lo que supere keep_recent (desde el FINAL) es "reciente"
  const recentRev: ChatMessage[] = [];
  let acc = 0;
  let cut = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    const cost = estimateMessagesTokens([m]);
    if (acc + cost > keepRecent && recentRev.length > 0) {
      cut = i + 1;
      break;
    }
    acc += cost;
    recentRev.push(m);
    cut = i;
  }
  const old = messages.slice(0, cut);
  const recent = messages.slice(cut);

  if (old.length === 0) return empty;
  // No compactar si lo "viejo" es trivial
  if (estimateMessagesTokens(old) < budget * 0.15) return empty;

  // Descartar compactaciones previas del viejo (evita anidar)
  const oldFiltered = old.filter(
    (m) => !(m.role === "system" && m.content.startsWith("[contexto compactado]")),
  );
  if (oldFiltered.length === 0) return empty;

  let summary: string;
  let mode: "llm" | "offline";
  const cfg = resolveProvider(opts.provider);
  if (providerHasKey(cfg)) {
    try {
      const res = await completeChat(
        {
          model: opts.model ?? defaultModel(cfg),
          messages: [
            { role: "system", content: COMPACTION_PROMPT },
            {
              role: "user",
              content:
                "Hilo a comprimir (roles + contenido, recortado):\n\n" +
                oldFiltered
                  .slice(-80)
                  .map((m) => `<${m.role}>\n${(m.content ?? "").slice(0, 3_000)}\n</${m.role}>`)
                  .join("\n\n")
                  .slice(0, 100_000),
            },
          ],
          max_tokens: 1_400,
          temperature: 0.2,
        },
        { provider: opts.provider },
      );
      summary = (res.content || "").trim();
      if (!summary) throw new Error("resumen vacío");
      mode = "llm";
    } catch (e) {
      log.warn("compactación LLM falló → fallback offline", { err: String(e) });
      summary = offlineSummary(oldFiltered);
      mode = "offline";
    }
  } else {
    summary = offlineSummary(oldFiltered);
    mode = "offline";
  }

  const compactionMsg: ChatMessage = {
    role: "system",
    content:
      `[contexto compactado — ${new Date().toISOString()}]\n` +
      `Resumen del hilo anterior (${oldFiltered.length} mensajes, ~${estimateTokens(summary)} tokens):\n\n` +
      summary,
  };
  const out = [compactionMsg, ...recent];
  const after = estimateMessagesTokens(out);

  try {
    remember({
      kind: "compaction",
      title: `compactación ${oldFiltered.length}→${recent.length} mensajes`,
      summary: summary.slice(0, 2_000),
      details: `tokens ${before}→${after}; mode=${mode}`,
      tags: ["compactor", mode],
      importance: 7,
      source: "compactor",
      session_id: opts.session_id,
    });
  } catch (e) {
    log.warn("no se pudo persistir episodio de compactación", { err: String(e) });
  }

  log.info("contexto compactado", {
    before,
    after,
    dropped: oldFiltered.length,
    mode,
  });

  return {
    messages: out,
    compacted: true,
    tokens_before: before,
    tokens_after: after,
    summary_tokens: estimateTokens(summary),
    dropped_messages: oldFiltered.length,
    summary,
    mode,
  };
}
