/**
 * OpenCarls — Herramienta 1: `bash_session`.
 *
 * Sesión Bash PERSISTENTE sobre Ubuntu construida con `Bun.spawn()`:
 *   - cwd y variables de entorno persisten entre comandos (cd / export reales).
 *   - `sudo` directo (entorno preparado con NOPASSWD por setup_ubuntu.sh).
 *   - Procesos background con log propio + kill en árbol (`kill_tree`).
 *   - Lectura de logs en streaming (`tail_log` con follow acotado).
 *   - Interactividad opcional (`stdin: 'inherit'` + `send_stdin`).
 *   - Timeouts: SIGINT dirigido al ÁRBOL DE HIJOS (la sesión sobrevive y el
 *     sentinel se emite con rc=130) → TERM → kill de grupo como último recurso.
 *   - Comandos que contienen `exit` corren en subshell con reconciliación
 *     de PWD/exports: semántica exacta de `exit` sin perder la persistencia.
 *
 * Protocolo de delimitación: cada línea se envuelve con un sentinel único
 * `RS OC|<nonce>|<rc>|<cwd> RS` (o `RS OCBG|<nonce>|<pid> RS`) que bash
 * imprime al terminar. Bash corre con `--noediting` (cero echo de readline).
 */
import type { Subprocess } from "bun";
import { z } from "zod";
import { CONFIG, ensureAgentDirs } from "../core/config";
import { createLogger } from "../core/logger";
import { run } from "../util/proc";
import type { ToolDefinition } from "../types";

const log = createLogger("tool:bash_session");

const RS = "\x1e"; // Record Separator — delimitador inyectable

function nonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let s = "";
  for (const b of bytes) s += (b % 16).toString(16);
  return s;
}

function quote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function capString(s: string, maxBytes: number): { text: string; truncated: boolean } {
  if (s.length <= maxBytes) return { text: s, truncated: false };
  const head = Math.floor(maxBytes * 0.6);
  const tail = maxBytes - head;
  return {
    text:
      s.slice(0, head) +
      `\n…[opencarls truncó ${s.length - maxBytes} chars]…\n` +
      s.slice(s.length - tail),
    truncated: true,
  };
}

/** Ruido inherente a bash interactivo SIN tty: no aporta al resultado. */
function stripShellNoise(s: string): string {
  if (!s) return s;
  return s
    .split("\n")
    .filter(
      (line) =>
        !/^\s*bash: cannot set terminal process group/.test(line) &&
        !/^\s*bash: no job control in this shell/.test(line) &&
        !/^\s*bash: \[\d+: \d+ \(\d+\)\] tcsetattr/.test(line) &&
        !/^\s*bash: stty: /.test(line),
    )
    .join("\n");
}

/** Hijos directos de un pid (pgrep). */
function listChildPids(p: number): number[] {
  if (p <= 1) return [];
  try {
    const r = Bun.spawnSync(["pgrep", "-P", String(p)]);
    if (r.exitCode !== 0) return [];
    return new TextDecoder()
      .decode(r.stdout)
      .split(/\s+/)
      .map((n) => Number.parseInt(n, 10))
      .filter((n) => Number.isInteger(n) && n > 1);
  } catch {
    return [];
  }
}

/** Matar (o interrumpir) un árbol de procesos desde el OS, recursivamente. */
function killTreeOs(roots: number[], sig: NodeJS.Signals): void {
  const stack = [...roots];
  const seen = new Set<number>();
  while (stack.length > 0) {
    const p = stack.pop()!;
    if (seen.has(p)) continue;
    seen.add(p);
    for (const c of listChildPids(p)) stack.push(c);
    try {
      process.kill(p, sig);
    } catch {
      /* murió */
    }
  }
}

interface NeedleHit {
  output: string;
  stderr: string;
  /** Texto entre el needle y el RS de cierre (`rc|cwd` o `pid`). */
  payload: string;
}

interface CmdHit extends NeedleHit {
  rc: number;
  cwd: string;
}

interface PendingCmd {
  needle: string;
  re: RegExp;
  interpret: (payload: string, output: string, stderr: string) => void;
  reject: (err: Error) => void;
  settled: boolean;
  carry: string;
  parts: string[];
  stderrParts: string[];
  stderrBytes: number;
}

interface RawExec<T = NeedleHit> {
  promise: Promise<T>;
  interrupt: () => Promise<"none" | "int" | "term" | "kill">;
}

class SessionEndedError extends Error {
  constructor(reason: string) {
    super(`sesión bash terminada: ${reason}`);
    this.name = "SessionEndedError";
  }
}

export class BashSession {
  private proc: Subprocess<"pipe", "pipe", "pipe"> | null = null;
  private pid = 0;
  private spawnedAt = 0;
  private dead = true;
  private pending: PendingCmd | null = null;
  private spontaneous = "";
  private decoder = new TextDecoder();
  private queue: Promise<unknown> = Promise.resolve();
  private lastCwd = process.cwd();
  private bg = new Map<
    number,
    { command: string; log_file: string; label: string | null; started_at: number }
  >();
  private bgSeq = 0;
  private lastExitCode: number | null = null;
  private handshakeDone: Promise<void> | null = null;

  // ─────────────────────────────────────────────────── ciclo de vida ───────

  private spawn(): void {
    ensureAgentDirs();
    const proc = Bun.spawn({
      cmd: ["bash", "--noediting", "-i"], // sin readline: cero echo de input
      cwd: this.lastCwd,
      env: { ...process.env, TERM: "dumb", PROMPT_COMMAND: "" },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      detached: true, // pgid propio → group-kill sin tocar a otros procesos
    });
    this.proc = proc;
    this.pid = proc.pid ?? 0;
    this.spawnedAt = Date.now();
    this.dead = false;
    this.pending = null;
    this.spontaneous = "";

    void this.pump(proc.stdout, "out");
    void this.pump(proc.stderr, "err");
    proc.exited.then(
      (code) => this.onExit(code),
      () => this.onExit(null),
    );
    log.debug("bash spawned", { pid: this.pid, cwd: this.lastCwd });
  }

  private onExit(code: number | null): void {
    if (this.dead) return;
    this.dead = true;
    this.lastExitCode = typeof code === "number" ? code : null;
    const p = this.pending;
    this.pending = null;
    log.debug("bash exited", { pid: this.pid, code });
    if (p && !p.settled) {
      p.settled = true;
      p.reject(new SessionEndedError(`exit code=${code ?? "?"}`));
    }
    this.pid = 0;
  }

  private async pump(
    stream: ReadableStream<Uint8Array> | null,
    kind: "out" | "err",
  ): Promise<void> {
    if (!stream) return;
    const reader = stream.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;
        const text = this.decoder.decode(value, { stream: true });
        if (kind === "err") this.onStderr(text);
        else this.onStdout(text);
      }
    } catch {
      /* stream cerrado */
    }
  }

  private onStdout(text: string): void {
    const p = this.pending;
    if (!p || p.settled) {
      if (text) this.spontaneous = (this.spontaneous + text).slice(-65_536);
      return;
    }
    p.carry += text;
    const m = p.re.exec(p.carry);
    if (m && m.index !== undefined) {
      const output = p.carry.slice(0, m.index);
      const after = p.carry.slice(m.index + m[0].length);
      p.parts.push(output);
      const full = p.parts.join("");
      p.settled = true;
      this.pending = null;
      const payload = m[1] ?? "";
      // stderr puede seguir drenando unos ms tras el sentinel
      setTimeout(() => p.interpret(payload, full, p.stderrParts.join("")), 60);
      if (after) this.spontaneous = (this.spontaneous + after).slice(-65_536);
      return;
    }
    if (p.carry.length > 131_072) {
      p.parts.push(p.carry.slice(0, p.carry.length - 8_192));
      p.carry = p.carry.slice(-8_192);
    }
  }

  private onStderr(text: string): void {
    const p = this.pending;
    if (!p || p.settled) {
      if (text) this.spontaneous = (this.spontaneous + text).slice(-65_536);
      return;
    }
    p.stderrBytes += text.length;
    if (p.stderrBytes <= 262_144) p.stderrParts.push(text);
  }

  /** Handshake: silencia prompt/historial, repara señales y define utilidades. */
  private async handshake(): Promise<void> {
    const setup = [
      "set +m",
      "PS1=''",
      "PS2=''",
      "unset PROMPT_COMMAND",
      "HISTFILE=/dev/null",
      "set +o history",
      // Restaura señales: sin esto los hijos heredan disposiciones ignoradas.
      "trap - INT QUIT TERM HUP",
      // `exit` protegido: en subshell hace exit real (conservera `exit N` del
      // usuario); al top-level captura el código sin destruir la sesión.
      `exit() { local c="\${1:-0}"; case "$c" in ''|*[!0-9]*) c=1;; esac; if [ "\$BASHPID" != "\$\$" ]; then builtin exit "$c"; else return "$c"; fi; }`,
      // Árbol de procesos para kill_bg (recursivo, no mata la sesión):
      `kill_tree() { local p="$1" sig="\${2:-TERM}" c; for c in $(pgrep -P "$p" 2>/dev/null); do kill_tree "$c" "$sig"; done; kill -s "$sig" "$p" 2>/dev/null || true; }`,
      "export OPENCARLS_SESSION=1",
      "true",
    ].join("; ");
    const { promise } = this.execRaw(setup, { timeoutMs: 10_000 });
    const hit: CmdHit = await promise;
    const stderr = hit.stderr.trim();
    if (stderr && !/cannot set terminal|no job control/i.test(stderr)) {
      log.debug("handshake stderr", { stderr: stderr.slice(0, 300) });
    }
    log.debug("handshake ok", { pid: this.pid });
  }

  private ensureAlive(): Promise<void> {
    if (!this.dead && this.proc && this.handshakeDone) return this.handshakeDone;
    this.spawn();
    this.handshakeDone = this.handshake().catch((e) => {
      this.handshakeDone = null;
      this.onExit(-1);
      throw e;
    });
    return this.handshakeDone;
  }

  // ────────────────────────────────────────────────────── ejecución ───────

  /** ¿El comando usa la palabra `exit`? → modo subshell con reconciliación. */
  private needsExitGuard(command: string): boolean {
    return /(^|[^A-Za-z0-9_])exit([^A-Za-z0-9_]|$)/.test(command);
  }

  private execRaw(
    command: string,
    opts: {
      timeoutMs: number;
      cwd?: string | undefined;
      env?: Record<string, string> | undefined;
      stdinData?: string | undefined;
      stdinMode?: "null" | "inherit" | undefined;
    },
  ): RawExec<CmdHit> {
    const n = nonce();
    const needle = `${RS}OC|${n}|`;
    const printf = `printf '\\036OC|${n}|%d|%s\\036\\n' "$__oc_rc" "$PWD"`;

    const segments: string[] = [];
    if (opts.env) {
      for (const [k, v] of Object.entries(opts.env)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
          return {
            promise: Promise.reject(new Error(`nombre de variable inválido: ${k}`)),
            interrupt: async () => "none" as const,
          };
        }
        segments.push(`export ${k}=${quote(v)}`);
      }
    }
    segments.push(`__oc_rc=0`);
    if (opts.cwd) {
      segments.push(`if ! cd -- ${quote(opts.cwd)}; then __oc_rc=$?; fi`);
      segments.push(
        `if [ "$__oc_rc" -ne 0 ]; then echo ${quote(`opencarls: cd falló: ${opts.cwd}`)} >&2; fi`,
      );
    }

    const redir =
      opts.stdinData !== undefined
        ? ` <<'OC_STDIN_${n}'`
        : (opts.stdinMode ?? "null") === "null"
          ? " </dev/null"
          : "";

    if (this.needsExitGuard(command)) {
      // Subshell + EXIT-trap: `exit N` sale del subshell con rc correcto;
      // reconciliación de PWD y exports hacia la sesión padre.
      const rec = `/tmp/.oc_rec_${n}`;
      segments.push(
        `if [ "$__oc_rc" -eq 0 ]; then ` +
          `( trap '__oc_trc=$?; printf "%s\\n" "$PWD" > "${rec}.pwd"; export -p > "${rec}.env"; compgen -e | sort > "${rec}.names"; exit "$__oc_trc"' EXIT; ` +
          `eval ${quote(command)}${redir} ); __oc_rc=$?; fi`,
      );
      segments.push(
        `if [ -f "${rec}.pwd" ]; then __oc_pw=$(head -n1 "${rec}.pwd"); case "$__oc_pw" in /*) if [ "$__oc_pw" != "$PWD" ]; then cd -- "$__oc_pw" 2>/dev/null || true; fi;; esac; fi`,
      );
      segments.push(
        `if [ -f "${rec}.env" ]; then source "${rec}.env" 2>/dev/null || true; ` +
          `__oc_par=$(mktemp); compgen -e | sort > "$__oc_par"; ` +
          `while IFS= read -r __oc_v; do ` +
          `[ -n "$__oc_v" ] && [ "\${__oc_v#_}" = "$__oc_v" ] && unset "$__oc_v" 2>/dev/null; ` +
          `done < <(comm -23 "$__oc_par" "${rec}.names" 2>/dev/null); ` +
          `rm -f "$__oc_par"; fi`,
      );
      segments.push(`rm -f "${rec}.pwd" "${rec}.env" "${rec}.names"`);
    } else {
      segments.push(
        `if [ "$__oc_rc" -eq 0 ]; then eval ${quote(command)}${redir}; __oc_rc=$?; fi`,
      );
    }
    segments.push(printf);

    let line = segments.join("; ") + "\n";
    if (opts.stdinData !== undefined) {
      line += `${opts.stdinData}\nOC_STDIN_${n}\n`;
    }

    const raw = this.writeAndWait(needle, line);
    const promise: Promise<CmdHit> = raw.promise.then((hit) => {
      const sep = hit.payload.indexOf("|");
      const rc = sep >= 0 ? Number(hit.payload.slice(0, sep)) : -1;
      const cwd = sep >= 0 ? hit.payload.slice(sep + 1) : this.lastCwd;
      if (cwd) this.lastCwd = cwd;
      return { ...hit, rc, cwd };
    });
    return { promise, interrupt: raw.interrupt };
  }

  private writeAndWait(needle: string, line: string): RawExec {
    let resolveFn!: (h: NeedleHit) => void;
    let rejectFn!: (e: Error) => void;
    const promise = new Promise<NeedleHit>((res, rej) => {
      resolveFn = res;
      rejectFn = rej;
    });

    const pending: PendingCmd = {
      needle,
      re: new RegExp(escapeRegExp(needle) + "([^\\x1e]*)\\x1e"),
      interpret: (payload, output, stderr) => resolveFn({ output, stderr, payload }),
      reject: rejectFn,
      settled: false,
      carry: this.spontaneous,
      parts: [],
      stderrParts: [],
      stderrBytes: 0,
    };
    this.spontaneous = "";
    this.pending = pending;

    const sink = this.proc?.stdin;
    if (!sink) {
      this.pending = null;
      pending.settled = true;
      rejectFn(new SessionEndedError("stdin cerrado"));
      return { promise, interrupt: async () => "none" as const };
    }
    try {
      sink.write(line);
      sink.flush();
    } catch (e) {
      this.pending = null;
      pending.settled = true;
      rejectFn(e instanceof Error ? e : new Error(String(e)));
      return { promise, interrupt: async () => "none" as const };
    }

    const pid = this.pid;
    const done = () => pending.settled || this.pending !== pending;

    /**
     * Escalada de interrupción QUIETA: primero los hijos (bash nunca recibe
     * señal → no aborta la línea → llega el sentinel con rc=130/143 y la
     * sesión sobrevive). Solo en falla total se mata la sesión.
     */
    const interrupt = async (): Promise<"none" | "int" | "term" | "kill"> => {
      if (done()) return "none";

      // 1) SIGINT al árbol de hijos (bash intacto)
      killTreeOs(listChildPids(pid), "SIGINT");
      for (let i = 0; i < 15 && !done(); i++) await Bun.sleep(100);
      if (done()) return "int";

      // 2) SIGTERM al árbol de hijos
      killTreeOs(listChildPids(pid), "SIGTERM");
      for (let i = 0; i < 8 && !done(); i++) await Bun.sleep(100);
      if (done()) return "term";

      // 3) SIGTERM a bash (la sesión morirá → graceful + respawn)
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* murió */
      }
      for (let i = 0; i < 5 && !done(); i++) await Bun.sleep(100);
      if (done()) return "term";

      // 4) Último recurso: kill del grupo completo
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        /* murió */
      }
      for (let i = 0; i < 5 && !done(); i++) await Bun.sleep(100);
      return "kill";
    };

    return { promise, interrupt };
  }

  private async execInner(
    command: string,
    opts: {
      timeout_ms?: number;
      cwd?: string;
      env?: Record<string, string>;
      stdin_data?: string;
      stdin_mode?: "null" | "inherit";
      max_output_bytes?: number;
    },
  ): Promise<{
    stdout: string;
    stderr: string;
    exit_code: number;
    cwd: string;
    timed_out: boolean;
    killed_session: boolean;
    truncated: boolean;
    duration_ms: number;
    pid: number;
  }> {
    const started = performance.now();
    await this.ensureAlive();
    if (this.dead || !this.proc) throw new SessionEndedError("no se pudo (re)abrir la sesión");

    const timeout = opts.timeout_ms ?? CONFIG.telemetry.bash_default_timeout_ms;
    const maxOut = opts.max_output_bytes ?? CONFIG.telemetry.bash_capture_limit_bytes;

    const { promise, interrupt } = this.execRaw(command, {
      timeoutMs: timeout,
      cwd: opts.cwd,
      env: opts.env,
      stdinData: opts.stdin_data,
      stdinMode: opts.stdin_mode,
    });

    let timedOut = false;
    let killedSession = false;

    const timer = setTimeout(() => {
      timedOut = true;
      void interrupt().then((l) => {
        if (l === "kill") killedSession = true;
      });
    }, timeout);

    let payloadRc = -1;
    let payloadCwd = this.lastCwd;
    let outText = "";
    let errText = "";

    try {
      const hit = await promise;
      outText = hit.output;
      errText = hit.stderr;
      payloadRc = hit.rc;
      payloadCwd = hit.cwd;
    } catch (e) {
      clearTimeout(timer);
      if (e instanceof SessionEndedError && timedOut) {
        return {
          stdout: "",
          stderr: `${e.message} (timeout ${timeout}ms con escalada kill)`,
          exit_code: -1,
          cwd: this.lastCwd,
          timed_out: true,
          killed_session: true,
          truncated: false,
          duration_ms: Math.round(performance.now() - started),
          pid: this.pid,
        };
      }
      if (e instanceof SessionEndedError) {
        // Muerte real del shell (exec, kill $$…): graceful + respawn automático
        // en la próxima llamada (ensureAlive re-spawnea con lastCwd).
        return {
          stdout: "",
          stderr: `${e.message}${this.lastExitCode !== null ? ` [exit code=${this.lastExitCode}]` : ""}`,
          exit_code: this.lastExitCode ?? -1,
          cwd: this.lastCwd,
          timed_out: false,
          killed_session: true,
          truncated: false,
          duration_ms: Math.round(performance.now() - started),
          pid: 0,
        };
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }

    if (killedSession) await Bun.sleep(150);

    const capOut = capString(outText, maxOut);
    const capErr = capString(stripShellNoise(errText), Math.min(maxOut, 262_144));
    return {
      stdout: capOut.text,
      stderr: capErr.text,
      exit_code: timedOut && payloadRc === 0 ? -1 : payloadRc,
      cwd: payloadCwd,
      timed_out: timedOut,
      killed_session: killedSession,
      truncated: capOut.truncated || capErr.truncated,
      duration_ms: Math.round(performance.now() - started),
      pid: this.pid,
    };
  }

  // ───────────────────────────────────────────── API pública (mutex) ───────

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  exec(
    command: string,
    opts: {
      timeout_ms?: number;
      cwd?: string;
      env?: Record<string, string>;
      stdin_data?: string;
      stdin_mode?: "null" | "inherit";
      max_output_bytes?: number;
    } = {},
  ): Promise<Awaited<ReturnType<BashSession["execInner"]>>> {
    return this.exclusive(() => this.execInner(command, opts));
  }

  startBackground(input: {
    command: string;
    log_file?: string;
    cwd?: string;
    env?: Record<string, string>;
    label?: string;
  }): Promise<{ pid: number; log_file: string; command: string; label: string | null }> {
    return this.exclusive(async () => {
      ensureAgentDirs();
      const seq = ++this.bgSeq;
      const logFile =
        input.log_file ?? `${CONFIG.logs_dir}/bg-${seq}-${Date.now().toString(36)}.log`;
      const n = nonce();
      const needle = `${RS}OCBG|${n}|`;
      const printf = `printf '\\036OCBG|${n}|%d\\036\\n' "$__oc_bg_pid"`;

      const segments: string[] = [];
      if (input.env) {
        for (const [k, v] of Object.entries(input.env)) {
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`variable inválida: ${k}`);
          segments.push(`export ${k}=${quote(v)}`);
        }
      }
      segments.push(`__oc_rc=0`);
      if (input.cwd) segments.push(`if ! cd -- ${quote(input.cwd)}; then __oc_rc=$?; fi`);
      segments.push(
        `if [ "$__oc_rc" -eq 0 ]; then eval ${quote(input.command)} >> ${quote(logFile)} 2>&1 </dev/null & __oc_bg_pid=$!; else __oc_bg_pid=0; fi`,
      );
      segments.push(printf);
      const line = segments.join("; ") + "\n";

      await this.ensureAlive();
      if (this.dead || !this.proc) throw new SessionEndedError("sesión no viva");

      const { promise, interrupt } = this.writeAndWait(needle, line);
      const launchTimeout = Bun.sleep(10_000).then(() => "timeout" as const);
      const outcome = await Promise.race([promise.then((h) => h.payload), launchTimeout]);
      if (outcome === "timeout") {
        await interrupt();
        throw new Error(`timeout lanzando background: ${input.command.slice(0, 120)}`);
      }

      let bgPid = Number(outcome) || 0;
      if (!bgPid) {
        const r = await this.execInner("jobs -p | tail -1", { timeout_ms: 3_000 });
        bgPid = Number(r.stdout.trim().split(/\s+/)[0]) || 0;
      }
      if (!bgPid) throw new Error("no se obtuvo PID del proceso background");

      this.bg.set(bgPid, {
        command: input.command,
        log_file: logFile,
        label: input.label ?? null,
        started_at: Date.now(),
      });
      return { pid: bgPid, log_file: logFile, command: input.command, label: input.label ?? null };
    });
  }

  listBackground() {
    return this.exclusive(async () => {
      const out: Array<{
        pid: number;
        alive: boolean;
        command: string;
        log_file: string;
        label: string | null;
        started_at: number;
        uptime_ms: number;
      }> = [];
      for (const [pid, meta] of this.bg) {
        let alive = false;
        try {
          process.kill(pid, 0);
          alive = true;
        } catch {
          alive = false;
        }
        out.push({
          pid,
          alive,
          command: meta.command,
          log_file: meta.log_file,
          label: meta.label,
          started_at: meta.started_at,
          uptime_ms: alive ? Date.now() - meta.started_at : 0,
        });
      }
      return { processes: out, session_pid: this.pid, session_alive: !this.dead };
    });
  }

  killBackground(pid: number, signal: "TERM" | "KILL" | "INT" | "HUP" = "TERM") {
    return this.exclusive(async () => {
      if (!this.dead) {
        const r = await this.execInner(`kill_tree ${pid} ${signal}; true`, { timeout_ms: 5_000 });
        if (r.exit_code === 0) {
          if (signal === "KILL" || signal === "TERM") this.bg.delete(pid);
          return { pid, signal, killed: true, via: "session" };
        }
      }
      try {
        killTreeOs([pid], `SIG${signal}` as NodeJS.Signals);
        if (signal === "KILL" || signal === "TERM") this.bg.delete(pid);
        return { pid, signal, killed: true, via: "os" };
      } catch (e) {
        return { pid, signal, killed: false, error: String(e) };
      }
    });
  }

  sendStdin(data: string) {
    return this.exclusive(async () => {
      if (this.dead || !this.proc?.stdin) throw new SessionEndedError("sesión no viva");
      this.proc.stdin.write(data);
      this.proc.stdin.flush();
      return { bytes: new TextEncoder().encode(data).length };
    });
  }

  state() {
    return this.exclusive(async () => ({
      pid: this.pid,
      alive: !this.dead,
      cwd: this.lastCwd,
      uptime_ms: this.dead ? 0 : Date.now() - this.spawnedAt,
      bg_count: this.bg.size,
      pending_cmd: this.pending !== null,
    }));
  }

  reset(reason?: string) {
    return this.exclusive(async () => {
      const oldPid = this.pid;
      if (this.proc && !this.dead) {
        try {
          process.kill(-oldPid, "SIGTERM");
        } catch {
          /* noop */
        }
        try {
          this.proc.kill();
        } catch {
          /* noop */
        }
        await Bun.sleep(200);
      }
      this.dead = true;
      this.handshakeDone = null;
      this.spawn();
      await this.handshake();
      log.info("sesión bash reiniciada", { oldPid, newPid: this.pid, reason });
      return { old_pid: oldPid, new_pid: this.pid, cwd: this.lastCwd, reason: reason ?? null };
    });
  }

  tailLog(path: string, lines: number, followSeconds: number) {
    return this.exclusive(async () => {
      if (followSeconds > 0) {
        const r = await run(
          ["timeout", `${followSeconds + 1}s`, "tail", "-n", String(lines), "-f", "--", path],
          { timeout_ms: (followSeconds + 3) * 1000, max_bytes: 512 * 1024 },
        );
        return {
          path,
          lines,
          follow_seconds: followSeconds,
          output: r.stdout,
          stderr: r.stderr,
          timed_out: r.timed_out,
          truncated: r.truncated,
        };
      }
      const r = await run(["tail", "-n", String(lines), "--", path], {
        timeout_ms: 10_000,
        max_bytes: 512 * 1024,
      });
      return {
        path,
        lines,
        follow_seconds: 0,
        output: r.stdout,
        stderr: r.stderr,
        exit_code: r.exit_code,
        truncated: r.truncated,
      };
    });
  }

  shutdown(): void {
    if (this.proc && !this.dead) {
      try {
        process.kill(-this.pid, "SIGKILL");
      } catch {
        /* noop */
      }
    }
    this.dead = true;
  }
}

export const bashSession = new BashSession();

// ══════════════════════════════════════════════ ESQUEMA ZOD + TOOL ════════

const envSchema = z
  .record(z.string(), z.string())
  .refine((r) => Object.keys(r).every((k) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k)), {
    message: "todas las claves de env deben ser identificadores válidos",
  })
  .optional();

const execOp = z.object({
  op: z.literal("exec"),
  command: z.string().min(1, "command no puede estar vacío"),
  cwd: z.string().min(1).optional(),
  env: envSchema,
  stdin_data: z.string().max(1_000_000).optional(),
  stdin_mode: z
    .enum(["null", "inherit"])
    .default("null")
    .describe("'null' = el comando no roba la sesión (default); 'inherit' = interactivo vía send_stdin"),
  timeout_ms: z.number().int().min(100).max(3_600_000).default(60_000),
  max_output_bytes: z.number().int().min(1_024).max(8_388_608).default(512_144),
});

const bgOp = z.object({
  op: z.literal("bg"),
  command: z.string().min(1),
  log_file: z.string().min(1).optional(),
  cwd: z.string().min(1).optional(),
  env: envSchema,
  label: z.string().max(120).optional(),
});

const sendStdinOp = z.object({
  op: z.literal("send_stdin"),
  data: z.string().max(1_000_000),
});

const listBgOp = z.object({ op: z.literal("list_bg") });

const killBgOp = z.object({
  op: z.literal("kill_bg"),
  pid: z.number().int().positive(),
  signal: z.enum(["TERM", "KILL", "INT", "HUP"]).default("TERM"),
});

const tailLogOp = z.object({
  op: z.literal("tail_log"),
  path: z.string().min(1),
  lines: z.number().int().min(1).max(10_000).default(200),
  follow_seconds: z.number().int().min(0).max(300).default(0),
});

const stateOp = z.object({ op: z.literal("state") });

const resetOp = z.object({
  op: z.literal("reset"),
  reason: z.string().max(200).optional(),
});

export const bashSessionSchema = z.discriminatedUnion("op", [
  execOp,
  bgOp,
  sendStdinOp,
  listBgOp,
  killBgOp,
  tailLogOp,
  stateOp,
  resetOp,
]);

export type BashSessionInput = z.infer<typeof bashSessionSchema>;

export const bashSessionTool: ToolDefinition<typeof bashSessionSchema> = {
  name: "bash_session",
  phase: 1,
  description:
    "Sesión Bash persistente en Ubuntu (cwd y env acumulativos, sudo directo, " +
    "background con log, tail con follow, send_stdin interactivo, reset). " +
    "Ops: exec | bg | send_stdin | list_bg | kill_bg | tail_log | state | reset. " +
    "Timeout por comando: interrumpe el árbol de hijos sin matar la sesión. " +
    "Sin confirmaciones.",
  inputSchema: bashSessionSchema,
  async handler(input) {
    switch (input.op) {
      case "exec": {
        return bashSession.exec(input.command, {
          timeout_ms: input.timeout_ms,
          cwd: input.cwd,
          env: input.env,
          stdin_data: input.stdin_data,
          stdin_mode: input.stdin_mode,
          max_output_bytes: input.max_output_bytes,
        });
      }
      case "bg":
        return bashSession.startBackground(input);
      case "send_stdin":
        return bashSession.sendStdin(input.data);
      case "list_bg":
        return bashSession.listBackground();
      case "kill_bg":
        return bashSession.killBackground(input.pid, input.signal);
      case "tail_log":
        return bashSession.tailLog(input.path, input.lines, input.follow_seconds);
      case "state":
        return bashSession.state();
      case "reset":
        return bashSession.reset(input.reason);
      default: {
        const _exhaustive: never = input;
        return _exhaustive;
      }
    }
  },
};
