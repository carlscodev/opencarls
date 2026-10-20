/**
 * OpenCarls — Registry unificado de herramientas.
 * Todas las herramientas del catálogo (nativas + MCP en Fase 2) se
 * registran aquí; el LLM las invoca vía `executeTool(name, rawInput)`
 * con validación zod obligatoria. Nunca lanza: devuelve ToolResult.
 */
import type { z } from "zod";
import { createLogger } from "../core/logger";
import { recordToolCall } from "../memory/db";
import { fail, ok, type AnyToolDefinition, type ToolContext, type ToolResult } from "../types";

const log = createLogger("tools");

const registry = new Map<string, AnyToolDefinition>();

export function registerTool(def: AnyToolDefinition): void {
  if (registry.has(def.name)) {
    log.warn(`herramienta '${def.name}' re-registrada (hot-reload)`);
  }
  registry.set(def.name, def);
  log.debug(`registrada: ${def.name}`);
}

export function registerTools(defs: ReadonlyArray<AnyToolDefinition>): void {
  for (const d of defs) registerTool(d);
}

export function getTool(name: string): AnyToolDefinition | undefined {
  return registry.get(name);
}

export function listTools(): AnyToolDefinition[] {
  return [...registry.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Elimina una herramienta (usado por el Skill Forge al archivar skills). */
export function unregisterTool(name: string): boolean {
  return registry.delete(name);
}

/**
 * Invocación segura: parse zod → handler → captura de errores → telemetría.
 * El contrato con el LLM: siempre devuelve ToolResult (ok/data|error).
 */
export async function executeTool(
  name: string,
  rawInput: unknown,
  ctx: ToolContext = {},
): Promise<ToolResult> {
  const started = performance.now();
  const def = registry.get(name);

  if (!def) {
    const r = fail(
      `herramienta desconocida: '${name}'. Disponibles: ${[...registry.keys()].join(", ")}`,
      0,
    );
    recordToolCall(name, false, 0, r.error, ctx.session_id);
    return r;
  }

  const parsed = def.inputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i: z.ZodIssue) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    const r = fail(`input inválido para '${name}': ${detail}`, performance.now() - started);
    recordToolCall(name, false, r.duration_ms, r.error, ctx.session_id);
    return r;
  }

  try {
    const data = await def.handler(parsed.data, ctx);
    const duration = performance.now() - started;
    recordToolCall(name, true, duration, undefined, ctx.session_id);
    log.debug(`${name} ok`, { ms: Math.round(duration) });
    return ok(data, duration);
  } catch (e) {
    const duration = performance.now() - started;
    const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    log.error(`${name} falló`, { err: msg, ms: Math.round(duration) });
    recordToolCall(name, false, duration, msg, ctx.session_id);
    return fail(msg, duration);
  }
}

/** Formato compacto de catálogo para el system-prompt del LLM. */
export function toolCatalogMarkdown(): string {
  return listTools()
    .map((t) => {
      const desc = t.description.trim().replace(/\s+/g, " ");
      return `### ${t.name}\n${desc}`;
    })
    .join("\n\n");
}
