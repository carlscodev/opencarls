/**
 * OpenCarls — Tipos compartidos del contrato de herramientas.
 * Todas las herramientas validan con zod y devuelven ToolResult;
 * NUNCA lanzan excepciones hacia el llamador (se capturan en el registry).
 */
import type { z } from "zod";

export interface ToolContext {
  /** Sesión lógica actual (tabla `sessions`), si existe. */
  session_id?: string | undefined;
  /** Cwd sugerido para operaciones relativas. */
  cwd?: string | undefined;
  /** Display X11 (solo tools que lo necesiten; null si no hay X). */
  display?: string | undefined;
  /** Identidad del agente conectado (proveedor/modelo), si aplica. */
  agent?: { provider_id?: string | undefined; model?: string | undefined } | undefined;
}

export interface ToolResult {
  ok: boolean;
  /** Carga útil estructurada (siempre JSON-serializable). */
  data?: unknown;
  /** Mensaje de fallo cuando ok=false. */
  error?: string;
  duration_ms: number;
}

export interface ToolDefinition<TSchema extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  /** Esquema zod del input; el registry hace parse antes del handler. */
  inputSchema: TSchema;
  handler: (input: z.infer<TSchema>, ctx: ToolContext) => Promise<unknown> | unknown;
  /** Fase catálogo (1..4) — para documentación/telemetría. */
  phase?: number;
}

/**
 * Forma ERASED almacenada por el registry (evita el invariance del parámetro
 * genérico TSchema; en runtime es exactamente el mismo objeto).
 */
export type AnyToolDefinition = {
  name: string;
  description: string;
  phase?: number | undefined;
  inputSchema: z.ZodTypeAny;
  /**
   * JSON Schema crudo (tools MCP u orígenes externos) — cuando existe, el
   * serializador de tools para el LLM lo usa directamente sin convertir zod.
   */
  jsonSchema?: unknown | undefined;
  // `any` intencional: el parse zod ya validó el payload antes de llegar aquí.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (input: any, ctx: ToolContext) => Promise<unknown> | unknown;
};

export function ok<T>(data: T, duration_ms = 0): ToolResult {
  return { ok: true, data, duration_ms };
}

export function fail(error: string, duration_ms = 0): ToolResult {
  return { ok: false, error, duration_ms };
}
