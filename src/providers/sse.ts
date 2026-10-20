/**
 * OpenCarls — Parser SSE tolerante (corazón de los adapters con streaming).
 *
 * - Cumple el formato event/data/comentario con dispatch en línea en blanco.
 * - **Tolerante a silencios largos:** watchdog de `idle_ms` (default 10 min
 *   para NVIDIA) — un silencio NO corta el stream salvo que supere esa cota.
 * - Maneja chunks parciales, `\r\n`, comentarios `:` (heartbeats) y [DONE].
 */
export class SseIdleError extends Error {
  constructor(idleMs: number) {
    super(`silencio SSE > ${idleMs}ms`);
    this.name = "SseIdleError";
  }
}

export interface SseOptions {
  /** Silencio máximo antes de abortar (NVIDIA: 600_000 ms). */
  idle_ms: number;
  signal?: AbortSignal | undefined;
  /** Payload `[DONE]` llega como onDone. */
  onDone?: () => void;
  onComment?: (comment: string) => void;
}

export async function readSse(
  body: ReadableStream<Uint8Array>,
  onEvent: (data: string) => void | Promise<void>,
  opts: SseOptions,
): Promise<void> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let dataLines: string[] = [];
  let done = false;

  const dispatch = async (): Promise<void> => {
    if (dataLines.length === 0) return;
    const data = dataLines.join("\n");
    dataLines = [];
    if (data === "[DONE]") {
      done = true;
      opts.onDone?.();
      return;
    }
    await onEvent(data);
  };

  const handleLine = async (line: string): Promise<void> => {
    if (line === "") return dispatch(); // fin de evento
    if (line.startsWith(":")) {
      opts.onComment?.(line.slice(1).trim());
      return;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).replace(/^ /, ""));
      return;
    }
    // event:/id:/retry: → ignorado (el payload ya lleva `type`)
  };

  try {
    while (!done) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;
      const idlePromise = new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new SseIdleError(opts.idle_ms)), opts.idle_ms);
        if (opts.signal) {
          onAbort = () => rej(new DOMException("aborted", "AbortError"));
          opts.signal.addEventListener("abort", onAbort, { once: true });
        }
      });
      let result: { done: boolean; value?: Uint8Array };
      try {
        result = (await Promise.race([reader.read(), idlePromise])) as { done: boolean; value?: Uint8Array };
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        if (onAbort && opts.signal) opts.signal.removeEventListener("abort", onAbort);
      }
      if (result.done) break;
      if (!result.value || result.value.byteLength === 0) continue;
      buf += dec.decode(result.value, { stream: true });

      let nl = buf.indexOf("\n");
      while (nl !== -1) {
        let line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        await handleLine(line);
        if (done) break;
        nl = buf.indexOf("\n");
      }
    }
    if (!done && buf.length > 0) {
      // Última línea sin newline final
      if (buf.endsWith("\r")) buf = buf.slice(0, -1);
      await handleLine(buf);
    }
    if (!done && dataLines.length > 0) await dispatch();
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* noop */
    }
  }
}

/** API helper: fetch con timeouts extendidos + keep-alive + retry exponencial. */
export class RetryableHttpError extends Error {
  status: number;
  retry_after_ms: number | null;
  constructor(status: number, message: string, retry_after_ms: number | null = null) {
    super(message);
    this.name = "RetryableHttpError";
    this.status = status;
    this.retry_after_ms = retry_after_ms;
  }
}

export const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504, 522, 524]);

export function backoffDelay(attempt: number, baseMs: number, retryAfterMs: number | null): number {
  if (retryAfterMs !== null) return Math.min(retryAfterMs, 60_000);
  const exp = baseMs * 2 ** attempt;
  const jitter = Math.floor(Math.random() * baseMs);
  return Math.min(exp + jitter, 30_000);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
