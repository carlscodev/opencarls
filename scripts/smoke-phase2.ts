/**
 * OpenCarls — Smoke Fases 2–4 (importado por scripts/smoke.ts).
 * providers/router/reasoning/sse/json_schema · tools Fase 2/3 · compactor ·
 * LOCKPACK + gateway (boot real loopback) · TUI RollingThoughtBox.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Check = (name: string, cond: boolean, detail?: string) => void;
type Section = (title: string) => void;
type ToolFn = (name: string, input: unknown) => Promise<{ ok: boolean; data?: unknown; error?: string }>;

export async function phase2plus(check: Check, section: Section, tool: ToolFn): Promise<void> {
  // Registro completo (Fases 1–3) — smoke.ts registró solo 4 al arrancar.
  const { registerAllTools } = await import("../src/tools/bundle");
  registerAllTools();

  // ── Providers ─────────────────────────────────────────────────────────────
  section("PROVIDERS (Fase 2)");
  const { PROVIDERS, resolveProvider, providerHasKey, defaultModel, detectNativeComputerUse, providerStatus } =
    await import("../src/providers/router");
  check("registry multi-proveedor", Object.keys(PROVIDERS).length >= 11, Object.keys(PROVIDERS).join(","));
  const nvidia = resolveProvider("nvidia");
  check("nvidia 600s timeout", nvidia.timeout_ms === 600_000 && nvidia.base_url.includes("integrate.api.nvidia.com"));
  check("nvidia retry 429…", nvidia.retry.max >= 4);
  check("providers locales sin key", providerHasKey(resolveProvider("ollama")) === true);
  check("modelo default nvidia", defaultModel(nvidia).length > 3, defaultModel(nvidia));
  check("native CU null p/ nvidia", detectNativeComputerUse("nvidia", "deepseek-ai/deepseek-v4.1-flash") === null);
  check("native CU anthropic", detectNativeComputerUse("anthropic", "claude-sonnet-4-5") === "anthropic");
  check("providerStatus", providerStatus().length >= 11 && providerStatus()[0]!.key_present === true);

  // ── Reasoning extractor ───────────────────────────────────────────────────
  const { ReasoningTagExtractor } = await import("../src/providers/reasoning");
  {
    const ex = new ReasoningTagExtractor();
    const a = ex.feed("Hola <thinking>analizo el");
    const b = ex.feed(" caso</thinking> y respondo.");
    const c = ex.flush();
    check("extractor <thinking> en vivo", a.reasoning.includes("analizo") && b.reasoning.includes("caso"), JSON.stringify([a, b]));
    const clean = a.content + b.content + c.content;
    check("extractor content limpio", clean.includes("Hola") && !clean.includes("thinking"), clean);
    const ex2 = new ReasoningTagExtractor();
    const x1 = ex2.feed("pensando <thi");
    const x2 = ex2.feed("nking>idea</think");
    const x3 = ex2.feed("ing>fin");
    check("extractor marker partido", x1.content === "pensando " && x2.reasoning.includes("idea") && x3.content.includes("fin"), JSON.stringify([x1, x2, x3]));
    const ex3 = new ReasoningTagExtractor();
    const r = ex3.feed("texto <invalid aquí </invalid> fuera");
    check("extractor <invalid> inline", r.reasoning.includes("aquí") && r.content.includes("fuera") && !r.content.includes("invalid"), JSON.stringify(r));
    const ex4 = new ReasoningTagExtractor();
    const plain = ex4.feed("el argumento es invalid según el benchmark");
    check("extractor no confunde 'invalid' literal", plain.content.includes("invalid") && !plain.reasoning, JSON.stringify(plain));
  }

  // ── SSE / backoff ─────────────────────────────────────────────────────────
  const { backoffDelay, RETRYABLE_STATUS, SseIdleError, RetryableHttpError } = await import("../src/providers/sse");
  check("retryables 429/50x", [429, 500, 502, 503, 504].every((s) => RETRYABLE_STATUS.has(s)) && !RETRYABLE_STATUS.has(400));
  {
    const d0 = backoffDelay(0, 1000, null);
    const d3 = backoffDelay(3, 1000, null);
    check("backoff expo+jitter", d0 >= 1000 && d0 <= 2000 && d3 >= 8000 && d3 <= 16000, `${d0}/${d3}`);
    check("backoff Retry-After", backoffDelay(0, 1000, 5000) >= 5000);
    check("errores red tipados", new SseIdleError(100).name === "SseIdleError" && new RetryableHttpError(429, "x").status === 429);
  }

  // ── zod→JSON Schema ───────────────────────────────────────────────────────
  const { zodToJsonSchema, toOpenAiTool } = await import("../src/providers/json_schema");
  const { z } = await import("zod");
  {
    const sch = z.object({
      name: z.string().min(1).max(10),
      count: z.number().int().min(0).default(3),
      kind: z.enum(["a", "b"]),
      items: z.array(z.string()).max(5),
      maybe: z.boolean().optional(),
      nested: z.object({ x: z.number() }).optional(),
    });
    const js = zodToJsonSchema(sch) as Record<string, any>;
    check("jsonsch object+required", js.type === "object" && Array.isArray(js.required) && js.required.includes("name") && !js.required.includes("count") && !js.required.includes("maybe"), JSON.stringify(js.required));
    check("jsonsch string/limits", js.properties?.name?.minLength === 1 && js.properties?.name?.maxLength === 10);
    check("jsonsch int+default", js.properties?.count?.type === "integer" && js.properties?.count?.default === 3 && js.properties?.count?.minimum === 0);
    check("jsonsch enum", JSON.stringify(js.properties?.kind?.enum) === '["a","b"]');
    check("jsonsch array", js.properties?.items?.maxItems === 5 && js.properties?.items?.items?.type === "string");
    check("jsonsch nested", js.properties?.nested?.properties?.x?.type === "number");
    const toolDef = toOpenAiTool({ name: "t", description: "d", inputSchema: sch });
    check("toOpenAiTool envoltura", toolDef.type === "function" && toolDef.function.parameters.type === "object");
    const { ALL_TOOLS } = await import("../src/tools/bundle");
    check("bundle Fases 1–3 ≥11 tools", ALL_TOOLS.length >= 11, String(ALL_TOOLS.length));
  }

  // ── multi_patch ───────────────────────────────────────────────────────────
  section("TOOLS FASE 2");
  {
    const { registerTool } = await import("../src/tools/registry");
    const { multiPatchTool } = await import("../src/tools/multi_patch");
    registerTool(multiPatchTool as never);
    const dir = "/tmp/oc-smoke-mp";
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "a.txt"), "linea1\nlinea2\n");
    writeFileSync(join(dir, "b.txt"), "hola mundo\n");

    const r1 = await tool("multi_patch", {
      patches: [
        { path: join(dir, "a.txt"), op: "replace", find: "linea2", replace: "LINEA2-EDIT" },
        { path: join(dir, "b.txt"), op: "append", content: "nueva linea\n" },
        { path: join(dir, "c.txt"), op: "create", content: "creado\n" },
      ],
    });
    check("multi_patch aplica", r1.ok === true, r1.error);
    const d1 = r1.data as { diff?: string };
    check("multi_patch diff combinado", readFileSync(join(dir, "a.txt"), "utf8").includes("LINEA2-EDIT") && typeof d1?.diff === "string" && d1.diff.includes("+LINEA2-EDIT"), d1?.diff?.slice(0, 100));

    const before = readFileSync(join(dir, "a.txt"), "utf8");
    const r2 = await tool("multi_patch", {
      patches: [
        { path: join(dir, "a.txt"), op: "replace", find: "linea1", replace: "X" },
        { path: join(dir, "b.txt"), op: "replace", find: "NO-EXISTE", replace: "y" },
      ],
    });
    check("multi_patch rollback total", r2.ok === false && /revertida/.test(r2.error ?? "") && readFileSync(join(dir, "a.txt"), "utf8") === before, (r2.error ?? "").slice(0, 120));

    const r3 = await tool("multi_patch", { patches: [{ path: join(dir, "a.txt"), op: "append", content: "DRY" }], dry_run: true });
    check("multi_patch dry_run no escribe", r3.ok && !readFileSync(join(dir, "a.txt"), "utf8").includes("DRY"));

    const r4 = await tool("multi_patch", {
      patches: [
        { path: join(dir, "c.txt"), op: "rename", to: join(dir, "d.txt") },
        { path: join(dir, "d.txt"), op: "delete" },
      ],
    });
    check("multi_patch rename+delete", r4.ok && !existsSync(join(dir, "d.txt")) && !existsSync(join(dir, "c.txt")), r4.error);
    const r5 = await tool("multi_patch", {
      patches: [{ path: join(dir, "a.txt"), op: "regex_replace", pattern: "linea", flags: "gi", replace: "L", expect_count: 2 }],
    });
    check("multi_patch regex+expect_count", r5.ok && readFileSync(join(dir, "a.txt"), "utf8").includes("L1"), r5.error);
  }

  // ── lsp_diagnostics ───────────────────────────────────────────────────────
  {
    const { runDiagnostics } = await import("../src/tools/lsp_diagnostics");
    writeFileSync("/tmp/oc-smoke-bad.py", "def hola(:\n    pass\n");
    const py = await runDiagnostics(["/tmp/oc-smoke-bad.py"], "python", { timeout_ms: 30_000 });
    check("lsp python (línea)", !py.clean && py.diagnostics.length >= 1 && py.diagnostics[0]!.line !== null, JSON.stringify(py.diagnostics[0]));

    writeFileSync("/tmp/oc-smoke-bad.sh", 'if [ 1 -eq 1 ]\nthen echo "x"\nfi then\n');
    const sh = await runDiagnostics(["/tmp/oc-smoke-bad.sh"], "bash", { timeout_ms: 30_000 });
    check("lsp bash -n", !sh.clean && sh.diagnostics.length >= 1, JSON.stringify(sh.diagnostics[0]));

    writeFileSync("/tmp/oc-smoke-ok.ts", "export const x: number = 1;\n");
    const tsOk = await runDiagnostics(["/tmp/oc-smoke-ok.ts"], "ts", { timeout_ms: 120_000 });
    check("lsp tsc clean", tsOk.clean, JSON.stringify(tsOk.diagnostics.slice(0, 1)));

    writeFileSync("/tmp/oc-smoke-bad.ts", "export const x: number = 'no';\nconst y: = 2;\n");
    const tsBad = await runDiagnostics(["/tmp/oc-smoke-bad.ts"], "ts", { timeout_ms: 120_000 });
    check("lsp tsc error línea+columna", !tsBad.clean && typeof tsBad.diagnostics[0]?.col === "number", JSON.stringify(tsBad.diagnostics[0]));

    const t = await tool("lsp_diagnostics", { paths: ["/tmp/oc-smoke-ok.ts"], language: "ts" });
    check("lsp via registry", t.ok && (t.data as { clean: boolean }).clean === true, t.error);
  }

  // ── web_fetch (conversión pura) ───────────────────────────────────────────
  {
    const { htmlToMarkdown } = await import("../src/tools/web_fetch");
    const md = htmlToMarkdown(
      '<html><body><nav>m</nav><h1>Hola <em>mundo</em></h1><p>Texto &amp; más</p><ul><li>uno</li></ul><a href="/x">enlace</a><pre><code>const a = 1;</code></pre></body></html>',
      "https://ejemplo.com/p",
    );
    check("web_fetch md heading+entities", md.includes("# Hola mundo") && md.includes("Texto & más"), md.slice(0, 120));
    check("web_fetch md link+list+fence", md.includes("](https://ejemplo.com/x)") && md.includes("- uno") && md.includes("```"));
    const bad = await tool("web_fetch", { url: "ftp://malformed" });
    check("web_fetch rechaza no-http", bad.ok === false, bad.error);
  }

  // ── computer_use ──────────────────────────────────────────────────────────
  {
    const { chordToXdotool, executeNativeComputerAction, computerUseTool } = await import("../src/tools/computer_use");
    const { normalizedToPixels, getScreenResolution } = await import("../src/tools/gnome_vision");
    check("computer_use registrado", computerUseTool.name === "computer_use" && computerUseTool.phase === 2);
    check("chord traducción", chordToXdotool("CTRL+C") === "ctrl+c" && chordToXdotool("ENTER") === "Return" && chordToXdotool(["ctrl", "alt", "t"]) === "ctrl+alt+t");
    const p = normalizedToPixels(1000, 1000, { width: 1000, height: 500 }, "normalized_1000");
    check("coords 0..1000 auto-escaladas", p.x === 999 && p.y === 499, JSON.stringify(p));
    const p2 = normalizedToPixels(0.5, 0.5, { width: 800, height: 600 }, "normalized_0_1");
    check("coords 0..1", p2.x === 400 && p2.y === 300, JSON.stringify(p2));
    const scr = getScreenResolution();
    check("screen resolution obtiene display", scr.display.length > 0, JSON.stringify(scr));
    let nativeErr = "";
    try {
      await executeNativeComputerAction({ type: "click", coordinate: [10, 10] }, {});
    } catch (e) {
      nativeErr = e instanceof Error ? e.message : String(e);
    }
    check("native click sin X11 falla limpio", nativeErr.includes("X11") || nativeErr.includes("DISPLAY"), nativeErr);
    const mode = await tool("computer_use", { op: "mode" });
    check("computer_use mode universal", mode.ok && (mode.data as { mode: string }).mode === "universal" && (mode.data as { environment: string }).environment === "linux", mode.error);
  }

  // ── todo_board ────────────────────────────────────────────────────────────
  {
    const { registerTool } = await import("../src/tools/registry");
    const { todoBoardTool } = await import("../src/tools/todo_board");
    registerTool(todoBoardTool as never);
    const a = await tool("todo_board", { op: "add", title: "SmokeF2", priority: 1, tags: ["smoke"] });
    check("todo add", a.ok, a.error);
    const id = (a.data as { todo?: { id: number } })?.todo?.id ?? 0;
    const l = await tool("todo_board", { op: "list" });
    check("todo list+markdown", l.ok && (l.data as { count: number }).count >= 1 && String((l.data as { markdown: string }).markdown).includes("SmokeF2"), l.error);
    const u = await tool("todo_board", { op: "update", id, status: "in_progress" });
    check("todo update status", u.ok && (u.data as { todo: { status: string } }).todo.status === "in_progress", u.error);
    const st = await tool("todo_board", { op: "stats" });
    check("todo stats", st.ok && (st.data as { stats: { total: number } }).stats.total >= 1);
    const d = await tool("todo_board", { op: "delete", id });
    check("todo delete", d.ok, d.error);
  }

  // ── skill_forge ciclo completo ────────────────────────────────────────────
  {
    const { registerTool } = await import("../src/tools/registry");
    const { skillForgeTool } = await import("../src/tools/skill_forge");
    registerTool(skillForgeTool as never);
    const mk = (v: number, upper: boolean): string =>
      "export async function handler(input: { goal: string; notes?: string }): Promise<unknown> {\n" +
      "  return { echo: " + (upper ? "input.goal.toUpperCase()" : "input.goal") + ', n: input.notes ?? "", v: ' + v + " };\n}";
    const c = await tool("skill_forge", {
      op: "create",
      overwrite: true,
      slug: "smoke-f2-skill",
      name: "Smoke F2",
      description: "Skill smoke Fase 2",
      triggers: ["smoke"],
      instructions: "# Smoke\n1) verificar",
      parameters: { type: "object", properties: { goal: { type: "string" }, notes: { type: "string" } }, required: ["goal"] },
      code: mk(1, false),
    });
    check("skill_forge create", c.ok && existsSync("/home/user/opencarls/.agent/skills/smoke-f2-skill/SKILL.md"), c.error);

    const e = await tool("skill_forge", { op: "execute", slug: "smoke-f2-skill", input: { goal: "hola" } });
    check("skill_forge execute", e.ok && (e.data as { result: { v: number } }).result.v === 1, JSON.stringify(e.data ?? e.error));

    const r = await tool("skill_forge", { op: "refine", slug: "smoke-f2-skill", code: mk(2, true) });
    check("skill_forge refine version++", r.ok && (r.data as { version: string }).version === "0.1.1", JSON.stringify(r.data ?? r.error));

    const e2 = await tool("skill_forge", { op: "execute", slug: "smoke-f2-skill", input: { goal: "hola" } });
    const res2 = (e2.data ?? {}) as { result?: { echo: string; v: number } };
    check("skill_forge hot execute tras refine", e2.ok && res2.result?.v === 2 && res2.result?.echo === "HOLA", JSON.stringify(e2.data ?? e2.error));

    const h = await tool("skill_forge", { op: "hot_reload", slug: "smoke-f2-skill" });
    const hd = (h.data ?? {}) as { has_handler?: boolean; reloaded?: boolean };
    check("skill_forge hot_reload", h.ok && hd.has_handler === true && hd.reloaded === true, JSON.stringify(h.data ?? h.error));

    const s = await tool("skill_forge", { op: "search", query: "smoke" });
    check("skill_forge search FTS", s.ok && (s.data as { skills: unknown[] }).skills.length >= 1, s.error);

    const bad = await tool("skill_forge", { op: "create", slug: "!!", name: "x", description: "d", instructions: "i", code: mk(9, false) });
    check("skill_forge slug inválido rechazado", bad.ok === false, bad.error);
  }

  // ── compactor ─────────────────────────────────────────────────────────────
  {
    const { estimateTokens, compactContext } = await import("../src/memory/compactor");
    check("compactor estimateTokens", estimateTokens("abcd") >= 1 && estimateTokens("") === 0);
    const many = [
      { role: "system" as const, content: "sys" },
      ...Array.from({ length: 60 }, (_, i) => ({ role: "user" as const, content: `msg ${i} ` + "x".repeat(700) })),
    ];
    const res = await compactContext(many, { budget_tokens: 10_000, keep_recent_tokens: 1_000, provider: "nvidia" });
    check("compactor compacta hilo largo", res.compacted && res.messages.length < many.length && res.messages[0]!.content.startsWith("[contexto compactado"), JSON.stringify({ c: res.compacted, n: res.messages.length, mode: res.mode }));
    const small = await compactContext([{ role: "system", content: "hola" }], { budget_tokens: 60_000 });
    check("compactor no-op bajo umbral", small.compacted === false);
  }

  // ── LOCKPACK + GATEWAY (boot real loopback) ───────────────────────────────
  section("LOCKPACK + GATEWAY (Fase 4)");
  {
    const lp = await import("../src/core/lockpack-loop");
    check("lockpack exporta runLockpack", typeof lp.runLockpack === "function");
    const am = await import("../src/core/agent");
    check("agent exporta Agent", typeof am.Agent === "function");
    const gw = await import("../src/gateway/server");
    check("gateway exporta startGateway", typeof gw.startGateway === "function");

    const handle = gw.startGateway(0);
    await new Promise((r) => setTimeout(r, 200));
    try {
      const health = await fetch("http://127.0.0.1:" + handle.port + "/health");
      const hj = (await health.json()) as { ok: boolean; tools: number };
      check("gateway /health", health.ok && hj.ok === true && hj.tools >= 11, JSON.stringify(hj).slice(0, 200));

      const ac = new AbortController();
      const sseRes = await fetch("http://127.0.0.1:" + handle.port + "/events", { signal: ac.signal });
      const reader = sseRes.body!.getReader();
      const first = await Promise.race([
        reader.read(),
        new Promise<{ value?: Uint8Array }>((r) => setTimeout(() => r({}), 2_000)),
      ]);
      const txt = first.value ? new TextDecoder().decode(first.value) : "";
      ac.abort();
      check("gateway SSE hello", sseRes.ok && txt.includes("event: hello"), txt.slice(0, 120));

      const state = await fetch("http://127.0.0.1:" + handle.port + "/api/state");
      check("gateway /api/state", state.ok && (await state.text()).includes("tools"));

      const run = await fetch("http://127.0.0.1:" + handle.port + "/api/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "agent", task: "" }),
      });
      check("gateway valida body run", run.status === 400, String(run.status));
    } finally {
      await handle.stop();
    }
  }

  // ── MCP manager (sin servidor externo) ────────────────────────────────────
  {
    const { mcpManager } = await import("../src/mcp/mcp-manager");
    check("mcpManager API", typeof mcpManager.addServer === "function" && typeof mcpManager.removeServer === "function");
    const noCfg = await mcpManager.loadConfig("/tmp/oc-smoke-no-mcp.json");
    check("mcp loadConfig inexistente → 0", noCfg.loaded === 0 && noCfg.failed.length === 0, JSON.stringify(noCfg));
    let err = "";
    try {
      await mcpManager.addServer({ name: "x", transport: "stdio" });
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
    }
    check("mcp stdio sin command rechazado", err.includes("command"), err);
    const b = await tool("mcp_bridge", { op: "list" });
    check("mcp_bridge list", b.ok && (b.data as { servers: unknown[] }).servers.length === 0, b.error);
  }

  // ── TUI: RollingThoughtBox ────────────────────────────────────────────────
  section("TUI (Fase 4)");
  {
    const { RollingThoughtBox, stripAnsi, ansiWidth, padLine } = await import("../src/cli/tui");
    const box = new RollingThoughtBox();
    box.start();
    box.push("línea uno de razonamiento");
    box.push("línea dos");
    box.push("línea tres");
    box.push("línea cuatro");
    box.push("línea cinco del proceso");
    const lines = box.render(100);
    check("tui box exactamente 4 líneas", lines.length === 4, String(lines.length));
    check("tui indicador Thinking", stripAnsi(lines[0]!).includes("Thinking..."), stripAnsi(lines[0]!));
    const hasFade = [82, 113, 161, 228].every((c) => lines.some((l) => l.includes("38;2;" + c + ";")));
    check("tui fade colors 82/113/161/228", hasFade, lines.map(stripAnsi).join("|").slice(0, 160));
    box.stop();
    const collapsed = box.render(100);
    check("tui colapso Thought for", collapsed.length === 4 && stripAnsi(collapsed[0]!).includes("Thought for") && stripAnsi(collapsed[0]!).includes("tokens"), stripAnsi(collapsed[0]!));
    check("tui ansiWidth/stripAnsi", stripAnsi("\u001b[31mabc\u001b[0m") === "abc" && ansiWidth("\u001b[31mabc\u001b[0m") === 3);
    check("tui padLine", stripAnsi(padLine("hola", 10)).length === 10);
  }
}
