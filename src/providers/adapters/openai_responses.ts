/**
 * OpenCarls — Adapter OpenAI `/v1/responses` (oficial y proxies compatibles).
 *
 * Necesario para el tool nativo `computer_use_preview` (Computer Use):
 *  - `tools: [{type:'computer_use_preview', display_width, display_height,
 *    environment:'linux'}]` → los `computer_call` del stream se traducen a
 *    tool_calls unificadas (`computer_call`) para el bucle agéntico.
 *  - Reasoning: `response.reasoning_summary_text.delta` → reasoning_delta.
 */
import type {
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

function headers(cfg: ProviderDef, key: string): Record<string, string> {
  const h: Record<string, string> = {
    "content-type": "application/json",
    accept: "text/event-stream, application/json",
    "keep-alive": "timeout=600",
  };
  if (key) h.authorization = `Bearer ${key}`;
  return { ...h, ...(cfg.default_headers ?? {}) };
}

/** Mapea mensajes + tool calls al formato `input` de /v1/responses. */
export function mapInputResponses(req: ChatRequest): unknown[] {
  const out: unknown[] = [];
  for (const m of req.messages) {
    if (m.role === "system") {
      out.push({ role: "developer", content: m.content });
      continue;
    }
    if (m.role === "user") {
      out.push({ role: "user", content: m.content });
      continue;
    }
    if (m.role === "tool") {
      out.push({
        type: "function_call_output",
        call_id: m.tool_call_id ?? "",
        output: m.content,
      });
      continue;
    }
    // assistant
    if (m.tool_calls?.length) {
      if (m.content) out.push({ role: "assistant", content: m.content });
      for (const tc of m.tool_calls) {
        out.push({ type: "function_call", call_id: tc.id, name: tc.name, arguments: tc.arguments || "{}" });
      }
    } else {
      out.push({ role: "assistant", content: m.content });
    }
  }
  return out;
}

function buildBody(req: ChatRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.model,
    input: mapInputResponses(req),
    stream: true,
    ...(req.max_tokens !== undefined ? { max_output_tokens: req.max_tokens } : {}),
    ...(req.extra ?? {}),
  };
  delete (body as Record<string, unknown>).computer;
  const tools: unknown[] = [];
  for (const t of req.tools ?? []) {
    tools.push({
      type: "function",
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    });
  }
  const computer = req.extra?.computer as
    | { display_width: number; display_height: number }
    | undefined;
  if (computer) {
    tools.push({
      type: "computer_use_preview",
      display_width: computer.display_width,
      display_height: computer.display_height,
      environment: (req.extra?.environment as string | undefined) ?? "linux",
    });
  }
  if (tools.length) body.tools = tools;
  return body;
}

async function post(
  cfg: ProviderDef,
  req: ChatRequest,
  attempt: number,
): Promise<Response> {
  const key = cfg.api_key_env ? (process.env[cfg.api_key_env] ?? "") : "";
  const url = `${cfg.base_url.replace(/\/$/, "")}/responses`;
  const signal = AbortSignal.any([
    ...(req.signal ? [req.signal] : []),
    AbortSignal.timeout(cfg.timeout_ms),
  ]);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: headers(cfg, key),
      body: JSON.stringify(buildBody(req)),
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
  if (!res.body) throw new Error("responses: body vacío");
  return res;
}

type FnItem = { call_id?: string; name?: string; arguments?: string };

export async function* streamChatResponses(
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
        await sleep(
          backoffDelay(attempt, cfg.retry.base_delay_ms, (e as RetryableHttpError).retry_after_ms),
        );
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
  const res = await post(cfg, req, attempt);
  const acc: { usage: { input: number; output: number } | null } = { usage: null };
  /** call_id → estado de la tool call en curso. */
  const calls = new Map<string, { name: string; args: string; ended: boolean }>();
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
    const type = obj.type as string | undefined;
    if (!type) return out;
    if (type === "response.failed" || type === "error") {
      const err = (obj.response as { error?: { message?: string } } | undefined)?.error ??
        (obj.error as { message?: string } | undefined);
      throw new Error(`responses: ${err?.message ?? type}`);
    }
    if (type === "response.reasoning_summary_text.delta") {
      const d = obj.delta as string | undefined;
      if (d) out.push({ type: "reasoning_delta", text: d });
      return out;
    }
    if (type === "response.output_text.delta") {
      const d = obj.delta as string | undefined;
      if (d) out.push({ type: "text_delta", text: d });
      return out;
    }
    if (type === "response.output_item.added") {
      const item = obj.item as
        | { type?: string; call_id?: string; name?: string; id?: string }
        | undefined;
      if (item?.type === "function_call" || item?.type === "computer_call") {
        const callId = item.call_id ?? item.id ?? `call_${calls.size}`;
        if (!calls.has(callId)) {
          const name = item.type === "computer_call" ? "computer_call" : (item.name ?? "");
          calls.set(callId, { name, args: "", ended: false });
          out.push({ type: "tool_call_start", id: callId, name });
        }
      }
      return out;
    }
    if (type === "response.function_call_arguments.delta") {
      const callId = obj.call_id as string | undefined;
      const d = obj.delta as string | undefined;
      if (callId && d) {
        const entry = calls.get(callId);
        if (entry) entry.args += d;
        out.push({ type: "tool_call_delta", id: callId, args_delta: d });
      }
      return out;
    }
    if (type === "response.output_item.done") {
      const item = obj.item as
        | { type?: string; call_id?: string; id?: string; name?: string; arguments?: string; action?: unknown; status?: string }
        | undefined;
      if (item?.type === "function_call") {
        const callId = item.call_id ?? item.id ?? "";
        let entry = calls.get(callId);
        if (!entry) {
          entry = { name: item.name ?? "", args: "", ended: false };
          calls.set(callId, entry);
          out.push({ type: "tool_call_start", id: callId, name: item.name ?? "" });
        }
        if (item.arguments && !entry.args) {
          out.push({ type: "tool_call_delta", id: callId, args_delta: item.arguments });
          entry.args = item.arguments;
        }
        if (!entry.ended) {
          entry.ended = true;
          out.push({ type: "tool_call_end", id: callId });
        }
      }
      if (item?.type === "computer_call") {
        const callId = item.call_id ?? item.id ?? "";
        const action = item.action;
        const args = JSON.stringify(action ?? {});
        let entry = calls.get(callId);
        if (!entry) {
          entry = { name: "computer_call", args: "", ended: false };
          calls.set(callId, entry);
          out.push({ type: "tool_call_start", id: callId, name: "computer_call" });
        }
        out.push({ type: "tool_call_delta", id: callId, args_delta: args });
        entry.args = args;
        if (!entry.ended) {
          entry.ended = true;
          out.push({ type: "tool_call_end", id: callId });
        }
      }
      return out;
    }
    if (type === "response.completed") {
      const u = (obj.response as { usage?: { input_tokens?: number; output_tokens?: number } } | undefined)
        ?.usage;
      if (u) acc.usage = { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0 };
      return out;
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

  for (const [id, c] of calls) {
    if (!c.ended) {
      if (c.args) yield { type: "tool_call_delta", id, args_delta: c.args };
      yield { type: "tool_call_end", id };
    }
  }
  if (acc.usage) yield { type: "usage", input_tokens: acc.usage.input, output_tokens: acc.usage.output };
  yield { type: "done" };
}

export async function completeChatResponses(
  cfg: ProviderDef,
  req: ChatRequest,
): Promise<ChatResult> {
  let attempt = 0;
  for (;;) {
    try {
      const key = cfg.api_key_env ? (process.env[cfg.api_key_env] ?? "") : "";
      const url = `${cfg.base_url.replace(/\/$/, "")}/responses`;
      const body = buildBody(req);
      body.stream = false;
      const signal = AbortSignal.any([
        ...(req.signal ? [req.signal] : []),
        AbortSignal.timeout(cfg.timeout_ms),
      ]);
      const res = await fetch(url, {
        method: "POST",
        headers: headers(cfg, key),
        body: JSON.stringify(body),
        signal,
        keepalive: true,
      });
      if (!res.ok) {
        const text = (await res.text().catch(() => "")).slice(0, 600);
        if (RETRYABLE_STATUS.has(res.status) && attempt < cfg.retry.max) {
          throw new RetryableHttpError(res.status, `HTTP ${res.status}: ${text}`, null);
        }
        throw new Error(`HTTP ${res.status}: ${text}`);
      }
      const json = (await res.json()) as {
        output?: Array<{
          type?: string;
          role?: string;
          content?: Array<{ type?: string; text?: string }>;
          call_id?: string;
          name?: string;
          arguments?: string;
          action?: unknown;
        }>;
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      let content = "";
      const tool_calls: ToolCallRequest[] = [];
      for (const item of json.output ?? []) {
        if (item.type === "message" && Array.isArray(item.content)) {
          for (const c of item.content) if (c.type === "output_text" && c.text) content += c.text;
        }
        if (item.type === "function_call" || item.type === "computer_call") {
          tool_calls.push({
            id: item.call_id ?? `call_${tool_calls.length}`,
            name: item.type === "computer_call" ? "computer_call" : (item.name ?? ""),
            arguments:
              item.type === "computer_call"
                ? JSON.stringify(item.action ?? {})
                : (item.arguments ?? "{}"),
          });
        }
      }
      return {
        content,
        reasoning: "",
        tool_calls,
        usage: json.usage
          ? { input_tokens: json.usage.input_tokens ?? 0, output_tokens: json.usage.output_tokens ?? 0 }
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
