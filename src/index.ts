/**
 * OpenCarls — Punto de entrada del daemon (Fase 1: bench de herramientas).
 *
 * Uso:
 *   bun run src/index.ts                 → banner + ayuda
 *   bun run src/index.ts tools           → catálogo registrado
 *   bun run src/index.ts exec <tool> '<json>' [--file f.json]
 *   bun run src/index.ts stats           → telemetría + memoria (SQLite)
 *
 * (Fase 3 añadirá el bucle Lockpack, gateway Bun.serve y watcher SSE.)
 */
import { CONFIG } from "./core/config";
import { createLogger } from "./core/logger";
import { bashSession } from "./tools/bash_session";
import { codeSurgeryTool } from "./tools/code_surgery";
import { gnomeInputTool } from "./tools/gnome_input";
import { gnomeVisionTool } from "./tools/gnome_vision";
import { bashSessionTool } from "./tools/bash_session";
import { registerAllTools } from "./tools/bundle";
import {
  executeTool,
  listTools,
  registerTools,
  toolCatalogMarkdown,
} from "./tools/registry";
import { closeDb, dbStats, episodicStats, hasFts, openSession, toolStats } from "./memory/db";

const log = createLogger("main");

function registerAll(): void {
  registerAllTools(); // Fase 1 + 2 + 3 (aditivo)
}

function banner(): void {
  const { name, version, phase } = CONFIG.daemon;
  console.log(
    [
      `\x1b[1;36m ██████╗ ██████╗ ██████╗ ██████╗  ██████╗ \x1b[0m`,
      `\x1b[1;36m██╔═══██╗██╔═══██╗██╔══██╗██╔══██╗██╔═══██╗\x1b[0m  ${name} v${version}`,
      `\x1b[1;36m██║   ██║██║   ██║██████╔╝██████╔╝██║   ██║\x1b[0m  daemon agéntico perpetuo`,
      `\x1b[1;36m██║   ██║██║   ██║██╔══██╗██╔══██╗██║   ██║\x1b[0m  fase implementada: ${phase}/4`,
      `\x1b[1;36m╚██████╔╝╚██████╔╝██║  ██║██████╔╝╚██████╔╝\x1b[0m  home: ${CONFIG.agent_home}`,
      `\x1b[1;36m ╚═════╝  ╚═════╝ ╚═╝  ╚═╝╚═════╝  ╚═════╝ \x1b[0m  sqlite fts5: ${hasFts() ? "on" : "off"}`,
      ``,
      `comandos:`,
      `  tools                     catálogo de herramientas`,
      `  exec <tool> '<json>'      invoca una herramienta`,
      `  exec <tool> --file f.json ... con input desde archivo`,
      `  stats                     memoria + telemetría SQLite`,
      ``,
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  const [, , cmd, ...rest] = process.argv;
  registerAll();

  if (!cmd || cmd === "help" || cmd === "--help") {
    banner();
    return;
  }

  if (cmd === "tools") {
    const full = rest.includes("--full");
    if (full) {
      console.log(toolCatalogMarkdown());
    } else {
      for (const t of listTools()) {
        console.log(`\x1b[1m${t.name.padEnd(16)}\x1b[0m [fase ${t.phase ?? "?"}] ${t.description.slice(0, 110)}${t.description.length > 110 ? "…" : ""}`);
      }
    }
    return;
  }

  if (cmd === "exec") {
    const tool = rest[0];
    if (!tool) {
      console.error("uso: exec <tool> '<json>' | exec <tool> --file <path>");
      process.exit(2);
    }
    let raw: unknown;
    const fileIdx = rest.indexOf("--file");
    if (fileIdx !== -1) {
      const p = rest[fileIdx + 1];
      if (!p) {
        console.error("--file requiere ruta");
        process.exit(2);
      }
      raw = JSON.parse(await Bun.file(p).text());
    } else {
      const jsonArg = rest.slice(1).find((a) => !a.startsWith("--"));
      if (!jsonArg) {
        console.error("falta el input JSON");
        process.exit(2);
      }
      raw = JSON.parse(jsonArg);
    }

    const sessionId = openSession(`cli:${tool}`);
    const result = await executeTool(tool, raw, { session_id: sessionId });
    console.log(JSON.stringify(result, null, 2));
    // Si se usó la sesión bash, dejar que viva hasta el fin del proceso:
    bashSession.shutdown();
    closeDb();
    process.exit(result.ok ? 0 : 1);
  }

  if (cmd === "stats") {
    const s = dbStats();
    console.log(JSON.stringify({ db: s, tools: toolStats(), episodic: episodicStats() }, null, 2));
    closeDb();
    return;
  }

  banner();
  console.error(`comando desconocido: ${cmd}`);
  process.exit(2);
}

main().catch((e) => {
  log.error("daemon abortó", { err: e instanceof Error ? e.stack : String(e) });
  bashSession.shutdown();
  closeDb();
  process.exit(1);
});

// Apagado ordenado ante Ctrl-C / SIGTERM (Fase 3 apagará también gateway MCP)
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    log.info(`recibido ${sig}; cerrando…`);
    bashSession.shutdown();
    closeDb();
    process.exit(0);
  });
}
