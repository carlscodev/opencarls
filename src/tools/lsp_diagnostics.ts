/**
 * OpenCarls — lsp_diagnostics: diagnósticos con LÍNEA y COLUMNA.
 *
 * Motores embebidos (sin LSP externo, stack Bun nativo):
 *   - TypeScript/JavaScript → `tsc --noEmit` (archivo suelto o proyecto -p)
 *   - Bash/Zsh              → `bash -n` / `zsh -n`
 *   - Python                → `python3 -m py_compile` (caret → columna)
 *
 * Salida unificada: [{ path, line, col, severity, code, message, source }]
 */
import { existsSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import type { AnyToolDefinition, ToolResult } from "../types";
import { CONFIG } from "../core/config";
import { run, runSync, type RunResult } from "../util/proc";

// Contrato del registry: devolver la data CRUDA; errores → throw
// (el registry envuelve con ok()/fail() y captura excepciones).
const ok = <T,>(data: T): T => data;
const fail = (message: string): never => {
  throw new Error(message);
};

export interface Diagnostic {
  path: string;
  line: number | null;
  col: number | null;
  severity: "error" | "warning" | "info";
  code: string | null;
  message: string;
  source: "tsc" | "bash" | "python";
}

type Lang = "ts" | "bash" | "python" | "auto";

function inferLang(path: string, explicit: Lang): Exclude<Lang, "auto"> {
  if (explicit !== "auto") return explicit;
  if (/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(path)) return "ts";
  if (/\.(sh|bash)$/.test(path)) return "bash";
  if (/\.py$/.test(path)) return "python";
  throw new Error(
    `no puedo inferir el lenguaje de ${path} — pasa language (ts|bash|python)`,
  );
}

/** `file(12,5): error TS2345: msg` | `file:12:5 - error TS2345: msg` */
function parseTsc(output: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const raw of output.split("\n")) {
    const line = raw.trimEnd();
    if (!line) continue;
    let m = /^(\S+?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.*)$/.exec(line);
    if (m) {
      out.push({
        path: m[1]!,
        line: Number(m[2]),
        col: Number(m[3]),
        severity: "error",
        code: m[4]!,
        message: m[5]!.trim(),
        source: "tsc",
      });
      continue;
    }
    m = /^(\S+?):(\d+):(\d+)\s+-\s+error\s+(TS\d+):\s+(.*)$/.exec(line);
    if (m) {
      out.push({
        path: m[1]!,
        line: Number(m[2]),
        col: Number(m[3]),
        severity: "error",
        code: m[4]!,
        message: m[5]!.trim(),
        source: "tsc",
      });
      continue;
    }
    m = /^(\S+?):(\d+):\s+warning\s+(TS\d+):\s+(.*)$/.exec(line);
    if (m) {
      out.push({
        path: m[1]!,
        line: Number(m[2]),
        col: null,
        severity: "warning",
        code: m[3]!,
        message: m[4]!.trim(),
        source: "tsc",
      });
    }
  }
  return out;
}

/** `file: line 12: ...` / `file: línea 12: ...` (bash sin columna) */
function parseBash(res: RunResult, file: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  const text = `${res.stderr}\n${res.stdout}`;
  for (const raw of text.split("\n")) {
    const m = /^(.*?):\s*(?:line|línea)\s+(\d+)(?::(\d+))?:\s*(.*)$/.exec(raw.trim());
    if (!m) continue;
    let msg = m[4]!.trim();
    let severity: "error" | "warning" = "error";
    if (/^syntax error/i.test(msg) || /no encontrado|not found|unexpected|inesperado|near token/i.test(msg)) {
      severity = "error";
    }
    out.push({
      path: (m[1] && m[1] !== "bash" ? m[1] : file).trim(),
      line: Number(m[2]),
      col: m[3] ? Number(m[3]) : null,
      severity,
      code: null,
      message: msg,
      source: "bash",
    });
  }
  if (out.length === 0 && res.exit_code !== 0) {
    out.push({
      path: file,
      line: null,
      col: null,
      severity: "error",
      code: null,
      message: text.trim().split("\n").slice(0, 4).join(" | ") || `bash -n exit ${res.exit_code}`,
      source: "bash",
    });
  }
  return out;
}

/** Traceback de py_compile: `File "x.py", line 7` + caret → columna. */
function parsePython(res: RunResult, file: string): Diagnostic[] {
  const text = `${res.stderr}\n${res.stdout}`;
  if (res.exit_code === 0 || !text.trim()) return [];
  const lines = text.split("\n");
  const out: Diagnostic[] = [];
  let curFile = file;
  let curLine: number | null = null;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const fm = /^\s*File "(.+?)", line (\d+)/.exec(raw);
    if (fm) {
      curFile = fm[1]!;
      curLine = Number(fm[2]);
      continue;
    }
    const caret = /^(\s*)\^+$/.exec(raw);
    if (caret && curLine !== null) {
      // el caret alineja bajo la fuente → columna (1-based, conserva indent)
      const col = caret[1]!.length + 1;
      // el mensaje viene después del caret en el formato nuevo de Python
      let msg = "";
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
        const t = lines[j]!.trim();
        if (t && !t.startsWith("File") && !t.startsWith("    ")) {
          msg = t;
          break;
        }
      }
      out.push({
        path: curFile,
        line: curLine,
        col,
        severity: "error",
        code: null,
        message: msg || "SyntaxError",
        source: "python",
      });
      continue;
    }
    // formato viejo: `SyntaxError: invalid syntax` tras el bloque
    const em = /^\s*(?:SyntaxError|IndentationError|TabError):\s*(.*)$/.exec(raw);
    if (em && curLine !== null && !out.some((d) => d.line === curLine)) {
      out.push({
        path: curFile,
        line: curLine,
        col: null,
        severity: "error",
        code: null,
        message: `${raw.trim()}`,
        source: "python",
      });
    }
  }
  if (out.length === 0) {
    out.push({
      path: file,
      line: null,
      col: null,
      severity: "error",
      code: null,
      message: text.trim().split("\n").slice(0, 3).join(" | ") || `py_compile exit ${res.exit_code}`,
      source: "python",
    });
  }
  return out;
}

function resolveTarget(p: string): string {
  return isAbsolute(p) ? p : join(CONFIG.project_root, p);
}

export async function runDiagnostics(
  paths: string[],
  language: Lang,
  opts: { project?: boolean; cwd?: string; timeout_ms?: number } = {},
): Promise<{ diagnostics: Diagnostic[]; clean: boolean; engines: string[] }> {
  const diagnostics: Diagnostic[] = [];
  const engines: string[] = [];
  const cwd = opts.cwd ?? CONFIG.project_root;

  // Modo proyecto TS: `tsc --noEmit` completo (reporta línea+columna por archivo)
  const wantsProject =
    opts.project === true || paths.some((p) => {
      const abs = resolveTarget(p);
      try {
        return existsSync(abs) && statSync(abs).isDirectory();
      } catch {
        return false;
      }
    });
  const tsFiles = paths.filter((p) => {
    try {
      return inferLang(p, language) === "ts";
    } catch {
      return false;
    }
  });
  if (wantsProject || (tsFiles.length > 0 && paths.length === 1 && opts.project === true)) {
    const r = await runShellTsc(cwd, opts.timeout_ms ?? 180_000);
    engines.push("tsc --noEmit (proyecto)");
    diagnostics.push(...parseTsc(`${r.stdout}\n${r.stderr}`));
    return { diagnostics, clean: diagnostics.length === 0, engines };
  }

  for (const p of paths) {
    const abs = resolveTarget(p);
    if (!existsSync(abs)) {
      diagnostics.push({
        path: p,
        line: null,
        col: null,
        severity: "error",
        code: null,
        message: `archivo no encontrado: ${p}`,
        source: "tsc",
      });
      continue;
    }
    let lang: Exclude<Lang, "auto">;
    try {
      lang = inferLang(p, language);
    } catch {
      // html/css/…: sin motor de diagnóstico → se omite (limpio) en vez de fallar.
      continue;
    }
    const timeout = opts.timeout_ms ?? 120_000;
    if (lang === "ts") {
      engines.push("tsc --noEmit (archivo)");
      const r = await run(
        ["bunx", "tsc", "--noEmit", "--pretty", "false", abs],
        { cwd, timeout_ms: timeout },
      );
      diagnostics.push(...parseTsc(`${r.stdout}\n${r.stderr}`));
    } else if (lang === "bash") {
      engines.push("bash -n");
      const shell = /zsh$/.test(abs) ? "zsh" : "bash";
      const r = runSync([shell, "-n", abs], { cwd, timeout_ms: timeout });
      diagnostics.push(...parseBash(r, abs));
    } else {
      engines.push("python3 -m py_compile");
      const r = runSync(["python3", "-m", "py_compile", abs], { cwd, timeout_ms: timeout });
      diagnostics.push(...parsePython(r, abs));
    }
  }
  // Dedup por path+line+col+message
  const seen = new Set<string>();
  const dedup = diagnostics.filter((d) => {
    const k = `${d.path}|${d.line}|${d.col}|${d.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { diagnostics: dedup, clean: dedup.length === 0, engines };
}

async function runShellTsc(cwd: string, timeout: number): Promise<RunResult> {
  const tsconfig = join(cwd, "tsconfig.json");
  if (existsSync(tsconfig)) {
    return run(["bunx", "tsc", "--noEmit", "--pretty", "false"], { cwd, timeout_ms: timeout });
  }
  return {
    stdout: "",
    stderr: `${cwd}/tsconfig.json no existe — no puedo correr tsc en proyecto`,
    exit_code: 1,
    signal: null,
    timed_out: false,
    duration_ms: 0,
    truncated: false,
    cmd: ["bunx", "tsc"],
  };
}

export const lspDiagnosticsTool: AnyToolDefinition = {
  name: "lsp_diagnostics",
  phase: 2,
  description:
    "Diagnósticos con línea y columna sin LSP externo: tsc --noEmit " +
    "(TS/JS, archivo o proyecto), bash -n (shell), python3 -m py_compile " +
    "(Python, con caret → columna). Devuelve [{path,line,col,severity,code," +
    "message,source}] y `clean` cuando no hay errores.",
  inputSchema: z.object({
    paths: z
      .array(z.string().min(1))
      .min(1)
      .max(100)
      .describe("archivos o directorios (relativos al project root)"),
    language: z.enum(["ts", "bash", "python", "auto"]).default("auto"),
    project: z
      .boolean()
      .default(false)
      .describe("true = correr tsc --noEmit sobre todo el proyecto"),
    cwd: z.string().optional(),
    timeout_ms: z.number().int().min(5_000).max(600_000).optional(),
  }),
  async handler(input): Promise<unknown> {
    const { paths, language, project, cwd, timeout_ms } = input as {
      paths: string[];
      language: Lang;
      project: boolean;
      cwd?: string | undefined;
      timeout_ms?: number | undefined;
    };
    try {
      const r = await runDiagnostics(paths, language, {
        project,
        cwd,
        timeout_ms,
      });
      return ok({
        clean: r.clean,
        count: r.diagnostics.length,
        engines: r.engines,
        diagnostics: r.diagnostics.slice(0, 500),
        summary: r.clean
          ? "sin errores"
          : `${r.diagnostics.length} diagnóstico(s): ` +
            r.diagnostics
              .slice(0, 5)
              .map(
                (d) =>
                  `${d.path}:${d.line ?? "?"}:${d.col ?? "?"} ${d.message.slice(0, 90)}`,
              )
              .join(" | "),
      });
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
  },
} as AnyToolDefinition;
