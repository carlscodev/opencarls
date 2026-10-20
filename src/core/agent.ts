/**
 * OpenCarls — Agente bucle de herramientas con stream unificado.
 *
 * - Stream en vivo → eventos (`reasoning_delta`, `text_delta`, tools…)
 * - Tool-calling multi-turno hasta que el modelo deja de pedir tools o
 *   se alcanza `max_iterations`
 * - Compacción automática de contexto (compactor) entre turnos
 * - Nunca lanza: termina con `final_text` + stats
 */
import { estimateMessagesTokens } from "../memory/compactor";
import { compactContext } from "../memory/compactor";
import { streamChat, resolveProvider, defaultModel, providerHasKey } from "../providers/router";
import { zodToJsonSchema } from "../providers/json_schema";
import type { ChatMessage, StreamEvent, ToolCallRequest } from "../providers/types";
import { listTools, executeTool, toolCatalogMarkdown } from "../tools/registry";
import { registerAllTools } from "../tools/bundle";
import { listSkills, listTodos } from "../memory/db";
import { createLogger } from "./logger";

const log = createLogger("agent");

export type AgentEvent =
  | { type: "phase"; phase: string; detail?: string }
  | { type: "reasoning"; text: string }
  | { type: "text"; text: string }
  | { type: "tool_start"; name: string; input: unknown; id: string }
  | { type: "tool_end"; id: string; name: string; ok: boolean; duration_ms: number; preview: string }
  | { type: "usage"; input_tokens: number; output_tokens: number }
  | { type: "compact"; tokens_before: number; tokens_after: number; mode: string }
  | { type: "error"; error: string }
  | { type: "done"; final_text: string; iterations: number; tool_calls: number; duration_ms: number };

export interface AgentOptions {
  provider?: string;
  model?: string;
  system?: string;
  temperature?: number;
  max_tokens?: number;
  max_iterations?: number;
  budget_tokens?: number;
  session_id?: string;
  cwd?: string;
  provider_extra?: Record<string, unknown>;
  onEvent?: (ev: AgentEvent) => void;
}

export interface AgentRunResult {
  final_text: string;
  iterations: number;
  tool_calls: number;
  tokens_in: number;
  tokens_out: number;
  duration_ms: number;
  stopped: "done" | "max_iterations" | "error" | "no_stream";
  error?: string;
  messages: ChatMessage[];
}

function buildSystemPrompt(extra?: string): string {
  const skills = listSkills("active", 30);
  const todos = listTodos("open", 8);
  return [
    "Eres OpenCarls, un agente de ingeniería AUTÓNOMO y exhaustivo. Ejecutas sin confirmaciones (modo YOLO) en un entorno aislado. Produces código de grado producción: sin placeholders, sin TODOs, sin preguntas al usuario.",
    "",
    "## Reglas",
    "- Ejecuta herramientas en vez de adivinar; verifica cada cambio (diagnósticos/tests).",
    "- Cambios múltiples en varios archivos → `multi_patch` (transaccional).",
    "- Diagnósticos con línea/columna → `lsp_diagnostics`.",
    "- Resumen de esta sesión y decisiones → memoria episódica vía tools existentes cuando aporte.",
    "- Responde en español; corte cuando la tarea esté VERIFICADA.",
    "",
    "## Catálogo de herramientas",
    toolCatalogMarkdown(),
    skills.length
      ? "\n## Skills activas\n" + skills.map((s) => `- ${s.slug} v${s.version}: ${s.description}`).join("\n")
      : "",
    todos.length
      ? "\n## Tablero (abierto)\n" + todos.map((t) => `- #${t.id} [${t.status}] ${t.title}`).join("\n")
      : "",
    extra ? `\n## Contexto de fase\n${extra}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function preview(v: unknown, max = 240): string {
  try {
    const s = typeof v === "string" ? v : JSON.stringify(v);
    return (s ?? "").replace(/\s+/g, " ").slice(0, max);
  } catch {
    return "";
  }
}

export class Agent {
  readonly opts: AgentOptions;
  messages: ChatMessage[] = [];
  private emit: (ev: AgentEvent) => void;

  constructor(opts: AgentOptions = {}) {
    this.opts = opts;
    this.emit = opts.onEvent ?? (() => {});
  }

  setSystem(extra: string): void {
    if (this.messages[0]?.role === "system") {
      this.messages[0] = { role: "system", content: buildSystemPrompt(extra) };
    } else {
      this.messages.unshift({ role: "system", content: buildSystemPrompt(extra) });
    }
  }

  reset(): void {
    this.messages = [];
  }

  /** Ejecuta un objetivo completo (loop hasta que no haya más tool calls). */
  async run(task: string): Promise<AgentRunResult> {
    // Defensa: proceso sin tools registradas (e2e, gateway, scripts sueltos).
    if (listTools().length === 0) registerAllTools();
    const cfg = resolveProvider(this.opts.provider);
    const model = this.opts.model ?? defaultModel(cfg);
    if (!providerHasKey(cfg)) {
      const err = `falta API key para '${cfg.id}' (${cfg.api_key_env || "n/a"})`;
      this.emit({ type: "error", error: err });
      return {
        final_text: "",
        iterations: 0,
        tool_calls: 0,
        tokens_in: 0,
        tokens_out: 0,
        duration_ms: 0,
        stopped: "error",
        error: err,
        messages: this.messages,
      };
    }
    if (this.messages.length === 0 || this.messages[0]?.role !== "system") {
      this.setSystem("");
    }
    this.messages.push({ role: "user", content: task });

    const started = Date.now();
    const maxIter = this.opts.max_iterations ?? 40;
    let iterations = 0;
    let totalCalls = 0;
    let tokensIn = 0;
    let tokensOut = 0;
    let finalText = "";
    let stopped: AgentRunResult["stopped"] = "done";
    let error: string | undefined;

    while (iterations < maxIter) {
      iterations++;

      // Compacción preventiva antes de cada llamada al LLM
      try {
        const c = await compactContext(this.messages, {
          budget_tokens: this.opts.budget_tokens ?? 60_000,
          session_id: this.opts.session_id,
          provider: this.opts.provider,
          model,
        });
        if (c.compacted) {
          this.messages = c.messages;
          this.emit({ type: "compact", tokens_before: c.tokens_before, tokens_after: c.tokens_after, mode: c.mode });
        }
      } catch (e) {
        log.warn("compactor saltado", { err: String(e) });
      }

      const tools = listTools().map((t) => ({
        name: t.name,
        description: t.description,
        parameters: (t.jsonSchema && typeof t.jsonSchema === "object"
          ? t.jsonSchema
          : t.inputSchema
            ? zodToJsonSchema(t.inputSchema)
            : { type: "object", properties: {} }) as Record<string, unknown>,
      }));

      // ── Stream ──
      let text = "";
      let reasoning = "";
      const calls = new Map<string, ToolCallRequest>();
      let streamError: string | null = null;
      let sawDone = false;
      const controller = new AbortController();

      const ev: ChatMessage = { role: "assistant", content: "" };
      try {
        const gen = streamChat(
          {
            model,
            messages: this.messages,
            tools: tools.length ? tools : undefined,
            temperature: this.opts.temperature ?? 0.3,
            max_tokens: this.opts.max_tokens,
            signal: controller.signal,
            extra: this.opts.provider_extra,
          },
          { provider: this.opts.provider },
        );
        for await (const e of gen as AsyncGenerator<StreamEvent>) {
          if (e.type === "reasoning_delta") {
            reasoning += e.text;
            this.emit({ type: "reasoning", text: e.text });
          } else if (e.type === "text_delta") {
            text += e.text;
            this.emit({ type: "text", text: e.text });
          } else if (e.type === "tool_call_start") {
            calls.set(e.id, { id: e.id, name: e.name, arguments: "" });
            this.emit({ type: "tool_start", name: e.name, input: null, id: e.id });
          } else if (e.type === "tool_call_delta") {
            const c = calls.get(e.id);
            if (c) c.arguments += e.args_delta;
          } else if (e.type === "tool_call_end") {
            /* cierre ya modelado */
          } else if (e.type === "usage") {
            tokensIn += e.input_tokens;
            tokensOut += e.output_tokens;
            this.emit({ type: "usage", input_tokens: e.input_tokens, output_tokens: e.output_tokens });
          } else if (e.type === "error") {
            streamError = e.error;
          } else if (e.type === "done") {
            sawDone = true;
          }
        }
      } catch (e) {
        streamError = e instanceof Error ? e.message : String(e);
      }

      if (streamError && !text && calls.size === 0) {
        this.emit({ type: "error", error: streamError });
        error = streamError;
        stopped = "error";
        break;
      }
      if (!sawDone && !streamError && !text && calls.size === 0) {
        stopped = "no_stream";
        break;
      }

      const toolCalls = [...calls.values()].filter((c) => c.name);
      ev.content = text;
      if (reasoning) ev.reasoning = reasoning;
      if (toolCalls.length) ev.tool_calls = toolCalls;
      finalText = text || finalText;
      this.messages.push(ev);

      if (toolCalls.length === 0) break;

      // ── Ejecución de tools ──
      for (const tc of toolCalls) {
        let input: unknown = {};
        const raw = tc.arguments.trim() || "{}";
        try {
          input = JSON.parse(raw);
        } catch (e) {
          input = {};
          log.warn("argumentos JSON rotos", { tool: tc.name, err: String(e) });
        }
        const t0 = Date.now();
        const result = await executeTool(tc.name, input, {
          session_id: this.opts.session_id,
          cwd: this.opts.cwd,
          display: undefined,
          agent: { provider_id: cfg.id, model },
        });
        totalCalls++;
        const dur = Date.now() - t0;
        this.emit({
          type: "tool_end",
          id: tc.id,
          name: tc.name,
          ok: result.ok,
          duration_ms: result.duration_ms || dur,
          preview: preview(result.ok ? result.data : result.error),
        });
        this.messages.push({
          role: "tool",
          tool_call_id: tc.id,
          name: tc.name,
          content: JSON.stringify(
            result.ok ? { ok: true, data: result.data } : { ok: false, error: result.error },
          ),
        });
      }
    }

    if (iterations >= maxIter && stopped === "done") stopped = "max_iterations";

    const duration = Date.now() - started;
    const res: AgentRunResult = {
      final_text: finalText,
      iterations,
      tool_calls: totalCalls,
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      duration_ms: duration,
      stopped,
      error,
      messages: this.messages,
    };
    this.emit({
      type: "done",
      final_text: finalText,
      iterations,
      tool_calls: totalCalls,
      duration_ms: duration,
    });
    return res;
  }

  /** Una sola llamada LLM sin tools (crítica, resúmenes, distilación). */
  async think(prompt: string, system?: string): Promise<string> {
    const cfg = resolveProvider(this.opts.provider);
    const model = this.opts.model ?? defaultModel(cfg);
    const { completeChat } = await import("../providers/router");
    const res = await completeChat(
      {
        model,
        messages: [
          { role: "system", content: system ?? "Eres un auditor experto. Respuesta concisa y accionable." },
          { role: "user", content: prompt },
        ],
        max_tokens: 2_000,
        temperature: 0.2,
        extra: this.opts.provider_extra,
      },
      { provider: this.opts.provider },
    );
    return res.content || "";
  }

  get contextTokens(): number {
    return estimateMessagesTokens(this.messages);
  }
}
