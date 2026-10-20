/**
 * OpenCarls — Gateway: servidor HTTP + SSE + WebSocket (Bun.serve).
 *
 * Rutas:
 *   GET  /health            estado vivo (proveedores, tools, uptime)
 *   GET  /api/state         estado agregado (todos, skills, tools, runs)
 *   GET  /api/tools|/api/skills|/api/todos    catálogos
 *   POST /api/run           lanza un run (agent|lockpack) en background
 *   GET  /api/runs          lista de runs
 *   GET  /api/runs/:id      reporte de un run
 *   GET  /events            SSE en vivo (phase/reasoning/text/tool/log)
 *   WS   /ws                mismos eventos + {"cmd":"run"} entrante
 *
 * CORS abierto (entorno aislado), heartbeat SSE cada 15 s, eventos con
 * buffer de últimos 500 por run para reconexiones.
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { CONFIG } from "../core/config";
import { createLogger } from "../core/logger";
import { Agent, type AgentEvent } from "../core/agent";
import { runLockpack, type LockpackEvent, type LockpackReport } from "../core/lockpack-loop";
import { listTools } from "../tools/registry";
import { listSkills, listTodos, todoStats } from "../memory/db";
import { providerStatus } from "../providers/router";

const log = createLogger("gateway");

// ── Estado de runs ──────────────────────────────────────────────────────────

export type RunKind = "agent" | "lockpack";

export interface RunRecord {
  id: string;
  kind: RunKind;
  task: string;
  target_dir?: string;
  status: "running" | "done" | "error";
  started_at: number;
  finished_at?: number;
  events: unknown[];
  report?: LockpackReport | { final_text: string; iterations: number; tool_calls: number; stopped: string; error?: string };
  error?: string;
}

const runs = new Map<string, RunRecord>();
type Sub = (ev: Record<string, unknown>) => void;
const subs = new Set<Sub>();

export function broadcast(ev: Record<string, unknown>): void {
  for (const fn of subs) {
    try {
      fn(ev);
    } catch {
      /* sub caído */
    }
  }
}

function pushEvent(run: RunRecord, ev: Record<string, unknown>): void {
  const wrapped = { run_id: run.id, ts: Date.now(), ...ev };
  run.events.push(wrapped);
  if (run.events.length > 500) run.events.splice(0, run.events.length - 500);
  broadcast(wrapped);
}

const runBody = z.object({
  mode: z.enum(["agent", "lockpack"]).default("lockpack"),
  task: z.string().min(3).max(20_000),
  target_dir: z.string().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  verify_cmd: z.string().max(500).optional(),
  max_cycles: z.number().int().min(1).max(50).optional(),
  critique_target: z.number().min(0).max(10).optional(),
  visual: z.boolean().optional(),
});

export type RunBody = z.infer<typeof runBody>;

export async function startRun(body: RunBody): Promise<RunRecord> {
  const id = randomUUID().slice(0, 8);
  const rec: RunRecord = {
    id,
    kind: body.mode,
    task: body.task,
    target_dir: body.target_dir,
    status: "running",
    started_at: Date.now(),
    events: [],
  };
  runs.set(id, rec);
  pushEvent(rec, { type: "log", message: `run ${id} iniciado (${body.mode})` });

  void (async () => {
    try {
      if (body.mode === "lockpack") {
        const target = body.target_dir ?? join("/tmp", "opencarls-demo");
        const report = await runLockpack({
          task: body.task,
          target_dir: target,
          provider: body.provider,
          model: body.model,
          verify_cmd: body.verify_cmd,
          max_cycles: body.max_cycles,
          critique_target: body.critique_target,
          visual: body.visual,
          onEvent: (ev: LockpackEvent) => pushEvent(rec, ev as unknown as Record<string, unknown>),
        });
        rec.report = report;
        rec.status = "done";
      } else {
        const agent = new Agent({
          provider: body.provider,
          model: body.model,
          max_iterations: 30,
          onEvent: (ev: AgentEvent) => pushEvent(rec, { type: "agent", agent: ev }),
        });
        const res = await agent.run(body.task);
        rec.report = {
          final_text: res.final_text,
          iterations: res.iterations,
          tool_calls: res.tool_calls,
          stopped: res.stopped,
          error: res.error,
        };
        rec.status = res.stopped === "error" ? "error" : "done";
        rec.error = res.error;
      }
    } catch (e) {
      rec.status = "error";
      rec.error = e instanceof Error ? e.message : String(e);
      pushEvent(rec, { type: "log", message: `error: ${rec.error}` });
    } finally {
      rec.finished_at = Date.now();
      pushEvent(rec, { type: "log", message: `run ${id} ${rec.status}` });
    }
  })();

  return rec;
}

// ── HTTP helpers ────────────────────────────────────────────────────────────

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type, authorization",
      "access-control-allow-methods": "GET, POST, OPTIONS",
    },
  });
}

function sseHeaders(): Record<string, string> {
  return {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "access-control-allow-origin": "*",
    "x-accel-buffering": "no",
  };
}

const startedAt = Date.now();

async function handleApi(pathname: string, req: Request): Promise<Response | null> {
  if (pathname === "/health") {
    return json({
      ok: true,
      name: CONFIG.daemon.name,
      version: CONFIG.daemon.version,
      uptime_s: Math.round((Date.now() - startedAt) / 1000),
      providers: providerStatus(),
      tools: listTools().length,
      runs: runs.size,
      todos: todoStats(),
    });
  }
  if (pathname === "/api/state") {
    return json({
      tools: listTools().map((t) => ({ name: t.name, phase: t.phase ?? 1 })),
      skills: listSkills(undefined, 50).map((s) => ({
        slug: s.slug,
        name: s.name,
        version: s.version,
        status: s.status,
        success_count: s.success_count,
        fail_count: s.fail_count,
      })),
      todos: listTodos("all", 100),
      todo_stats: todoStats(),
      runs: [...runs.values()].map((r) => ({
        id: r.id,
        kind: r.kind,
        status: r.status,
        started_at: r.started_at,
        task: r.task.slice(0, 200),
      })),
      providers: providerStatus(),
    });
  }
  if (pathname === "/api/tools") return json(listTools().map((t) => ({ name: t.name, description: t.description, phase: t.phase ?? 1 })));
  if (pathname === "/api/skills") return json(listSkills(undefined, 100));
  if (pathname === "/api/todos") return json({ stats: todoStats(), todos: listTodos("all", 500) });
  if (pathname === "/api/runs" && req.method === "GET") {
    return json(
      [...runs.values()].map((r) => ({
        id: r.id,
        kind: r.kind,
        status: r.status,
        task: r.task.slice(0, 300),
        started_at: r.started_at,
        finished_at: r.finished_at,
        events: r.events.length,
        error: r.error,
      })),
    );
  }
  const m = /^\/api\/runs\/([a-zA-Z0-9-]+)$/.exec(pathname);
  if (m && req.method === "GET") {
    const rec = runs.get(m[1]!);
    if (!rec) return json({ error: "run no encontrado" }, 404);
    return json(rec);
  }
  if (pathname === "/api/run" && req.method === "POST") {
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return json({ error: "body JSON inválido" }, 400);
    }
    const parsed = runBody.safeParse(raw);
    if (!parsed.success) {
      return json({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }, 400);
    }
    const rec = await startRun(parsed.data);
    return json({ run_id: rec.id, kind: rec.kind, status: rec.status }, 202);
  }
  return null;
}

// ── Servidor ────────────────────────────────────────────────────────────────

interface WsClient {
  send(data: string): void;
  readyState: number;
}

const wsClients = new Set<WsClient>();

export interface GatewayHandle {
  port: number;
  stop(): Promise<void> | void;
}

export function startGateway(port = Number(process.env.OPENCARLS_GATEWAY_PORT ?? 4123)): GatewayHandle {
  const server = Bun.serve<unknown, string>({
    port,
    hostname: "0.0.0.0",
    idleTimeout: 0, // SSE/WS largos
    async fetch(req, server) {
      const url = new URL(req.url);
      const pathname = url.pathname;

      if (req.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: {
            "access-control-allow-origin": "*",
            "access-control-allow-headers": "content-type, authorization",
            "access-control-allow-methods": "GET, POST, OPTIONS",
          },
        });
      }

      // WebSocket
      if (pathname === "/ws") {
        const upgraded = server.upgrade(req, { data: {} });
        if (upgraded) return undefined as unknown as Response;
        return json({ error: "ws upgrade falló" }, 400);
      }

      // SSE
      if (pathname === "/events" && req.method === "GET") {
        let cleanup: (() => void) | null = null;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const enc = new TextEncoder();
            const send = (ev: Record<string, unknown>): void => {
              try {
                controller.enqueue(enc.encode(`event: ${ev.type ?? "message"}\ndata: ${JSON.stringify(ev)}\n\n`));
              } catch {
                /* cerrado */
              }
            };
            const sub: Sub = (ev) => send(ev);
            subs.add(sub);
            send({ type: "hello", ts: Date.now(), runs: runs.size });
            const hb = setInterval(() => {
              try {
                controller.enqueue(enc.encode(`: hb ${Date.now()}\n\n`));
              } catch {
                /* cerrado */
              }
            }, 15_000);
            cleanup = () => {
              subs.delete(sub);
              clearInterval(hb);
              try {
                controller.close();
              } catch {
                /* ya cerrado */
              }
            };
            (req.signal as AbortSignal).addEventListener("abort", () => cleanup?.(), { once: true });
          },
          cancel() {
            cleanup?.();
          },
        });
        return new Response(stream, { headers: sseHeaders() });
      }

      // API
      const api = await handleApi(pathname, req);
      if (api) return api;

      // Índice informativo
      if (pathname === "/" || pathname === "/index.html") {
        return new Response(
          `OpenCarls Gateway ✓  ${CONFIG.daemon.name} v${CONFIG.daemon.version}\n` +
            `GET /health · /api/state · /api/runs · /events (SSE) · WS /ws · POST /api/run\n`,
          { headers: { "content-type": "text/plain; charset=utf-8", "access-control-allow-origin": "*" } },
        );
      }
      return json({ error: `ruta no encontrada: ${pathname}` }, 404);
    },
    websocket: {
      open(ws) {
        wsClients.add(ws as unknown as WsClient);
        ws.send(JSON.stringify({ type: "hello", ts: Date.now() }));
      },
      message(ws, data) {
        // {"cmd":"run", ...body} o {"cmd":"ping"}
        void (async () => {
          try {
            const msg = JSON.parse(String(data)) as { cmd?: string } & Partial<RunBody>;
            if (msg.cmd === "ping") {
              ws.send(JSON.stringify({ type: "pong", ts: Date.now() }));
              return;
            }
            if (msg.cmd === "run") {
              const parsed = runBody.safeParse({ ...msg, cmd: undefined });
              if (!parsed.success) {
                ws.send(JSON.stringify({ type: "error", error: parsed.error.message }));
                return;
              }
              const rec = await startRun(parsed.data);
              ws.send(JSON.stringify({ type: "run_started", run_id: rec.id }));
              return;
            }
            if (msg.cmd === "state") {
              ws.send(
                JSON.stringify({
                  type: "state",
                  todos: listTodos("all", 50),
                  runs: [...runs.values()].map((r) => ({ id: r.id, status: r.status, kind: r.kind })),
                }),
              );
            }
          } catch (e) {
            ws.send(JSON.stringify({ type: "error", error: String(e) }));
          }
        })();
      },
      close(ws) {
        wsClients.delete(ws as unknown as WsClient);
      },
    },
  });

  // Fan-out: subs → WS
  subs.add((ev) => {
    const data = JSON.stringify(ev);
    for (const c of wsClients) {
      try {
        if (c.readyState === 1) c.send(data);
      } catch {
        /* cliente caído */
      }
    }
  });

  log.info(`gateway escuchando en :${server.port}`, {
    url: `http://0.0.0.0:${server.port}`,
    tools: listTools().length,
    db: existsSync(CONFIG.db_path),
  });

  return {
    port: server.port ?? port,
    stop: () => server.stop(true),
  };
}

// Auto-arranque si se ejecuta directamente
if (import.meta.main) {
  const handle = startGateway();
  console.error(`OpenCarls Gateway → http://localhost:${handle.port}  (SSE /events · WS /ws)`);
}
