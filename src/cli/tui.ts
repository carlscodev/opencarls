/**
 * OpenCarls — TUI "Architectural Monolith".
 *
 * Minimalismo de lujo (fondo #09090B, paneles #18181B, texto #FAFAFA,
 * metadatos #71717A, bordes ╭─╮│╰─╯ #27272A, acentos #10B981/#F59E0B).
 *
 * - RollingThoughtBox de EXACTAMENTE 4 líneas: L0 indicador
 *   `⠋ Thinking... 4.2s`, L1–L3 razonamiento con fade-scroll
 *   rgb(82,82,91) → (113,113,122) → (161,161,170) → (228,228,231);
 *   colapsa a `✦ Thought for 12.4s · 380 tokens`.
 * - Tarjetas tool: `⚡ bash_session · <cmd> · 1.2s`
 * - Diffs con fondo verde/rojo oscuro (48;2;6;78;59 / 48;2;127;29;29)
 * - Status bar `[Provider/Model] · [Phase] · [Skills] · [Context %]`
 * - Render ANSI DIFERENTIAL (solo líneas cambiantes) — sin parpadeos.
 */
import { createInterface, type Interface } from "node:readline";
import { Agent, type AgentEvent } from "../core/agent";
import { runLockpack, type LockpackEvent } from "../core/lockpack-loop";
import { resolveProvider, defaultModel } from "../providers/router";
import { listSkills, listTodos, todoStats } from "../memory/db";
import { toolCatalogMarkdown } from "../tools/registry";

// ── Paleta ──────────────────────────────────────────────────────────────────

const C = {
  bg: [9, 9, 11] as const,
  panel: [24, 24, 27] as const,
  text: [250, 250, 250] as const,
  meta: [113, 113, 122] as const,
  border: [39, 39, 42] as const,
  green: [16, 185, 129] as const,
  amber: [245, 158, 11] as const,
  red: [248, 113, 113] as const,
};

type RGB = readonly [number, number, number];

function fg(c: RGB): string {
  return `\x1b[38;2;${c[0]};${c[1]};${c[2]}m`;
}
function bg(c: RGB): string {
  return `\x1b[48;2;${c[0]};${c[1]};${c[2]}m`;
}
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";

const FADE: RGB[] = [
  [82, 82, 91],
  [113, 113, 122],
  [161, 161, 170],
  [228, 228, 231],
];

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// ── Utilidades de ancho/ANSI ────────────────────────────────────────────────

export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

export function ansiWidth(s: string): number {
  const plain = stripAnsi(s);
  let w = 0;
  for (const ch of plain) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp === 0x200b || (cp >= 0x0300 && cp <= 0x036f)) continue;
    const wide =
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1f9ff) ||
      (cp >= 0x2600 && cp <= 0x27bf);
    w += wide ? 2 : 1;
  }
  return w;
}

export function padLine(s: string, width: number): string {
  const w = ansiWidth(s);
  if (w >= width) return s;
  return s + " ".repeat(width - w);
}

function truncateDisplay(s: string, max: number): string {
  let out = "";
  let w = 0;
  for (const ch of s) {
    const cw = ansiWidth(ch);
    if (w + cw > max - 1) {
      out += "…";
      break;
    }
    out += ch;
    w += cw;
  }
  return out;
}

function borderBox(title: string, width: number, lineCount: number): string[] {
  const b = fg(C.border as unknown as RGB);
  const t = title ? ` ${fg(C.meta as unknown as RGB)}${title}${RESET}${b}` : "";
  const top = `${b}╭─${t}${"─".repeat(Math.max(width - 4 - t.length, 0))}╮${RESET}`;
  const lines: string[] = [top];
  for (let i = 1; i < lineCount - 1; i++) lines.push(`${b}│${RESET}`);
  lines.push(`${b}╰${"─".repeat(Math.max(width - 2, 0))}╯${RESET}`);
  return lines;
}

// ── RollingThoughtBox (exactamente 4 líneas) ───────────────────────────────

export class RollingThoughtBox {
  /** L0 indicador · L1–L3 razonamiento (fade por edad: 82→113→161→228). */
  private ring: string[] = [];
  private thinking = false;
  private startedAt = 0;
  private tokens = 0;
  private spin = 0;
  private collapsed = false;
  readonly height = 4;

  start(): void {
    this.thinking = true;
    this.collapsed = false;
    this.startedAt = Date.now();
    this.ring = [];
    this.tokens = 0;
  }

  push(line: string): void {
    const clean = line.replace(/\s+/g, " ").trim();
    if (!clean) return;
    this.tokens += Math.ceil(clean.length / 4);
    const lines = expandWrap(clean, 120);
    for (const l of lines) {
      this.ring.push(l);
      if (this.ring.length > 64) this.ring.shift();
    }
    this.collapsed = false;
  }

  tickSpinner(): void {
    this.spin = (this.spin + 1) % SPINNER.length;
  }

  get elapsed(): number {
    return this.startedAt ? (Date.now() - this.startedAt) / 1000 : 0;
  }

  stop(): void {
    if (!this.thinking) return;
    this.thinking = false;
    this.collapsed = true;
  }

  /** Colapsa a `✦ Thought for 12.4s · 380 tokens` (4ª línea estable). */
  render(width: number): string[] {
    const inner = width - 4;
    const elapsedStr = `${this.elapsed.toFixed(1)}s`;
    const lines: string[] = [];

    if (this.collapsed || !this.thinking) {
      const msg = `✦ ${fg(C.green as unknown as RGB)}Thought for ${elapsedStr}${RESET} ${fg(C.meta as unknown as RGB)}· ${this.tokens} tokens${RESET}`;
      // 4 líneas exactas: 1 colapsada + 3 últimas en fade persistente
      lines.push(padLine(" " + msg, width));
      const last3 = this.ring.slice(-3);
      const startAge = 4 - last3.length; // rota colores por edad
      last3.forEach((l, i) => {
        const age = startAge + i; // 0 = más nuevo
        const color = FADE[Math.min(3, Math.max(0, 3 - age))] ?? FADE[0];
        lines.push(padLine(` ${fg(color as unknown as RGB)}${truncateDisplay(l, inner)}${RESET}`, width));
      });
      while (lines.length < 4) lines.push(padLine(" " + fg(C.border as unknown as RGB) + "·" + RESET, width));
      return lines.slice(0, 4);
    }

    // L0: indicador con spinner + tiempo (+ texto más reciente en color nuevo)
    const spinC = `${fg(C.green as unknown as RGB)}${SPINNER[this.spin]!}${RESET}`;
    const indicator = `${spinC} ${fg(C.text as unknown as RGB)}${BOLD}Thinking...${RESET} ${fg(C.meta as unknown as RGB)}${elapsedStr}${RESET}`;
    const newest = this.ring.length ? truncateDisplay(this.ring[this.ring.length - 1]!, Math.max(inner - 30, 10)) : "";
    lines.push(padLine(` ${indicator} ${fg(FADE[3] as unknown as RGB)}${newest}${RESET}`, width));

    // L1–L3: últimas 3 líneas previas con fade por edad (228 → 161 → 113 → 82)
    const prev = this.ring.slice(0, -1).slice(-3);
    const ages = [3, 2, 1]; // de arriba( vieja ) a abajo( nueva )
    const gap = 3 - prev.length;
    for (let i = 0; i < 3; i++) {
      const text = prev[i - gap];
      const age = ages[i]!;
      const color = FADE[Math.min(3, Math.max(0, 3 - age))] ?? FADE[0];
      if (text === undefined) {
        lines.push(padLine(` ${fg(C.border as unknown as RGB)}${i === 0 ? "╭" : "│"}${RESET}`, width));
      } else {
        lines.push(padLine(` ${fg(color as unknown as RGB)}${truncateDisplay(text, inner)}${RESET}`, width));
      }
    }
    return lines.slice(0, 4);
  }
}

function expandWrap(s: string, width: number): string[] {
  if (s.length <= width) return [s];
  const out: string[] = [];
  for (let i = 0; i < s.length; i += width) out.push(s.slice(i, i + width));
  return out;
}

// ── Log + tarjetas ──────────────────────────────────────────────────────────

type LogKind = "text" | "tool" | "phase" | "error" | "diff" | "info" | "sys";

interface LogLine {
  kind: LogKind;
  text: string;
}

function toolCard(name: string, input: unknown, ms: number, ok: boolean): string {
  const cmd =
    typeof input === "object" && input
      ? String(
          (input as Record<string, unknown>).command ??
            (input as Record<string, unknown>).command ??
            JSON.stringify(input).slice(0, 60),
        ).replace(/\s+/g, " ")
      : String(input ?? "");
  const mark = ok ? `${fg(C.green as unknown as RGB)}⚡${RESET}` : `${fg(C.red as unknown as RGB)}✖${RESET}`;
  return `${mark} ${fg(C.text as unknown as RGB)}${BOLD}${name}${RESET} ${fg(C.meta as unknown as RGB)}· ${truncateDisplay(cmd, 52)} · ${(ms / 1000).toFixed(1)}s${RESET}`;
}

function diffLines(diff: string): LogLine[] {
  return diff
    .split("\n")
    .filter(Boolean)
    .slice(0, 60)
    .map((l) => {
      if (l.startsWith("+++") || l.startsWith("---")) return { kind: "phase" as LogKind, text: l };
      if (l.startsWith("+")) return { kind: "diff" as LogKind, text: `+${l.slice(1)}` };
      if (l.startsWith("-")) return { kind: "diff" as LogKind, text: `-${l.slice(1)}` };
      return { kind: "info" as LogKind, text: l };
    });
}

// ── Renderer diferencial ────────────────────────────────────────────────────

class Differ {
  private prev: string[] = [];
  private rows = 0;
  private cols = 0;

  begin(): void {
    this.rows = process.stdout.rows ?? 30;
    this.cols = process.stdout.columns ?? 110;
  }

  present(lines: string[]): void {
    const out: string[] = [];
    const n = Math.min(lines.length, this.rows);
    for (let i = 0; i < n; i++) {
      const next = padLine(lines[i] ?? "", this.cols);
      if (this.prev[i] === next) continue;
      // solo la línea cambiada → sin parpadeo
      out.push(`\x1b[${i + 1};1H\x1b[2K${next}`);
    }
    if (out.length) process.stdout.write(out.join(""));
    // limpiar sobrantes
    for (let i = n; i < this.prev.length && i < this.rows; i++) {
      if (this.prev[i] !== undefined) process.stdout.write(`\x1b[${i + 1};1H\x1b[2K`);
    }
    this.prev = lines.slice(0, this.rows);
  }

  reset(): void {
    this.prev = [];
  }
}

// ── Comandos slash ──────────────────────────────────────────────────────────

type SlashCmd = { desc: string; run: (arg: string, ui: Tui) => void | Promise<void> };

const SLASH: Record<string, SlashCmd> = {
  help: {
    desc: "muestra esta ayuda",
    run: (_a, ui) => {
      for (const [k, v] of Object.entries(SLASH)) ui.push("sys", `/${k} — ${v.desc}`);
      ui.push("sys", "cualquier otro texto = nueva tarea para el agente");
    },
  },
  lockpack: {
    desc: "lockpack <dir> — ciclo perpetuo (execute→audit→critique→skill)",
    run: async (arg, ui) => {
      const [dir, ...rest] = arg.trim().split(/\s+/);
      if (!dir) {
        ui.push("error", "uso: /lockpack <dir> [tarea]");
        return;
      }
      const task =
        rest.join(" ") ||
        "Construye una landing/mini-app moderna y pulida (minimalismo de lujo), verifica todo y déjala lista.";
      await ui.runLockpack(dir, task);
    },
  },
  todos: { desc: "lista el tablero de tareas", run: (_a, ui) => ui.renderTodos() },
  skills: { desc: "lista skills registradas", run: (_a, ui) => ui.renderSkills() },
  tools: { desc: "catálogo de herramientas", run: (_a, ui) => {
    for (const l of toolCatalogMarkdown().split("\n")) ui.push("sys", l);
  } },
  clear: { desc: "limpia el log", run: (_a, ui) => ui.clearLog() },
  quit: { desc: "sale de la TUI", run: (_a, ui) => ui.quit() },
};

// ── TUI ─────────────────────────────────────────────────────────────────────

export class Tui {
  private differ = new Differ();
  private thought = new RollingThoughtBox();
  private log: LogLine[] = [];
  private input = "";
  private cursor = 0;
  private rl: Interface | null = null;
  private phase = "idle";
  private provider = "…";
  private model = "…";
  private contextPct = 0;
  private busy = false;
  private shouldQuit = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private extraLines: string[] = [];
  private pendingDiff: string | null = null;

  constructor() {
    try {
      const cfg = resolveProvider();
      this.provider = cfg.id;
      try {
        this.model = defaultModel(cfg);
      } catch {
        this.model = "—";
      }
    } catch {
      /* sin config */
    }
  }

  push(kind: LogKind, text: string): void {
    for (const l of text.split("\n")) this.log.push({ kind, text: l });
    if (this.log.length > 400) this.log.splice(0, this.log.length - 400);
  }

  clearLog(): void {
    this.log = [];
  }

  renderTodos(): void {
    const stats = todoStats();
    this.push("sys", `todos: ${stats.open} abiertas · ${stats.in_progress} en curso · ${stats.done} hechas`);
    for (const t of listTodos("all", 15)) {
      this.push("sys", `#${t.id} [${t.status}] ${t.title}`);
    }
  }

  renderSkills(): void {
    const rows = listSkills(undefined, 20);
    this.push("sys", `skills: ${rows.length}`);
    for (const s of rows) this.push("sys", `- ${s.slug} v${s.version} [${s.status}] ok=${s.success_count} fail=${s.fail_count}`);
  }

  async start(): Promise<void> {
    process.stdout.write("\x1b[?1049h\x1b[?25l\x1b[2J");
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");

    process.stdin.on("data", (k: string) => this.onKey(k));
    process.stdout.on("resize", () => {
      this.differ.reset();
      process.stdout.write("\x1b[2J");
      this.draw();
    });

    this.push("sys", "OpenCarls TUI — escribe una tarea o /help");
    this.push("info", `proveedor ${this.provider}/${this.model}`);

    this.timer = setInterval(() => {
      this.thought.tickSpinner();
      this.draw();
    }, 120);

    this.draw();
  }

  quit(): void {
    this.shouldQuit = true;
  }

  private onKey(k: string): void {
    if (k === "\u0003" || k === "\u0004") {
      this.shutdown(0);
      return;
    }
    if (k === "\r" || k === "\n") {
      const cmd = this.input;
      this.input = "";
      this.cursor = 0;
      void this.submit(cmd);
      return;
    }
    if (k === "\u007f" || k === "\b") {
      if (this.cursor > 0) {
        this.input = this.input.slice(0, this.cursor - 1) + this.input.slice(this.cursor);
        this.cursor--;
      }
      this.draw();
      return;
    }
    if (k === "\x1b[D") {
      this.cursor = Math.max(0, this.cursor - 1);
      this.draw();
      return;
    }
    if (k === "\x1b[C") {
      this.cursor = Math.min(this.input.length, this.cursor + 1);
      this.draw();
      return;
    }
    if (k === "\x1b[A" || k === "\x1b[B") {
      // histórico simple
      return;
    }
    if (k.startsWith("\x1b")) return;
    if (k.length >= 1) {
      this.input = this.input.slice(0, this.cursor) + k + this.input.slice(this.cursor);
      this.cursor += k.length;
      this.draw();
    }
  }

  private async submit(raw: string): Promise<void> {
    const text = raw.trim();
    if (!text) return;
    if (text.startsWith("/")) {
      const [cmd, ...rest] = text.slice(1).split(/\s+/);
      const def = SLASH[cmd!];
      if (def) {
        await def.run(rest.join(" "), this);
      } else {
        this.push("error", `comando desconocido: /${cmd} (prueba /help)`);
      }
      this.draw();
      return;
    }
    if (this.busy) {
      this.push("error", "ya hay un run en curso — espera a que termine");
      this.draw();
      return;
    }
    await this.runAgent(text);
  }

  private agentEvents(aev: AgentEvent): void {
    switch (aev.type) {
      case "reasoning": {
        const tail = aev.text.split("\n").filter(Boolean);
        for (const l of tail) this.thought.push(l);
        break;
      }
      case "text":
        this.pendingDiff = (this.pendingDiff ?? "") + aev.text;
        break;
      case "tool_start":
        this.thought.stop();
        break;
      case "tool_end": {
        this.thought.stop();
        const card = toolCard(aev.name, null, aev.duration_ms, aev.ok);
        this.push("tool", card);
        if (!aev.ok) this.push("error", `  ${aev.preview.slice(0, 200)}`);
        if (aev.name === "multi_patch" && aev.preview.includes('"diff"')) {
          try {
            const d = JSON.parse(aev.preview) as { diff?: string };
            if (d.diff) for (const l of diffLines(d.diff)) this.log.push(l);
          } catch {
            /* preview truncado */
          }
        }
        break;
      }
      case "compact":
        this.push("sys", `contexto compactado ${aev.tokens_before}→${aev.tokens_after} tokens (${aev.mode})`);
        break;
      case "usage": {
        const budget = 60_000;
        this.contextPct = Math.min(99, Math.round(((aev.input_tokens + aev.output_tokens) / budget) * 100));
        break;
      }
      case "error":
        this.thought.stop();
        this.push("error", aev.error);
        break;
      case "done":
        this.thought.stop();
        if (this.pendingDiff?.trim()) {
          const t = this.pendingDiff.trim();
          this.push("text", truncateDisplay(t.replace(/\s+/g, " "), 400));
        }
        this.pendingDiff = null;
        this.push("info", `✓ done · iter=${aev.iterations} · tools=${aev.tool_calls} · ${(aev.duration_ms / 1000).toFixed(1)}s`);
        break;
      case "phase":
        this.phase = aev.phase;
        break;
      default:
        break;
    }
  }

  async runAgent(task: string): Promise<void> {
    this.busy = true;
    this.phase = "execute";
    this.push("text", `${fg(C.amber as unknown as RGB)}▸ ${task}${RESET}`);
    this.thought.start();
    const agent = new Agent({
      max_iterations: 30,
      onEvent: (ev) => this.agentEvents(ev),
    });
    try {
      const res = await agent.run(task);
      this.contextPct = Math.min(99, Math.round((agent.contextTokens / 60_000) * 100));
      if (res.stopped === "error") this.push("error", res.error ?? "error desconocido");
    } catch (e) {
      this.push("error", e instanceof Error ? e.message : String(e));
    } finally {
      this.thought.stop();
      this.phase = "idle";
      this.busy = false;
      this.draw();
    }
  }

  async runLockpack(dir: string, task: string): Promise<void> {
    if (this.busy) {
      this.push("error", "ya hay un run en curso");
      return;
    }
    this.busy = true;
    this.push("sys", `LOCKPACK → ${dir}`);
    this.thought.start();
    try {
      const report = await runLockpack({
        task,
        target_dir: dir,
        onEvent: (ev: LockpackEvent) => {
          if (ev.type === "phase") {
            this.phase = ev.phase ?? "lockpack";
            if (ev.message) this.push("phase", `${fg(C.green as unknown as RGB)}◆${RESET} ${ev.message}`);
          } else if (ev.type === "agent" && ev.agent) {
            this.agentEvents(ev.agent);
          } else if (ev.type === "log" && ev.message) {
            this.push("info", ev.message);
          } else if (ev.type === "done") {
            const d = ev.data as { accepted?: boolean; cycles?: number; stop_reason?: string } | undefined;
            this.push(
              d?.accepted ? "info" : "error",
              `LOCKPACK ${d?.accepted ? "✓ aceptado" : "■ fin"} · ciclos=${d?.cycles} · ${d?.stop_reason}`,
            );
          }
        },
      });
      for (const c of report.cycles) {
        this.push(
          "phase",
          `ciclo ${c.cycle}: audit=${c.audit.clean ? "clean" : `${c.audit.count}err`} · crítica=${c.critique.score.toFixed(1)} · skill=${c.distillation.skill ?? "-"}`,
        );
      }
    } catch (e) {
      this.push("error", e instanceof Error ? e.message : String(e));
    } finally {
      this.thought.stop();
      this.phase = "idle";
      this.busy = false;
      this.draw();
    }
  }

  // ── Pintado ──

  private draw(): void {
    if (this.shouldQuit) {
      this.shutdown(0);
      return;
    }
    this.differ.begin();
    const W = process.stdout.columns ?? 110;
    const H = process.stdout.rows ?? 30;
    const lines: string[] = [];

    // Header (2)
    const title = ` ${fg(C.green as unknown as RGB)}${BOLD}OpenCarls${RESET}${fg(C.meta as unknown as RGB)} monolith${RESET}`;
    lines.push(padLine(title + fg(C.border as unknown as RGB) + " " + "─".repeat(Math.max(W - ansiWidth(stripAnsi(title)) - 2, 0)) + RESET, W));
    lines.push(padLine(` ${fg(C.meta as unknown as RGB)}${this.busy ? "▸ run activo" : "· en espera"} · sesión viva · /help${RESET}`, W));

    // RollingThoughtBox (4)
    for (const l of this.thought.render(W)) lines.push(l);

    // Log scroll
    const inputRows = 3;
    const statusRows = 1;
    const logRows = Math.max(H - (2 + 4 + inputRows + statusRows + 1), 3);
    const tail = this.log.slice(-logRows);
    for (const l of tail) {
      let rendered: string;
      switch (l.kind) {
        case "tool":
          rendered = " " + l.text;
          break;
        case "error":
          rendered = ` ${fg(C.red as unknown as RGB)}${l.text}${RESET}`;
          break;
        case "phase":
          rendered = ` ${fg(C.green as unknown as RGB)}${l.text}${RESET}`;
          break;
        case "diff":
          rendered =
            l.text.startsWith("+") && !l.text.startsWith("+++")
              ? " " + bg([6, 78, 59] as RGB) + fg(C.text as unknown as RGB) + truncateDisplay(l.text, W - 4) + RESET
              : l.text.startsWith("-") && !l.text.startsWith("---")
                ? " " + bg([127, 29, 29] as RGB) + fg(C.text as unknown as RGB) + truncateDisplay(l.text, W - 4) + RESET
                : " " + fg(C.meta as unknown as RGB) + truncateDisplay(l.text, W - 4) + RESET;
          break;
        case "info":
          rendered = ` ${fg(C.meta as unknown as RGB)}${l.text}${RESET}`;
          break;
        case "sys":
          rendered = ` ${fg(C.amber as unknown as RGB)}${l.text}${RESET}`;
          break;
        default:
          rendered = ` ${fg(C.text as unknown as RGB)}${truncateDisplay(l.text, W - 4)}${RESET}`;
      }
      lines.push(padLine(rendered, W));
    }
    while (lines.length < H - (inputRows + statusRows)) {
      lines.push(padLine(` ${fg(C.border as unknown as RGB)}│${RESET}`, W));
    }

    // Input box (3)
    const b = fg(C.border as unknown as RGB);
    lines.push(padLine(`${b}╭─ prompt ─${"─".repeat(Math.max(W - 13, 0))}╮${RESET}`, W));
    const prompt = `${fg(C.green as unknown as RGB)}❯${RESET} `;
    const before = this.input.slice(0, this.cursor);
    const at = this.input[this.cursor] ?? " ";
    const after = this.input.slice(this.cursor + 1);
    const inputLine = ` ${prompt}${before}${bg(C.panel as unknown as RGB)}${fg(C.text as unknown as RGB)}${at}${RESET}${after}`;
    lines.push(padLine(`${b}│${RESET}${inputLine}${" ".repeat(Math.max(W - ansiWidth(stripAnsi(inputLine)) - 2, 0))}${b}│${RESET}`, W));
    lines.push(padLine(`${b}╰${"─".repeat(Math.max(W - 2, 0))}╯${RESET}`, W));

    // Status bar (1)
    const skills = listSkills(undefined, 999).length;
    const stats = todoStats();
    const status =
      ` [${this.provider}/${this.model}] · [${this.phase}] · [Skills ${skills}] · [Context ${this.contextPct}%]` +
      (stats.total ? ` · [Todos ${stats.open + stats.in_progress}]` : "");
    lines.push(
      padLine(
        `${bg(C.panel as unknown as RGB)}${fg(C.text as unknown as RGB)}${truncateDisplay(status, W)}${RESET}`,
        W,
      ),
    );

    this.differ.present(lines);
  }

  private shutdown(code: number): void {
    if (this.timer) clearInterval(this.timer);
    this.rl?.close();
    process.stdin.setRawMode?.(false);
    process.stdin.pause();
    process.stdout.write("\x1b[?25h\x1b[?1049l");
    process.exit(code);
  }
}

export async function runTui(): Promise<void> {
  const tui = new Tui();
  await tui.start();
  void toolCatalogMarkdown;
}

if (import.meta.main) {
  void runTui();
}
