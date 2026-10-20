/**
 * OpenCarls — Verificación de FASE 1.
 * Recorre BD (WAL+FTS5), bash_session, code_surgery, gnome_* (con skip si no
 * hay sesión gráfica) y el motor de difas contra `git diff --no-index`.
 *
 *   bun run scripts/smoke.ts
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG, ensureAgentDirs } from "../src/core/config";
import {
  addBacklogItem,
  backlogStats,
  closeDb,
  dbStats,
  episodicStats,
  hasFts,
  listBacklog,
  listSkills,
  openSession,
  recentEpisodes,
  registerSkill,
  remember,
  resolveBacklogItem,
  searchEpisodes,
  searchSkills,
  bumpSkillStats,
} from "../src/memory/db";
import { bashSession } from "../src/tools/bash_session";
import { codeSurgeryTool } from "../src/tools/code_surgery";
import { gnomeInputTool } from "../src/tools/gnome_input";
import { gnomeVisionTool } from "../src/tools/gnome_vision";
import { bashSessionTool } from "../src/tools/bash_session";
import { executeTool, registerTools } from "../src/tools/registry";

let pass = 0;
let failCount = 0;
let skip = 0;

function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failCount++;
    console.log(`  \x1b[31m✗ ${name}\x1b[0m${detail ? ` — ${detail}` : ""}`);
  }
}
function section(t: string): void {
  console.log(`\n\x1b[1;36m━━ ${t} ━━\x1b[0m`);
}
async function tool(name: string, input: unknown) {
  return executeTool(name, input, {});
}

const D = join(tmpdir(), "opencarls-smoke");

import { phase2plus } from "./smoke-phase2";

async function main(): Promise<void> {
  ensureAgentDirs();
  registerTools([bashSessionTool, codeSurgeryTool, gnomeVisionTool, gnomeInputTool]);

  // ── 1. BASE DE DATOS ────────────────────────────────────────────────────
  section("SISTEMA DE MEMORIA (bun:sqlite WAL + FTS5)");
  const sessionId = openSession("smoke");
  check("sesión abierta", Boolean(sessionId));
  check("FTS5 activo", hasFts());
  const id = remember({
    session_id: sessionId,
    kind: "decision",
    title: "Lockpack decide subshell para exit",
    summary: "Los comandos con exit corren en subshell con reconciliación de PWD/exports",
    tags: ["arquitectura", "bash"],
    importance: 8,
    source: "smoke",
  });
  check("remember()", id > 0);
  const hits = searchEpisodes("subshell reconciliación");
  check("searchEpisodes FTS", hits.length > 0 && hits.some((h) => h.id === id));
  const rel = searchEpisodes("Lockpack");
  check("searchEpisodes 'Lockpack'", rel.length > 0);
  recentEpisodes(5);

  const b = addBacklogItem({ session_id: sessionId, title: "hueco demo", severity: "high", phase: "HARDEN" });
  check("addBacklogItem", b > 0);
  resolveBacklogItem(b, "resuelto en smoke", "done");
  check("backlog resolve", backlogStats().done >= 1);
  check("listBacklog", listBacklog().length >= 1);

  const sk = registerSkill({
    slug: "demo-skill",
    name: "Demo Skill",
    description: "Skill de prueba para el índice FTS de skills",
    triggers: ["demo", "smoke"],
    path: `${CONFIG.skills_dir}/demo-skill`,
    status: "active",
    source_task: "smoke",
  });
  check("registerSkill", sk > 0);
  check("searchSkills FTS", searchSkills("prueba índice").length >= 1 || searchSkills("Demo").length >= 1);
  bumpSkillStats("demo-skill", true);
  check("bumpSkillStats", listSkills()[0]?.success_count !== undefined && listSkills()[0]!.success_count >= 1);
  const stats = dbStats();
  check("dbStats tamaño>0", Number(stats.size_bytes) > 0);
  check("episódicos≥1", episodicStats().total >= 1);

  // ── 2. BASH SESSION ─────────────────────────────────────────────────────
  section("TOOL 1: bash_session");

  let r = await tool("bash_session", { op: "exec", command: "echo sm-$((3*3))" });
  check("exec básico", r.ok && (r.data as { stdout: string }).stdout.includes("sm-9"), r.error);

  await tool("bash_session", { op: "exec", command: "cd /tmp && mkdir -p opencarls-smoke" });
  r = await tool("bash_session", { op: "exec", command: "pwd" });
  check("cwd persistente", (r.data as { cwd: string }).cwd === "/tmp", (r.data as { cwd: string }).cwd);

  await tool("bash_session", { op: "exec", command: "export SM_VAR=persist-77" });
  r = await tool("bash_session", { op: "exec", command: "echo $SM_VAR" });
  check("env persistente", (r.data as { stdout: string }).stdout.includes("persist-77"));

  r = await tool("bash_session", { op: "exec", command: "echo err >&2; exit 4" });
  check("stderr+rc", (r.data as { exit_code: number }).exit_code === 4 && (r.data as { stderr: string }).stderr.includes("err"));

  r = await tool("bash_session", { op: "exec", command: "echo A; exit 6; echo B" });
  check("semántica exit (no imprime B, rc=6)", (r.data as { exit_code: number }).exit_code === 6 && !(r.data as { stdout: string }).stdout.includes("B"));

  r = await tool("bash_session", { op: "exec", command: "cd /tmp && export SMX=1 && exit 0" });
  r = await tool("bash_session", { op: "exec", command: "pwd; echo SMX=$SMX" });
  check("recon PWD+export tras exit", (r.data as { stdout: string }).stdout.includes("/tmp") && (r.data as { stdout: string }).stdout.includes("SMX=1"));

  const t0 = Date.now();
  r = await tool("bash_session", { op: "exec", command: "sleep 60", timeout_ms: 1000 });
  const el = Date.now() - t0;
  const td = r.data as { timed_out: boolean; exit_code: number; killed_session: boolean };
  check("timeout dirige SIGINT a hijos", td.timed_out && td.exit_code === 130 && !td.killed_session, JSON.stringify(td));
  check("timeout rápido (<2.5s)", el < 2500, `${el}ms`);
  r = await tool("bash_session", { op: "exec", command: "echo viva-post-timeout" });
  check("sesión sobrevive al timeout", (r.data as { stdout: string }).stdout.includes("viva-post-timeout"));

  r = await tool("bash_session", { op: "bg", command: "for i in $(seq 1 60); do echo tick-$i; sleep 0.2; done" });
  const bgPid = (r.data as { pid: number }).pid;
  const bgLog = (r.data as { log_file: string }).log_file;
  check("bg lanza proceso", r.ok && bgPid > 0, r.error);
  await Bun.sleep(600);
  r = await tool("bash_session", { op: "list_bg" });
  check("list_bg alive", (r.data as { processes: Array<{ alive: boolean }> }).processes.some((p) => p.alive));
  r = await tool("bash_session", { op: "tail_log", path: bgLog, lines: 3 });
  check("tail_log ve ticks", (r.data as { output: string }).output.includes("tick-"));
  r = await tool("bash_session", { op: "kill_bg", pid: bgPid });
  check("kill_bg", (r.data as { killed: boolean }).killed === true);
  await Bun.sleep(300);
  r = await tool("bash_session", { op: "exec", command: "pgrep -g " + bgPid + " >/dev/null && echo ALIVE || echo GONE" });
  const gone = (r.data as { stdout: string }).stdout.includes("GONE");
  check("bg realmente muerto", gone, (r.data as { stdout: string }).stdout);

  r = await tool("bash_session", { op: "exec", command: "cat", stdin_data: "l1\nl2" });
  check("stdin_data (heredoc)", (r.data as { stdout: string }).stdout.includes("l1") && (r.data as { stdout: string }).stdout.includes("l2"));

  // ── 3. CODE SURGERY ─────────────────────────────────────────────────────
  section("TOOL 2: code_surgery");
  const demoPath = join(D, "demo.ts");
  await tool("code_surgery", {
    op: "write_full",
    path: demoPath,
    content: 'export function hola(): string {\n  return "hola";\n}\n\nexport const x = 1;\n',
  });
  check("write_full", (await Bun.file(demoPath).exists()));

  r = await tool("code_surgery", { op: "read_range", path: demoPath, start_line: 1, end_line: 2 });
  check("read_range", (r.data as { content: string }).content.includes("export function hola"));

  r = await tool("code_surgery", {
    op: "surgical_replace",
    path: demoPath,
    old_text: 'return "hola";',
    new_text: 'return "hola mundo";',
  });
  const rep = r.data as { ok: boolean; diff: string; replacements: number };
  check("surgical_replace + diff", rep.ok && rep.replacements === 1 && rep.diff.includes("+  return \"hola mundo\";"));
  check("diff formato unificado", rep.diff.startsWith("--- a/") && rep.diff.includes("@@"));

  r = await tool("code_surgery", { op: "surgical_replace", path: demoPath, old_text: "export", new_text: "export" });
  check(
    "bloque duplicado rechazado",
    (r.data as { ok: boolean }).ok === false && (r.data as { matches?: number }).matches === 2,
    JSON.stringify(r.data).slice(0, 160),
  );

  r = await tool("code_surgery", { op: "ast_outline", path: demoPath });
  const outline = r.data as { nodes: Array<{ kind: string; name: string }>; engine: string };
  check(
    "ast_outline TS",
    outline.engine === "typescript-compiler-api" &&
      outline.nodes.some((n) => n.kind === "function" && n.name === "hola"),
    JSON.stringify(outline).slice(0, 200),
  );

  r = await tool("code_surgery", { op: "ripgrep_search", pattern: "hola mundo", path: D });
  const rg = r.data as { count: number; engine: string; matches: Array<{ line: number }> };
  check(`búsqueda (${rg?.engine ?? "?"})`, r.ok && rg.count >= 1, r.error);

  // ── 4. GNOME (skip sin display) ─────────────────────────────────────────
  section("TOOLS 3-4: gnome_vision / gnome_input");
  const { runSync } = await import("../src/util/proc");
  const probeDisplay = process.env.DISPLAY ?? CONFIG.display;
  const probe = runSync(["xdotool", "getmouselocation"], {
    env: { DISPLAY: probeDisplay },
    max_bytes: 2_048,
  });
  const hasX = probe.exit_code === 0;
  if (!hasX) {
    skip += 1;
    console.log(
      `  \x1b[33m○\x1b[0m skip captura: sin sesión X11 (DISPLAY=${process.env.DISPLAY ?? "no seteado"}) — probar en Ubuntu con setup_ubuntu.sh`,
    );
    const bad = await tool("gnome_input", { op: "click", button: 9 });
    check("gnome_input rechaza input inválido (zod)", bad.ok === false);
    const badKeys = await tool("gnome_input", { op: "press_keys", keys: ["ctrl+$(rm -rf)"] });
    check("gnome_input sanea combos de teclas", badKeys.ok === false);
    const st = await tool("gnome_vision", { op: "state", display: ":999" });
    check("gnome_vision.state degrada sin X", st.ok && (st.data as { cursor: unknown }).cursor === null, st.error);

    // Pipeline de sharp offline: componer la cuadrícula sobre un PNG sintético
    const { buildOverlaySvg } = await import("../src/tools/gnome_vision");
    const sharp = (await import("sharp")).default;
    const fake = await sharp({
      create: { width: 640, height: 360, channels: 3, background: { r: 30, g: 60, b: 90 } },
    })
      .png()
      .toBuffer();
    const svg = buildOverlaySvg(640, 360, {
      grid: 100,
      show_grid: true,
      label_every: 100,
      cursor: { x: 320, y: 180 },
      show_cursor: true,
    });
    const composed = await sharp(fake)
      .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
      .jpeg({ quality: 80 })
      .toBuffer();
    check("sharp compone grilla+cursor offline", composed.byteLength > 2_000, `${composed.byteLength}B`);
    const meta = await sharp(composed).metadata();
    check("jpeg resultante 640x360", meta.width === 640 && meta.height === 360, `${meta.width}x${meta.height}`);
  } else {
    r = await tool("gnome_input", { op: "get_state" });
    check("gnome_input.get_state", r.ok, r.error);
    r = await tool("gnome_vision", { op: "capture", save_copy: true, quality: 70 });
    check("gnome_vision.capture", r.ok && Boolean((r.data as { image_base64: string }).image_base64), r.error);
    if (r.ok) {
      const d = r.data as { windows: unknown[]; width: number };
      check("capture con ventanas/imagen", d.width > 0 && Array.isArray(d.windows));
    }
  }

  // ── 5. DIFAS vs git ─────────────────────────────────────────────────────
  section("DIFAS UNIFICADAS vs git diff --no-index");
  const { run } = await import("../src/util/proc");
  const { unifiedDiff } = await import("../src/util/diff");
  let diffOk = 0;
  let diffTotal = 0;

  const cases: Array<[string, string]> = [
    ["", "hola\n"],
    ["hola\n", ""],
    ["a\nb\nc\n", "a\nB\nc\n"],
    ["x1\nx2\nx3\nx4\nx5\nx6\nx7\nx8\nx9\nx10\n", "x1\nx2\nX3\nx4\nx5\nx6\nx7\nX8\nx9\nx10\n"],
    ["sin newline", "sin newline 2"],
    ["1\n2\n3\n", "0\n1\n2\n3\n4\n"],
    ["mismo\n", "mismo\n"],
  ];
  for (let i = 0; i < 40; i++) {
    const n = 3 + (i % 17);
    const alphabet = ["alpha", "beta", "gamma", "delta"];
    const aLines: string[] = [];
    const bLines: string[] = [];
    for (let k = 0; k < n; k++) {
      const base = alphabet[k % alphabet.length]!;
      aLines.push(`${k}:${base}`);
      if (i % 3 !== 0 || k % 4 === 0) bLines.push(`${k}:${base}${i % 5 === 0 ? "-edit" : ""}`);
      if (k % 7 === 1) aLines.push(`ins-${i}-${k}`);
    }
    cases.push([aLines.join("\n") + "\n", bLines.join("\n") + "\n"]);
  }

  for (const [a, b] of cases) {
    diffTotal++;
    const pa = join(D, `d${diffTotal}-a.txt`);
    const pb = join(D, `d${diffTotal}-b.txt`);
    await Bun.write(pa, a);
    await Bun.write(pb, b);
    const g = await run(["git", "diff", "--no-index", "--", pa, pb], { max_bytes: 1024 * 1024 });
    const gitOut = g.stdout;
    const mine = unifiedDiff(a, b, `d${diffTotal}-a.txt`);
    const norm = (s: string) =>
      s
        .split("\n")
        .filter(
          (l) =>
            l !== "" &&
            !/^(diff --git|index |new file mode|deleted file mode|old mode|new mode|similarity index|--- |\+\+\+ )/.test(l),
        )
        // git añade el sufijo "funcname" tras @@ … @@; nosotros no (agnósticos
        // de lenguaje) → normalizamos a la cabecera de hunk pura.
        .map((l) => l.replace(/^(@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@).*$/, "$1"))
        .join("\n");
    const same = norm(gitOut) === norm(mine);
    if (same) diffOk++;
    else if (diffOk === diffTotal) {
      console.log("  primer diff divergente:");
      console.log("  --- git ---\n" + norm(gitOut).slice(0, 500));
      console.log("  --- mine ---\n" + norm(mine).slice(0, 500));
    }
  }
  check(`git diff parity ${diffOk}/${diffTotal}`, diffOk === diffTotal);

  // ── FASES 2–4 ────────────────────────────────────────────────────────────
  await phase2plus(check, section, tool);

  // ── RESUMEN ─────────────────────────────────────────────────────────────
  section("RESUMEN");
  console.log(`  pass=${pass}  fail=${failCount}  skip=${skip}`);
  bashSession.shutdown();
  closeDb();
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("SMOKE CRASH:", e);
  bashSession.shutdown();
  closeDb();
  process.exit(1);
});
