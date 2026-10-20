/**
 * OpenCarls — Adapter Anthropic Messages API (Claude).
 *
 *  - `extended_thinking` (budget configurable) con round-trip del bloque
 *    `thinking` + `signature` entre turnos (requisito de la API).
 *  - Tool `computer_20250124` soportada vía `req.extra.computer`.
 *  - Stream SSE → eventos unificados (thinking_delta → reasoning_delta).
 */
import type {
  ChatMessage,
  ChatRequest,
  ChatResult,
  ProviderDef,
  StreamEvent,
  ToolCallRequest,
} from "../types";
import {
  RETRYABLE_STATUS,
  RetryableHttpError,
  backoffDelay,
  readSse,
  sleep,
} from "../sse";

const ANTHROPIC_VERSION = "2023-06-01";

function headers(cfg: ProviderDef, key: string): Record<string, string> {
  return {
    "content-type": "application/json",
    accept: "text/event-stream, application/json",
    "keep-alive": "timeout=600",
    "x-api-key": key,
    "anthropic-version": ANTHROPIC_VERSION,
    ...(cfg.default_headers ?? {}),
  };
}

type AnthropicContent =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

function mapMessagesAnthropic(messages: ChatMessage[]): unknown[] {
  const out: Array<{ role: "user" | "assistant"; content: AnthropicContent[] }> = [];
  for (const m of messages) {
    if (m.role === "system") continue; // → campo system
    if (m.role === "tool") {
      out.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: m.tool_call_id ?? "",
            content: m.content,
            ...(m.content.startsWith("[error]") ? { is_error: true } : {}),
          },
        ],
      });
      continue;
    }
    if (m.role === "assistant") {
      const content: AnthropicContent[] = [];
      if (m.anthropic_thinking) {
        content.push({
          type: "thinking",
          thinking: m.anthropic_thinking.thinking,
          signature: m.anthropic_thinking.signature,
        });
      }
      if (m.content) content.push({ type: "text", text: m.content });
      for (const tc of m.tool_calls ?? []) {
        let input: unknown = {};
        try {
          input = JSON.parse(tc.arguments || "{}");
        } catch {
          input = {};
        }
        content.push({ type: "tool_use", id: tc.id, name: tc.name, input });
      }
      if (content.length > 0) out.push({ role: "assistant", content });
      continue;
    }
    // user — fusiona con el user anterior (evita roles alternados inválidos)
    const item = { role: "user" as const, content: [{ type: "text" as const, text: m.content }] };
    const prev = out[out.length - 1];
    if (prev && prev.role === "user" && prev.content[0]?.type === "text" && item.content[0]) {
      prev.content[0] = {
        type: "text",
        text: `${prev.content[0].text}\n\n${(item.content[0] as { text: string }).text}`,
      };
    } else {
      out.push(item);
    }
  }
  return out;
}

function buildBody(cfg: ProviderDef, req: ChatRequest, stream: boolean): Record<string, unknown> {
  const system = req.messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
  const thinkingBudget =
    (req.extra?.thinking_budget as number | undefined) ??
    (req.extra?.thinking === false ? 0 : undefined);
  const body: Record<string, unknown> = {
    model: req.model,
    max_tokens: req.max_tokens ?? (thinkingBudget ? thinkingBudget + 8192 : 16_384),
    messages: mapMessagesAnthropic(req.messages),
    stream,
    ...(system ? { system } : {}),
    ...(req.temperature !== undefined ? { temperature: Math.min(req.temperature, 1) } : {}),
    ...(req.extra ?? {}),
  };
  delete (body as Record<string, unknown>).thinking_budget;
  delete (body as Record<string, unknown>).thinking;
  if (thinkingBudget && thinkingBudget > 0) {
    body.thinking = { type: "enabled", budget_tokens: thinkingBudget };
  }
  if (req.tools?.length) {
    body.tools = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));
  }
  void cfg;
  return body;
}

async function post(
  cfg: ProviderDef,
  req: ChatRequest,
  body: Record<string, unknown>,
  attempt: number,
): Promise<Response> {
  const key = process.env[cfg.api_key_env] ?? "";
  const url = `${cfg.base_url.replace(/\/$/, "")}/messages`;
  const signal = AbortSignal.any([
    ...(req.signal ? [req.signal] : []),
    AbortSignal.timeout(cfg.timeout_ms),
  ]);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: headers(cfg, key),
      body: JSON.stringify(body),
      signal,
      keepalive: true,
    });
  } catch (e) {
    if (attempt < cfg.retry.max && !req.signal?.aborted) throw new RetryableHttpError(0, String(e));
    throw e;
  }
  if (!res.ok) {
    const text = (await res.text().catch(() => "")).slice(0, 600);
    if (RETRYABLE_STATUS.has(res.status) && attempt < cfg.retry.max) {
      const ra = res.headers.get("retry-after");
      throw new RetryableHttpError(res.status, `HTTP ${res.status}: ${text}`, ra ? Number(ra) * 1000 : null);
    }
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return res;
}

export async function* streamChatAnthropic(
  cfg: ProviderDef,
  req: ChatRequest,
): AsyncGenerator<StreamEvent> {
  let attempt = 0;
  for (;;) {
    try {
      yield* streamOnce(cfg, req, attempt);
      return;
    } catch (e) {
      const can =
        e instanceof RetryableHttpError && attempt < cfg.retry.max && !req.signal?.aborted;
      if (can) {
        await sleep(backoffDelay(attempt, cfg.retry.base_delay_ms, (e as RetryableHttpError).retry_after_ms));
        attempt++;
        continue;
      }
      yield { type: "error", error: e instanceof Error ? e.message : String(e), retryable: false };
      yield { type: "done" };
      return;
    }
  }
}

async function* streamOnce(
  cfg: ProviderDef,
  req: ChatRequest,
  attempt: number,
): AsyncGenerator<StreamEvent> {
  const res = await post(cfg, req, buildBody(cfg, req, true), attempt);

  const toolCalls = new Map<number, { id: string; name: string; args: string; started: boolean }>();
  const thinking: { text: string; signature: string } = { text: "", signature: "" };
  const acc: {
    usage: { input: number; output: number } | null;
    outText: string;
  } = { usage: null, outText: "" };

  const queue: StreamEvent[] = [];
  let readError: unknown = null;
  let finished = false;
  let wake: (() => void) | null = null;
  const wakeup = (): void => {
    const w = wake;
    wake = null;
    w?.();
  };

  const handle = (data: string): StreamEvent[] => {
    const out: StreamEvent[] = [];
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return out;
    }
    const type = obj.type as string;
    if (type === "error") {
      const err = obj.error as { message?: string };
      throw new Error(`anthropic: ${err?.message ?? JSON.stringify(obj.error).slice(0, 300)}`);
    }
    if (type === "message_start") {
      const u = (obj.message as { usage?: { input_tokens?: number } } | undefined)?.usage;
      if (u?.input_tokens !== undefined) acc.usage = { input: u.input_tokens, output: 0 };
      return out;
    }
    if (type === "content_block_start") {
      const block = obj.content_block as { type?: string; id?: string; name?: string } | undefined;
      const idx = obj.index as number | undefined ?? 0;
      if (block?.type === "tool_use") {
        toolCalls.set(idx, {
          id: block.id ?? `tu_${idx}`,
          name: block.name ?? "",
          args: "",
          started: true,
        });
        out.push({ type: "tool_call_start", id: block.id ?? `tu_${idx}`, name: block.name ?? "" });
      }
      return out;
    }
    if (type === "content_block_delta") {
      const d = obj.delta as
        | { type?: string; text?: string; thinking?: string; signature?: string; partial_json?: string }
        | undefined;
      const idx = obj.index as number | undefined ?? 0;
      if (d?.type === "text_delta" && d.text) out.push({ type: "text_delta", text: d.text });
      if (d?.type === "thinking_delta" && d.thinking) {
        thinking.text += d.thinking;
        out.push({ type: "reasoning_delta", text: d.thinking });
      }
      if (d?.type === "signature_delta" && d.signature) thinking.signature += d.signature;
      if (d?.type === "input_json_delta" && d.partial_json) {
        const entry = toolCalls.get(idx);
        if (entry) {
          entry.args += d.partial_json;
          out.push({ type: "tool_call_delta", id: entry.id, args_delta: d.partial_json });
        }
      }
      return out;
    }
    if (type === "content_block_stop") {
      const idx = obj.index as number | undefined ?? 0;
      const entry = toolCalls.get(idx);
      if (entry) out.push({ type: "tool_call_end", id: entry.id });
      return out;
    }
    if (type === "message_delta") {
      const u = (obj.delta as { usage?: { output_tokens?: number } } | undefined)?.usage;
      if (u?.output_tokens !== undefined) {
        acc.usage = { input: acc.usage?.input ?? 0, output: u.output_tokens };
      }
      return out;
    }
    if (type === "message_stop") {
      // fin normal — el caller cierra
    }
    return out;
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
    while (queue.length > 0) yield queue.shift()!;
    if (readError) throw readError;
    if (finished) break;
    await new Promise<void>((r) => {
      wake = r;
    });
  }
  while (queue.length > 0) yield queue.shift()!;
  await pump;
  if (readError) throw readError;

  if (acc.usage) yield { type: "usage", input_tokens: acc.usage.input, output_tokens: acc.usage.output };
  yield { type: "done" };
}

export async function completeChatAnthropic(
  cfg: ProviderDef,
  req: ChatRequest,
): Promise<ChatResult & { anthropic_thinking?: { thinking: string; signature: string } }> {
  let attempt = 0;
  for (;;) {
    try {
      const res = await post(cfg, req, buildBody(cfg, req, false), attempt);
      const json = (await res.json()) as {
        content?: Array<
          | { type: "text"; text: string }
          | { type: "thinking"; thinking: string; signature?: string }
          | { type: "tool_use"; id: string; name: string; input: unknown }
        >;
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      let content = "";
      let thinking = "";
      let signature = "";
      const tool_calls: ToolCallRequest[] = [];
      for (const b of json.content ?? []) {
        if (b.type === "text") content += b.text;
        if (b.type === "thinking") {
          thinking = b.thinking;
          signature = b.signature ?? "";
        }
        if (b.type === "tool_use") {
          tool_calls.push({ id: b.id, name: b.name, arguments: JSON.stringify(b.input ?? {}) });
        }
      }
      return {
        content,
        reasoning: thinking,
        tool_calls,
        usage: json.usage
          ? {
              input_tokens: json.usage.input_tokens ?? 0,
              output_tokens: json.usage.output_tokens ?? 0,
            }
          : undefined,
        anthropic_thinking: thinking ? { thinking, signature } : undefined,
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
