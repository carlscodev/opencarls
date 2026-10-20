/**
 * OpenCarls — Utilidades de proceso sobre Bun.spawn / Bun.spawnSync.
 * Ejecución directa SIN confirmaciones: timeouts con escalada SIGINT→SIGKILL.
 */
import type { Subprocess } from "bun";

type PipeProc = Subprocess<"pipe", "pipe", "pipe">;

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeout_ms?: number;
  /** Límite de bytes retenidos por stream (def. 512 KiB). */
  max_bytes?: number;
  input?: string;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  exit_code: number | null;
  signal: string | null;
  timed_out: boolean;
  duration_ms: number;
  truncated: boolean;
  cmd: string[];
}

const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_MAX_BYTES = 512 * 1024;

async function readCapped(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  if (!stream) return { text: "", truncated: false };
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (total >= maxBytes) {
        truncated = true;
        // Sigue drenando para no bloquear al hijo, pero no guardamos.
        continue;
      }
      const take = Math.min(value.byteLength, maxBytes - total);
      chunks.push(take === value.byteLength ? value : value.subarray(0, take));
      total += take;
      if (take < value.byteLength) truncated = true;
    }
  } catch {
    /* stream cerrado */
  }
  const dec = new TextDecoder();
  let text = "";
  for (const c of chunks) text += dec.decode(c, { stream: true });
  text += dec.decode();
  return { text, truncated };
}

/** Ejecuta un comando argv (sin shell) con timeout y límites de captura. */
export async function run(cmd: string[], opts: RunOptions = {}): Promise<RunResult> {
  const started = performance.now();
  const timeout = opts.timeout_ms ?? DEFAULT_TIMEOUT;
  const maxBytes = opts.max_bytes ?? DEFAULT_MAX_BYTES;

  let proc: PipeProc;
  try {
    proc = Bun.spawn({
      cmd,
      cwd: opts.cwd ?? process.cwd(),
      env: { ...(process.env as Record<string, string>), ...(opts.env ?? {}) },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (e) {
    return {
      stdout: "",
      stderr: `spawn failed: ${e instanceof Error ? e.message : String(e)}`,
      exit_code: null,
      signal: null,
      timed_out: false,
      duration_ms: Math.round(performance.now() - started),
      truncated: false,
      cmd,
    };
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill();
    } catch {
      /* ya murió */
    }
  }, timeout);

  try {
    if (opts.input !== undefined && proc.stdin) {
      try {
        proc.stdin.write(opts.input);
        proc.stdin.end();
      } catch {
        /* hijo no leyó stdin */
      }
    } else if (proc.stdin) {
      try {
        proc.stdin.end(); // EOF inmediato: evita bloqueos en lecturas de stdin
      } catch {
        /* noop */
      }
    }

    const [out, err, exitCode] = await Promise.all([
      readCapped(proc.stdout, maxBytes),
      readCapped(proc.stderr, maxBytes),
      proc.exited,
    ]);
    clearTimeout(timer);
    const sig = proc.signalCode;

    return {
      stdout: out.text,
      stderr: err.text,
      exit_code: timedOut ? null : exitCode,
      signal: sig === null || sig === undefined ? null : String(sig),
      timed_out: timedOut,
      duration_ms: Math.round(performance.now() - started),
      truncated: out.truncated || err.truncated,
      cmd,
    };
  } finally {
    clearTimeout(timer);
    if (!timedOut) {
      try {
        proc.kill();
      } catch {
        /* ya terminó */
      }
    }
  }
}

/** Variante síncrona para herramientas GUI cortas (xdotool, wmctrl, scrot). */
export function runSync(cmd: string[], opts: Omit<RunOptions, "input"> = {}): RunResult {
  const started = performance.now();
  try {
    const res = Bun.spawnSync({
      cmd,
      cwd: opts.cwd ?? process.cwd(),
      env: { ...(process.env as Record<string, string>), ...(opts.env ?? {}) },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const dec = new TextDecoder();
    let stdout = dec.decode(res.stdout ?? new Uint8Array());
    let stderr = dec.decode(res.stderr ?? new Uint8Array());
    let truncated = false;
    const maxBytes = opts.max_bytes ?? DEFAULT_MAX_BYTES;
    if (stdout.length > maxBytes) {
      stdout = stdout.slice(0, maxBytes);
      truncated = true;
    }
    if (stderr.length > maxBytes) {
      stderr = stderr.slice(0, maxBytes);
      truncated = true;
    }
    return {
      stdout,
      stderr,
      exit_code: res.exitCode ?? null,
      signal: null,
      timed_out: false,
      duration_ms: Math.round(performance.now() - started),
      truncated,
      cmd,
    };
  } catch (e) {
    return {
      stdout: "",
      stderr: `spawnSync failed: ${e instanceof Error ? e.message : String(e)}`,
      exit_code: null,
      signal: null,
      timed_out: false,
      duration_ms: Math.round(performance.now() - started),
      truncated: false,
      cmd,
    };
  }
}

/** Envuelve un comando en un shell (para pipelines del propio agente). */
export function runShell(script: string, opts: RunOptions = {}): Promise<RunResult> {
  return run(["bash", "-c", script], opts);
}
