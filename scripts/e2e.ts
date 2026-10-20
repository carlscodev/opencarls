/**
 * OpenCarls — Prueba de fuego E2E con NVIDIA NIM (real).
 *
 * Agente autónomo (provider nvidia · deepseek-ai/deepseek-v4.1-flash,
 * alta latencia tolerada) ejecuta el bucle LOCKPACK completo sobre
 * /tmp/opencarls-demo:
 *   EXECUTE → HARDEN_AND_AUDIT → VISUAL_CRITIQUE (DOM) → SKILL_DISTILLATION
 * y construye una landing/mini-app moderna con verificación y su PRIMERA skill.
 *
 * Uso:  bun scripts/e2e.ts        (exit 0 = éxito)
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runLockpack, type LockpackEvent } from "../src/core/lockpack-loop";
import { loadDotEnv, resolveProvider, providerHasKey, defaultModel } from "../src/providers/router";
import { listSkills } from "../src/memory/db";
import { closeDb } from "../src/memory/db";
import { registerAllTools } from "../src/tools/bundle";

const TARGET = process.env.OPENCARLS_E2E_DIR ?? "/tmp/opencarls-demo";

function log(msg: string): void {
  console.error(`[e2e ${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

async function main(): Promise<void> {
  loadDotEnv();
  const cfg = resolveProvider("nvidia");
  if (!providerHasKey(cfg)) {
    console.error("FALTA NVIDIA_API_KEY (revisa .env)");
    process.exit(2);
  }
  const model = defaultModel(cfg);
  log(`provider=${cfg.id} model=${model} target=${TARGET}`);

  // Entrega limpia
  rmSync(TARGET, { recursive: true, force: true });
  mkdirSync(TARGET, { recursive: true });
  // Espacio de trabajo con verificación automática (inferVerifyCmd → `bun run test`)
  writeFileSync(
    join(TARGET, "package.json"),
    JSON.stringify(
      {
        name: "opencarls-demo",
        private: true,
        scripts: {
          test:
            "node --check app.js && test -s index.html && grep -q '</html>' index.html && test -s styles.css",
        },
      },
      null,
      2,
    ) + "\n",
  );

  registerAllTools();

  const t0 = Date.now();
  const report = await runLockpack({
    task:
      "Construye una landing page moderna para un producto SaaS llamado 'Vantage' en este directorio " +
      "(index.html, styles.css, app.js). Minimalismo de lujo: tipografía con escala clara, jerarquía " +
      "fuerte, espaciado generoso, contraste WCAG, header + hero + features + pricing + footer, " +
      "interactividad real en app.js (menú responsive, smooth scroll, estado de pricing), sin " +
      "frameworks ni CDNs (todo self-contained), sin cyberpunk ni plantillas genéricas. " +
      "Después de construir: verifica con las herramientas (lsp_diagnostics, bash), audita la " +
      "jerarquía y el diseño, y usa skill_forge para crear la PRIMERA skill de calidad si falta.",
    target_dir: TARGET,
    provider: "nvidia",
    model,
    critique_target: 8,
    visual: true,
    max_cycles: 5,
    max_visual_refinements: 2,
    onEvent: (ev: LockpackEvent) => {
      if (ev.type === "phase") log(`ciclo ${ev.cycle ?? "?"} [${ev.phase}] ${ev.message ?? ""}`);
      else if (ev.type === "log") log(ev.message ?? "");
      else if (ev.type === "agent" && ev.agent) {
        const a = ev.agent;
        if (a.type === "tool_end") log(`  ⚡ ${a.name} ${a.ok ? "ok" : "FAIL"} ${a.duration_ms}ms`);
        else if (a.type === "error") log(`  ✖ ${a.error}`);
        else if (a.type === "phase") log(`  · ${a.phase}`);
      } else if (ev.type === "done") {
        const d = ev.data as Record<string, unknown>;
        log(`RUN ${JSON.stringify(d)}`);
      }
    },
  });

  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const html = join(TARGET, "index.html");
  const css = join(TARGET, "styles.css");
  const js = join(TARGET, "app.js");
  const skills = listSkills("active", 50).filter((s) => s.slug.startsWith("lockpack-cycle-"));

  console.log("\n═══ E2E NVIDIA · REPORTE FINAL ═══");
  console.log(`ciclos: ${report.cycles.length} · aceptado: ${report.accepted} · stop: ${report.stop_reason} · ${secs}s`);
  console.log(`tokens: in=${report.tokens_in} out=${report.tokens_out}`);
  for (const c of report.cycles) {
    console.log(
      `  ciclo ${c.cycle}: exec tools=${c.execute.tool_calls}/${c.execute.iterations} · audit=${c.audit.clean ? "CLEAN" : `${c.audit.count} err`} · crítica=${c.critique.score.toFixed(1)}/10 (${c.critique.mode}) · skill=${c.distillation.skill ?? "-"} · ${(c.duration_ms / 1000).toFixed(1)}s`,
    );
    if (c.audit.issues.length) console.log(`    audit issues: ${c.audit.issues.slice(0, 3).join(" | ")}`);
    if (c.critique.issues.length) console.log(`    critique: ${c.critique.issues.slice(0, 3).join(" | ")}`);
  }
  const checks = {
    html: existsSync(html),
    css: existsSync(css),
    js: existsSync(js),
    pkg_test: existsSync(join(TARGET, "package.json")),
    skill_lockpack: skills.length > 0,
    cycles_ran: report.cycles.length > 0,
    no_fatal: report.stop_reason !== "fatal",
  };
  console.log("checks:", JSON.stringify(checks, null, 2));
  if (checks.html) {
    const size = Bun.file(html).size;
    console.log(`index.html: ${size} bytes`);
  }
  const ok =
    checks.html &&
    checks.css &&
    checks.js &&
    checks.skill_lockpack &&
    checks.cycles_ran &&
    checks.no_fatal &&
    report.accepted;
  console.log(ok ? "\nE2E ✅ ÉXITO" : "\nE2E ❌ FALLÓ");
  closeDb();
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error("E2E CRASH:", e);
  try { closeDb(); } catch { /* noop */ }
  process.exit(1);
});
