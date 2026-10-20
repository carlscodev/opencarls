/**
 * OpenCarls — Adapter OpenAI Chat Completions (stream + non-stream).
 *
 * Cubre: NVIDIA NIM, OpenAI oficial & proxies custom (`openai-compatible`),
 * OpenRouter, Moonshot/Kimi, DeepSeek, Groq, Gemini (openai endpoint),
 * Ollama, vLLM — cualquier `/v1/chat/completions` estándar.
 *
 * Resiliencia (NIM de alta latencia):
 *  - timeout total `cfg.timeout_ms` (600 s p/ NVIDIA) con AbortSignal.
 *  - keep-alive por defecto (undici/Bun pool) + headers explícitos.
 *  - reintentos exponenciales ante 429/502/503/504 (+Retry-After) ANTES de
 *    consumir el stream, y reenvío solo si aún no hubo salida (sin duplicar).
 *  - SSE tolerante a silencios largos (watchdog de `idle_ms`, ver sse.ts).
 *  - Reasoning unificado: `delta.reasoning_content` | `delta.reasoning` |
 *    etiquetas `thinking` dentro de `content` (extractor en vivo).
 */
import type {
  ChatMessage,
  ChatRequest,
  ChatResult,
  ProviderDef,
  StreamEvent,
  ToolCallRequest,
} from "../types";
import { ReasoningTagExtractor } from "../reasoning";
import {
  RETRYABLE_STATUS,
  RetryableHttpError,
  backoffDelay,
  readSse,
  sleep,
} from "../sse";

function buildHeaders(cfg: ProviderDef, key: string): Record<string, string> {
  const h: Record<string, string> = {
    "content-type": "application/json",
    accept: "text/event-stream, application/json",
    "keep-alive": "timeout=600",
    ...(cfg.default_headers ?? {}),
  };
  if (key) h.authorization = `Bearer ${key}`;
  return h;
}

export function mapMessagesOpenAi(messages: ChatMessage[]): unknown[] {
  return messages.map((m) => {
    if (m.role === "tool") {
      return { role: "tool", tool_call_id: m.tool_call_id ?? "", content: m.content };
    }
    if (m.role === "assistant" && m.tool_calls?.length) {
      return {
        role: "assistant",
        content: m.content || null,
        tool_calls: m.tool_calls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: tc.arguments || "{}" },
        })),
      };
    }
    if (m.images?.length && m.content !== undefined) {
      return {
        role: m.role,
        content: [
          { type: "text", text: m.content },
          ...m.images.map((url) => ({ type: "image_url", image_url: { url } })),
        ],
      };
    }
    return { role: m.role, content: m.content };
  });
}

function buildBody(cfg: ProviderDef, req: ChatRequest, stream: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.model,
    messages: mapMessagesOpenAi(req.messages),
    stream,
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(req.max_tokens !== undefined ? { max_tokens: req.max_tokens } : {}),
    ...(req.extra ?? {}),
  };
  if (req.tools?.length) {
    body.tools = req.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
    body.tool_choice = (req.extra?.tool_choice as string | undefined) ?? "auto";
  }
  if (stream && !cfg.no_stream_options) {
    body.stream_options = { include_usage: true };
  }
  return body;
}

async function fetchWithRetry(
  cfg: ProviderDef,
  req: ChatRequest,
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  attempt: number,
): Promise<Response> {
  const timeoutSignal = AbortSignal.timeout(cfg.timeout_ms);
  const signal = req.signal ? AbortSignal.any([req.signal, timeoutSignal]) : timeoutSignal;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
      keepalive: true,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (attempt < cfg.retry.max && !req.signal?.aborted) {
      const delay = backoffDelay(attempt, cfg.retry.base_delay_ms, null);
      await sleep(delay);
      throw new RetryableHttpError(0, `network: ${msg}`); // señal de reintento externo
    }
    throw new Error(`fetch falló tras ${attempt + 1} intentos: ${msg}`);
  }
  if (!res.ok) {
    const text = (await res.text().catch(() => "")).slice(0, 600);
    const retryAfter = res.headers.get("retry-after");
    const retryAfterMs = retryAfter ? Number(retryAfter) * 1000 : null;
    if (RETRYABLE_STATUS.has(res.status) && attempt < cfg.retry.max) {
      throw new RetryableHttpError(res.status, `HTTP ${res.status}: ${text}`, retryAfterMs);
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `autenticación rechazada (${res.status}) — revisa ${cfg.api_key_env || "api key"}: ${text}`,
      );
    }
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  if (!res.body) throw new Error("respuesta sin body (stream vacío)");
  return res;
}

/**
 * Stream unificado con reintentos. Emite eventos normalizados; nunca lanza
 * al caller: los errores terminan con `{type:'error'}` + `done`.
 */
export async function* streamChatCompletions(
  cfg: ProviderDef,
  req: ChatRequest,
): AsyncGenerator<StreamEvent> {
  let attempt = 0;
  let produced = false;
  for (;;) {
    const local: StreamEvent[] = [];
    try {
      for await (const ev of streamOnceInner(cfg, req, attempt, local)) {
        if (
          ev.type === "text_delta" ||
          ev.type === "reasoning_delta" ||
          ev.type === "tool_call_start"
        ) {
          produced = true;
        }
        yield ev;
      }
      return;
    } catch (e) {
      const retryable =
        e instanceof RetryableHttpError || (e instanceof Error && e.name === "SseIdleError");
      const canRetry = retryable && attempt < cfg.retry.max && !produced && !req.signal?.aborted;
      if (canRetry) {
        const ra = e instanceof RetryableHttpError ? e.retry_after_ms : null;
        await sleep(backoffDelay(attempt, cfg.retry.base_delay_ms, ra));
        attempt++;
        continue;
      }
      yield {
        type: "error",
        error: e instanceof Error ? e.message : String(e),
        retryable: false,
      };
      yield { type: "done" };
      return;
    }
  }
}

async function* streamOnceInner(
  cfg: ProviderDef,
  req: ChatRequest,
  attempt: number,
  _local: StreamEvent[],
): AsyncGenerator<StreamEvent> {
  const key = cfg.api_key_env ? (process.env[cfg.api_key_env] ?? "") : "";
  const url = `${cfg.base_url.replace(/\/$/, "")}/chat/completions`;
  const headers = buildHeaders(cfg, key);
  const body = buildBody(cfg, req, true);

  let res: Response;
  try {
    res = await fetchWithRetry(cfg, req, url, headers, body, attempt);
  } catch (e) {
    if (e instanceof RetryableHttpError) {
      if (e.status !== 0) await sleep(backoffDelay(attempt, cfg.retry.base_delay_ms, e.retry_after_ms));
      throw e; // el caller decide reintentar
    }
    throw e;
  }

  const extractor = new ReasoningTagExtractor();
  const toolCalls = new Map<number, { id: string; name: string; args: string; started: boolean }>();
  const acc: { usage: { input: number; output: number } | null } = { usage: null };

  const handle = (data: string): StreamEvent[] => {
    const out: StreamEvent[] = [];
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return out;
    }
    if (obj.error) {
      const err = obj.error as { message?: string };
      throw new Error(`stream error: ${err?.message ?? JSON.stringify(obj.error).slice(0, 400)}`);
    }
    const u = obj.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
    if (u && (u.prompt_tokens !== undefined || u.completion_tokens !== undefined)) {
      acc.usage = { input: u.prompt_tokens ?? 0, output: u.completion_tokens ?? 0 };
    }
    const choices = obj.choices as
      | Array<{
          delta?: {
            content?: string | null;
            reasoning_content?: string | null;
            reasoning?: string | null;
            tool_calls?: Array<{
              index?: number;
              id?: string;
              function?: { name?: string; arguments?: string };
            }>;
          };
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        }>
      | undefined;
    const ch = choices?.[0];
    if (!ch) return out;
    if (ch.usage && !acc.usage) {
      acc.usage = { input: ch.usage.prompt_tokens ?? 0, output: ch.usage.completion_tokens ?? 0 };
    }
    const d = ch.delta;
    if (!d) return out;

    if (typeof d.reasoning_content === "string" && d.reasoning_content) {
      out.push({ type: "reasoning_delta", text: d.reasoning_content });
    }
    if (typeof d.reasoning === "string" && d.reasoning) {
      out.push({ type: "reasoning_delta", text: d.reasoning });
    }
    if (typeof d.content === "string" && d.content) {
      const fed = extractor.feed(d.content);
      if (fed.reasoning) out.push({ type: "reasoning_delta", text: fed.reasoning });
      if (fed.content) out.push({ type: "text_delta", text: fed.content });
    }
    if (d.tool_calls) {
      for (const tc of d.tool_calls) {
        const idx = tc.index ?? 0;
        let entry = toolCalls.get(idx);
        if (!entry) {
          entry = { id: tc.id ?? `call_${idx}_${Date.now()}`, name: "", args: "", started: false };
          toolCalls.set(idx, entry);
        }
        if (tc.id) entry.id = tc.id;
        if (tc.function?.name) entry.name += tc.function.name;
        if (tc.function?.arguments) entry.args += tc.function.arguments;
        if (!entry.started && entry.name) {
          entry.started = true;
          out.push({ type: "tool_call_start", id: entry.id, name: entry.name });
        }
        if (entry.started && tc.function?.arguments) {
          out.push({ type: "tool_call_delta", id: entry.id, args_delta: tc.function.arguments });
        }
      }
    }
    return out;
  };

  // Pump en vivo: readSse corre en paralelo y va encolando eventos que este
  // generador YIELD-EA en tiempo real (onReasoningDelta sin esperar EOF).
  const queue: StreamEvent[] = [];
  let readError: unknown = null;
  let finished = false;
  let wake: (() => void) | null = null;
  const wakeup = (): void => {
    const w = wake;
    wake = null;
    w?.();
  };

  const pump = readSse(
    res.body!,
    (data) => {
      if (readError) return;
      try {
        for (const ev of handle(data)) queue.push(ev);
        wakeup();
      } catch (e) {
        readError = e;
        void res.body?.cancel().catch(() => {});
        wakeup();
      }
    },
    { idle_ms: cfg.idle_ms, signal: req.signal },
  )
    .catch((e) => {
      readError = e;
    })
    .finally(() => {
      finished = true;
      wakeup();
    });

  for (;;) {
    while (queue.length > 0) {
      yield queue.shift()!;
    }
    if (readError) throw readError;
    if (finished) break;
    await new Promise<void>((r) => {
      wake = r;
    });
  }
  while (queue.length > 0) yield queue.shift()!;
  await pump;
  if (readError) throw readError;

  // flush del extractor (hold final) + cierres de tool calls
  const flushed = extractor.flush();
  if (flushed.reasoning) yield { type: "reasoning_delta", text: flushed.reasoning };
  if (flushed.content) yield { type: "text_delta", text: flushed.content };
  for (const [, tc] of toolCalls) {
    if (!tc.started) {
      yield { type: "tool_call_start", id: tc.id, name: tc.name || "unknown" };
      if (tc.args) yield { type: "tool_call_delta", id: tc.id, args_delta: tc.args };
    }
    yield { type: "tool_call_end", id: tc.id };
  }
  if (acc.usage) yield { type: "usage", input_tokens: acc.usage.input, output_tokens: acc.usage.output };
  yield { type: "done" };
}

/** Completado no-stream (fallback / tests). */
export async function completeChatCompletions(
  cfg: ProviderDef,
  req: ChatRequest,
): Promise<ChatResult> {
  const key = cfg.api_key_env ? (process.env[cfg.api_key_env] ?? "") : "";
  const url = `${cfg.base_url.replace(/\/$/, "")}/chat/completions`;
  const headers = buildHeaders(cfg, key);
  const body = buildBody(cfg, req, false);

  let attempt = 0;
  for (;;) {
    try {
      const res = await fetchWithRetry(cfg, req, url, headers, body, attempt);
      const json = (await res.json()) as {
        choices?: Array<{
          message?: {
            content?: string | null;
            reasoning_content?: string | null;
            reasoning?: string | null;
            tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
          };
        }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const msg = json.choices?.[0]?.message;
      if (!msg) throw new Error("respuesta sin choices[0].message");
      const tool_calls: ToolCallRequest[] = (msg.tool_calls ?? []).map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        arguments:
          typeof tc.function.arguments === "string"
            ? tc.function.arguments
            : JSON.stringify(tc.function.arguments),
      }));
      return {
        content: msg.content ?? "",
        reasoning: msg.reasoning_content ?? msg.reasoning ?? "",
        tool_calls,
        usage: json.usage
          ? { input_tokens: json.usage.prompt_tokens ?? 0, output_tokens: json.usage.completion_tokens ?? 0 }
          : undefined,
      };
    } catch (e) {
      if (e instanceof RetryableHttpError && attempt < cfg.retry.max) {
        await sleep(backoffDelay(attempt, cfg.retry.base_delay_ms, e.retry_after_ms));
        attempt++;
        continue;
      }
      throw e;
    }
  }
}
