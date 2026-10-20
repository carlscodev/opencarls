/**
 * OpenCarls — Bucle perpetuo LOCKPACK.
 *
 *   EXECUTE → HARDEN_AND_AUDIT → VISUAL_CRITIQUE → SKILL_DISTILLATION
 *     │             │                    │                  │
 *     │             │                    │                  └─ skill_forge + compactor
 *     │             │                    └─ screenshot/DOM → refina hasta nivel estudio
 *     │             └─ diagnósticos + tests + backlog de endurecimiento
 *     └─ agente autónomo ejecutando el objetivo
 *
 * Cicla indefinidamente hasta cumplir criterios de aceptación (diagnósticos
 * limpios + crítica visual ≥ umbral) con `max_cycles` como red de seguridad.
 * Cada ciclo persiste episodios y distila skills reutilizables.
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { extname, join, basename } from "node:path";
import { Agent, type AgentEvent } from "./agent";
import { createLogger } from "./logger";
import { CONFIG, ensureAgentDirs } from "../core/config";
import { executeTool, listTools } from "../tools/registry";
import { registerAllTools } from "../tools/bundle";
import { addBacklogItem, setBacklogStatus, openSession, closeSession, remember } from "../memory/db";
import { compactContext } from "../memory/compactor";
import { completeChat, resolveProvider, providerHasKey, defaultModel } from "../providers/router";
import { runDiagnostics } from "../tools/lsp_diagnostics";
import { runShell, run } from "../util/proc";

const log = createLogger("lockpack");

export type LockpackPhase =
  | "cycle_start"
  | "execute"
  | "harden_and_audit"
  | "visual_critique"
  | "skill_distillation"
  | "cycle_end"
  | "done";

export interface LockpackEvent {
  type: "phase" | "agent" | "log" | "done";
  phase?: LockpackPhase;
  cycle?: number;
  message?: string;
  agent?: AgentEvent;
  data?: Record<string, unknown>;
}

export interface LockpackOptions {
  /** Objetivo del agente (ej: "landing page moderna en <dir>") */
  task: string;
  /** Directorio de trabajo/entrega (ej: /tmp/opencarls-demo) */
  target_dir: string;
  provider?: string;
  model?: string;
  /** Comando de verificación por ciclo (default: typecheck si existe tsconfig) */
  verify_cmd?: string;
  /** Rutas a diagnosticar (default: html/ts/css/js del target) */
  diagnostics_paths?: string[];
  language?: "ts" | "bash" | "python" | "auto";
  /** Umbral de crítica visual 0–10 (default 8.5) */
  critique_target?: number;
  /** Refinamientos visuales máx por ciclo (default 3) */
  max_visual_refinements?: number;
  /** Ciclos máx (red de seguridad; el bucle es perpetuo hasta criterios) */
  max_cycles?: number;
  /** Desactiva fase visual (entornos sin HTML) */
  visual?: boolean;
  session_id?: string;
  onEvent?: (ev: LockpackEvent) => void;
}

export interface CycleReport {
  cycle: number;
  execute: { iterations: number; tool_calls: number; text: string; stopped: string };
  audit: {
    clean: boolean;
    count: number;
    verify_exit: number | null;
    verify_output: string;
    issues: string[];
  };
  critique: { attempted: boolean; score: number; issues: string[]; refined: number; mode: string };
  distillation: { skill: string | null; reason: string };
  duration_ms: number;
}

export interface LockpackReport {
  cycles: CycleReport[];
  accepted: boolean;
  stop_reason: "criteria" | "max_cycles" | "fatal";
  target_dir: string;
  duration_ms: number;
  tokens_in: number;
  tokens_out: number;
}

function emitFactory(opts: LockpackOptions, cycle: number) {
  return (ev: LockpackEvent) => opts.onEvent?.({ ...ev, cycle: cycle || ev.cycle });
}

function listTargetDiagnostics(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, depth: number): void => {
    if (depth > 4 || out.length > 60) return;
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const e of entries) {
      if (e === "node_modules" || e === ".git" || e === "dist" || e.startsWith(".")) continue;
      const p = join(d, e);
      try {
        const st = statSync(p);
        if (st.isDirectory()) walk(p, depth + 1);
        else if (/\.(html|ts|tsx|js|jsx|sh|py|css)$/.test(e)) out.push(p);
      } catch {
        /* skip */
      }
    }
  };
  walk(dir, 0);
  return out;
}

function collectVisualFiles(dir: string): Array<{ path: string; content: string }> {
  const candidates = ["index.html", "styles.css", "style.css", "app.css", "main.css", "app.js", "main.js"];
  const out: Array<{ path: string; content: string }> = [];
  for (const c of candidates) {
    const p = join(dir, c);
    if (existsSync(p)) {
      try {
        out.push({ path: p, content: readFileSync(p, "utf8").slice(0, 40_000) });
      } catch {
        /* skip */
      }
    }
  }
  if (out.length === 0) {
    for (const f of listTargetDiagnostics(dir)) {
      if (/\.html$/.test(f)) {
        try {
          out.push({ path: f, content: readFileSync(f, "utf8").slice(0, 40_000) });
        } catch {
          /* skip */
        }
        if (out.length >= 2) break;
      }
    }
  }
  return out;
}

async function tryScreenshot(): Promise<{ b64: string; width: number; height: number } | null> {
  try {
    const r = (await executeTool("gnome_vision", {
      op: "capture",
      max_width: 1_400,
      grid: 64,
      save_copy: true,
    })) as { ok: boolean; data?: { image_base64?: string; resized?: { width: number; height: number } } };
    if (!r.ok || !r.data?.image_base64) return null;
    return {
      b64: r.data.image_base64,
      width: r.data.resized?.width ?? 0,
      height: r.data.resized?.height ?? 0,
    };
  } catch {
    return null;
  }
}

interface CritiqueJson {
  score: number;
  verdict: string;
  issues: string[];
  directives: string[];
}

const CRITIQUE_SYSTEM = `Eres director de arte de un estudio de diseño premium (tipo instrument/a24d). Analizas interfaces con ojo crítico de estudio: jerarquía tipográfica, escala, ritmo espacial, contraste WCAG, alineación a grilla, profundidad, coherencia de color, estados interactivos, responsividad y pulido general. NADA de cyberpunk ni plantillas genéricas. Responde SOLO JSON válido: {"score": number 0-10 con un decimal, "verdict": string corto, "issues": string[] (máx 8, concretos), "directives": string[] (máx 6, accionables y específicas)}`;

function extractJson(raw: string): CritiqueJson | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(raw.slice(start, end + 1)) as CritiqueJson;
    if (typeof obj.score !== "number") return null;
    return {
      score: Math.max(0, Math.min(10, obj.score)),
      verdict: String(obj.verdict ?? "").slice(0, 300),
      issues: Array.isArray(obj.issues) ? obj.issues.slice(0, 8).map(String) : [],
      directives: Array.isArray(obj.directives) ? obj.directives.slice(0, 6).map(String) : [],
    };
  } catch {
    return null;
  }
}

async function critiqueVisual(
  opts: LockpackOptions,
): Promise<CritiqueJson & { attempted: boolean; mode: string }> {
  if (opts.visual === false) {
    return { attempted: false, score: 0, verdict: "", issues: [], directives: [], mode: "disabled" };
  }
  const files = collectVisualFiles(opts.target_dir);
  const shot = await tryScreenshot();
  if (files.length === 0 && !shot) {
    return { attempted: false, score: 0, verdict: "sin HTML ni screenshot", issues: [], directives: [], mode: "none" };
  }

  const body = [
    files.length ? `## Archivos del proyecto\n${files.map((f) => `### ${basename(f.path)}\n\`\`\`\n${f.content}\n\`\`\``).join("\n\n")}` : "",
    `## Objetivo\n${opts.task}`,
    "",
    "Devuelve SOLO el JSON.",
  ]
    .filter(Boolean)
    .join("\n");

  const provider = opts.provider ?? resolveProvider().id;
  const model = opts.model ?? defaultModel(resolveProvider(provider));

  const ask = async (withImage: boolean): Promise<CritiqueJson | null> => {
    const messages = [
      { role: "system" as const, content: CRITIQUE_SYSTEM },
      {
        role: "user" as const,
        content: body,
        ...(withImage && shot
          ? { images: [`data:image/png;base64,${shot.b64}`] }
          : {}),
      },
    ];
    const res = await completeChat(
      {
        model,
        messages,
        max_tokens: 1_800,
        temperature: 0.2,
        // deepseek (NIM/vLLM): sin thinking — el razonamiento se come el
        // presupuesto de tokens y la crítica queda vacía (score 0).
        extra: { chat_template_kwargs: { thinking: false } },
      },
      { provider },
    );
    return extractJson(res.content || "");
  };

  let parsed: CritiqueJson | null = null;
  let mode = "text";
  if (shot && providerHasKey(resolveProvider(provider))) {
    try {
      parsed = await ask(true);
      mode = "screenshot+dom";
    } catch {
      parsed = null;
    }
  }
  if (!parsed && files.length) {
    try {
      parsed = await ask(false);
      mode = "dom";
    } catch (e) {
      log.warn("crítica visual falló", { err: String(e) });
      return { attempted: true, score: 0, verdict: "error de crítica", issues: [], directives: [], mode: "error" };
    }
  }
  if (!parsed) {
    return {
      attempted: true,
      score: 0,
      verdict: "sin JSON de crítica",
      issues: [],
      directives: [],
      mode: shot ? "screenshot-only" : "none",
    };
  }
  return { attempted: true, ...parsed, mode };
}

async function verifyCycle(
  opts: LockpackOptions,
  paths: string[],
): Promise<{ clean: boolean; count: number; verify_exit: number | null; verify_output: string; issues: string[] }> {
  const issues: string[] = [];
  let clean = true;
  let count = 0;

  // 1) Diagnósticos de archivos del target
  if (paths.length) {
    try {
      const d = await runDiagnostics(paths.slice(0, 40), opts.language ?? "auto", {
        timeout_ms: 180_000,
      });
      clean = d.clean;
      count = d.diagnostics.length;
      for (const x of d.diagnostics.slice(0, 10)) {
        issues.push(`${x.path}:${x.line ?? "?"}:${x.col ?? "?"} ${x.message.slice(0, 160)}`);
      }
    } catch (e) {
      issues.push(`diagnósticos: ${e instanceof Error ? e.message : String(e)}`);
      clean = false;
    }
  }

  // 2) Comando de verificación
  let verify_exit: number | null = null;
  let verify_output = "";
  const cmd = opts.verify_cmd ?? inferVerifyCmd(opts.target_dir);
  if (cmd) {
    const r = await runShell(cmd, { cwd: opts.target_dir, timeout_ms: 240_000 });
    verify_exit = r.exit_code;
    verify_output = (r.stdout + "\n" + r.stderr).trim().slice(0, 4_000);
    if (r.exit_code !== 0 || r.timed_out) {
      clean = false;
      issues.push(`verify(${cmd}) exit=${r.exit_code}${r.timed_out ? " timeout" : ""}: ${verify_output.slice(0, 300)}`);
    }
  }
  return { clean, count, verify_exit, verify_output, issues };
}

function inferVerifyCmd(dir: string): string | null {
  if (existsSync(join(dir, "tsconfig.json"))) return "bunx tsc --noEmit --pretty false";
  const pkgPath = join(dir, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, string> };
      if (pkg.scripts?.test) return "bun run test";
      if (pkg.scripts?.build) return "bun run build";
    } catch {
      /* pkg roto */
    }
  }
  const sh = listTargetDiagnostics(dir).filter((f) => /\.sh$/.test(f));
  if (sh.length) return sh.map((f) => `bash -n ${JSON.stringify(f)}`).join(" && ");
  return null;
}

async function distillSkill(
  agent: Agent,
  cycle: number,
  learnings: string[],
  opts: LockpackOptions,
): Promise<{ skill: string | null; reason: string }> {
  const slug = `lockpack-cycle-${cycle}`;
  const learn = learnings.slice(0, 12).join("\n- ") || "sin incidencias; checklist base de calidad";
  // 1) Intento vía agente (usa skill_forge real)
  try {
    const res = await agent.run(
      `Distila UNA skill reutilizable con skill_forge (op=create) a partir de estos aprendizajes del ciclo LOCKPACK #${slug}:\n- ${learn}\n` +
      `Reglas: slug exacto '${slug}', name legible, description de 1 línea, triggers relacionados, instructions en markdown con el checklist/procedure, ` +
      `parameters JSON Schema con al menos el campo "goal" (string, requerido) y "notes" (string opcional). ` +
      `code: TypeScript válido con \`export async function handler(input: { goal: string; notes?: string }): Promise<unknown>\` que devuelva {summary, checklist, learnings}. ` +
      `NO hagas más tareas; solo create y termina.`,
    );
    const skill = await executeTool("skill_forge", { op: "search", query: slug, limit: 3 });
    if (skill.ok) {
      const data = skill.data as { skills: Array<{ slug: string }> };
      if (data.skills.some((s) => s.slug === slug)) {
        return { skill: slug, reason: res.stopped === "done" ? "distilada por agente" : "distilada (agente cortado)" };
      }
    }
  } catch (e) {
    log.warn("distilación por agente falló → fallback determinista", { err: String(e) });
  }

  // 2) Fallback determinista (garantiza la skill aunque el LLM falle)
  try {
    const code = [
      `// Skill generada por LOCKPACK (ciclo ${cycle}) — fallback determinista`,
      `export async function handler(input: { goal: string; notes?: string }): Promise<unknown> {`,
      `  return {`,
      `    summary: "Checklist de calidad derivado del ciclo ${cycle}",`,
      `    goal: input.goal,`,
      `    notes: input.notes ?? "",`,
      `    checklist: ${JSON.stringify(learn.split("\n").map((l) => l.replace(/^- /, "").trim()), null, 2)}.slice(0, 12),`,
      `    learnings: [${learnings.slice(0, 8).map((l) => JSON.stringify(l)).join(", ")}],`,
      `  };`,
      `}`,
      ``,
    ].join("\n");
    const r = await executeTool("skill_forge", {
      op: "create",
      slug,
      name: `Lockpack ciclo ${cycle}`,
      description: `Aprendizajes del ciclo LOCKPACK #${cycle}: ${learn.slice(0, 120)}`,
      triggers: ["lockpack", "auditoría", "calidad", "diseño"],
      instructions: `# Lockpack cycle ${cycle}\n\n## Aprendizajes\n- ${learn}\n\n## Uso\nInvocar con {goal, notes?} y seguir el checklist devuelto antes de dar por terminada una tarea similar.`,
      parameters: {
        type: "object",
        properties: {
          goal: { type: "string", description: "Objetivo de la tarea" },
          notes: { type: "string", description: "Notas opcionales" },
        },
        required: ["goal"],
      },
      code,
      overwrite: true,
    });
    if (r.ok) return { skill: slug, reason: "fallback determinista" };
    return { skill: null, reason: `create falló: ${String((r as { error?: string }).error)}` };
  } catch (e) {
    return { skill: null, reason: e instanceof Error ? e.message : String(e) };
  }
}

export async function runLockpack(opts: LockpackOptions): Promise<LockpackReport> {
  // Defensa: proceso sin tools registradas (e2e, gateway, scripts sueltos).
  if (listTools().length === 0) registerAllTools();
  const started = Date.now();
  const maxCycles = opts.max_cycles ?? 8;
  const critiqueTarget = opts.critique_target ?? 8.5;
  const maxVisual = opts.max_visual_refinements ?? 3;
  const emit = (ev: LockpackEvent, cycle?: number): void => opts.onEvent?.({ ...ev, cycle });

  ensureAgentDirs();
  const session = opts.session_id ?? openSession(`lockpack:${basename(opts.target_dir)}`);

  const agent = new Agent({
    provider: opts.provider,
    model: opts.model,
    max_iterations: 30,
    session_id: session,
    onEvent: (aev) => emit({ type: "agent", agent: aev }),
  });

  const cycles: CycleReport[] = [];
  let pendingAudit: string[] = [];
  let pendingCritique: string[] = [];
  let accepted = false;
  let stop_reason: LockpackReport["stop_reason"] = "max_cycles";
  let tokensIn = 0;
  let tokensOut = 0;

  try {
    for (let cycle = 1; cycle <= maxCycles; cycle++) {
      const c0 = Date.now();
      emit({ type: "phase", phase: "cycle_start", message: `=== LOCKPACK ciclo ${cycle} ===` }, cycle);

      // ── 1) EXECUTE ──
      emit({ type: "phase", phase: "execute" }, cycle);
      agent.setSystem(
        `Entorno LOCKPACK. Ciclo ${cycle}. Trabaja DIRECTORIO ${opts.target_dir} ` +
          `(respeta el diseño: minimalismo de lujo, sin cyberpunk). Ejecuta, verifica y deja TODO funcionando.`,
      );
      const execGoal =
        cycle === 1
          ? opts.task
          : `CICLO ${cycle} de LOCKPACK. Aplica estas correcciones PENDIENTES y vuelve a verificar TODO en ${opts.target_dir}:\n` +
            `1) Auditoría: ${pendingAudit.join("\n- ") || "ninguna (re-verifica)"}\n` +
            `2) Crítica visual: ${pendingCritique.join("\n- ") || "ninguna (re-verifica)"}`;
      // Tolerancia: un error transitorio del proveedor (504/timeout) NO debe
      // matar el bucle entero → se reintenta la ejecución hasta 2 veces.
      let exec = await agent.run(execGoal);
      for (let er = 0; exec.stopped === "error" && er < 2; er++) {
        emit(
          {
            type: "log",
            message: `EXECUTE error (${exec.error ?? "stream"}) → reintento ${er + 1}/2 en 10s`,
          },
          cycle,
        );
        await new Promise((r) => setTimeout(r, 10_000));
        exec = await agent.run(execGoal);
      }
      tokensIn += exec.tokens_in;
      tokensOut += exec.tokens_out;
      if (exec.stopped === "error") {
        emit({ type: "log", message: `EXECUTE error: ${exec.error ?? "stream"}` }, cycle);
        stop_reason = "fatal";
        break;
      }

      // ── 2) HARDEN_AND_AUDIT ──
      emit({ type: "phase", phase: "harden_and_audit" }, cycle);
      const paths = opts.diagnostics_paths?.length
        ? opts.diagnostics_paths
        : listTargetDiagnostics(opts.target_dir);
      const audit = await verifyCycle(opts, paths);
      for (const issue of audit.issues) {
        try {
          const id = addBacklogItem({
            session_id: session,
            title: `[cycle ${cycle}] ${issue.slice(0, 140)}`,
            description: issue,
            severity: audit.clean ? "low" : "high",
            phase: "lockpack",
          });
          if (audit.clean) setBacklogStatus(id, "done");
        } catch {
          /* backlog best-effort */
        }
      }
      remember({
        kind: audit.clean ? "checkpoint" : "finding",
        title: `LOCKPACK #${cycle} auditoría: ${audit.clean ? "LIMPIA" : `${audit.count} hallazgos`}`,
        summary: audit.issues.slice(0, 6).join(" | ") || "sin incidencias",
        importance: audit.clean ? 6 : 8,
        tags: ["lockpack", "audit"],
        session_id: session,
      });

      pendingAudit = audit.issues.slice(0, 8);

      // ── 3) VISUAL_CRITIQUE ──
      emit({ type: "phase", phase: "visual_critique" }, cycle);
      let critiqueScore = 10;
      let refined = 0;
      let critiqueIssues: string[] = [];
      let critiqueMode = "off";
      let critiqueAttempted = false;
      if (opts.visual !== false) {
        let crit = await critiqueVisual(opts);
        critiqueAttempted = crit.attempted;
        critiqueMode = crit.mode;
        critiqueScore = crit.score;
        critiqueIssues = crit.issues;
        while (
          crit.attempted &&
          crit.score > 0 &&
          crit.score < critiqueTarget &&
          refined < maxVisual
        ) {
          refined++;
          emit({ type: "log", message: `crítica ${crit.score.toFixed(1)}/10 → refinamiento ${refined}/${maxVisual}` }, cycle);
          await agent.run(
            `REFINAMIENTO VISUAL ${refined}/${maxVisual} en ${opts.target_dir}. Puntaje actual: ${crit.score}/10 (objetivo ≥ ${critiqueTarget}).\n` +
              `Problemas:\n- ${crit.issues.join("\n- ")}\n` +
              `Directivas del estudio:\n- ${crit.directives.join("\n- ")}\n` +
              `Aplica TODO manteniendo funcionalidad; prioriza jerarquía, espaciado, tipografía y contraste. NO añadas nada cyberpunk.`,
          );
          crit = await critiqueVisual(opts);
          critiqueScore = crit.score;
          critiqueIssues = crit.issues;
        }
        if (critiqueAttempted) {
          remember({
            kind: "visual",
            title: `LOCKPACK #${cycle} crítica visual: ${critiqueScore.toFixed(1)}/10 (${critiqueMode})`,
            summary: critiqueIssues.slice(0, 5).join(" | ") || "ok",
            importance: 7,
            tags: ["lockpack", "visual"],
            session_id: session,
          });
        }
      }

      pendingCritique = critiqueAttempted && critiqueScore < critiqueTarget ? critiqueIssues : [];

      // ── 4) SKILL_DISTILLATION ──
      emit({ type: "phase", phase: "skill_distillation" }, cycle);
      const learnings = [...audit.issues, ...critiqueIssues].map((s) => s.slice(0, 200));
      const dist = await distillSkill(agent, cycle, learnings, opts);
      if (dist.skill) {
        remember({
          kind: "skill",
          title: `skill distilada: ${dist.skill}`,
          summary: dist.reason,
          importance: 6,
          tags: ["lockpack", "skill_forge"],
          session_id: session,
        });
      }
      // Compresión del hilo del agente (episodios ya persistidos arriba)
      try {
        await compactContext(agent.messages, {
          budget_tokens: (opts.model ? 40_000 : 40_000),
          keep_recent_tokens: 8_000,
          session_id: session,
          provider: opts.provider,
          model: opts.model,
        });
      } catch {
        /* compactor best-effort */
      }

      const report: CycleReport = {
        cycle,
        execute: {
          iterations: exec.iterations,
          tool_calls: exec.tool_calls,
          text: exec.final_text.slice(0, 1_500),
          stopped: exec.stopped,
        },
        audit: {
          clean: audit.clean,
          count: audit.count,
          verify_exit: audit.verify_exit,
          verify_output: audit.verify_output.slice(0, 1_500),
          issues: audit.issues,
        },
        critique: {
          attempted: critiqueAttempted,
          score: critiqueScore,
          issues: critiqueIssues,
          refined,
          mode: critiqueMode,
        },
        distillation: dist,
        duration_ms: Date.now() - c0,
      };
      cycles.push(report);
      emit({
        type: "phase",
        phase: "cycle_end",
        message: `ciclo ${cycle}: audit=${audit.clean ? "clean" : `${audit.count} err`} · crítica=${critiqueScore.toFixed(1)} · skill=${dist.skill ?? "-"} · ${(report.duration_ms / 1000).toFixed(1)}s`,
      }, cycle);

      // ── Criterios de aceptación ──
      const visualOk = opts.visual === false || !critiqueAttempted || critiqueScore >= critiqueTarget;
      if (audit.clean && visualOk) {
        accepted = true;
        stop_reason = "criteria";
        break;
      }
      if (cycle === maxCycles) stop_reason = "max_cycles";
    }
  } finally {
    try {
      closeSession(session, "closed");
    } catch {
      /* noop */
    }
  }

  const report: LockpackReport = {
    cycles,
    accepted,
    stop_reason,
    target_dir: opts.target_dir,
    duration_ms: Date.now() - started,
    tokens_in: tokensIn,
    tokens_out: tokensOut,
  };
  emit({ type: "done", data: { accepted, cycles: cycles.length, stop_reason, duration_ms: report.duration_ms } });
  log.info("LOCKPACK terminado", {
    cycles: cycles.length,
    accepted,
    stop_reason,
    ms: report.duration_ms,
  });
  void CONFIG;
  void writeFileSync;
  void extname;
  void run;
  return report;
}
