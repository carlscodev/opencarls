/**
 * OpenCarls — MCP Manager: puente JSON-RPC 2.0 hacia servidores MCP.
 *
 * Soporta tres transports:
 *   - stdio  : spawn del servidor (command+args+env)
 *   - http   : Streamable HTTP (POST/GET con sesiones)
 *   - sse    : SSE clásico (GET events + POST messages)
 *
 * Descubre `tools/list` de cada servidor y las INYECTA en el ToolRegistry
 * nativo con prefijo `mcp__<server>__<tool>` (alta/baja en caliente: al
 * desconectar se `unregisterTool` de inmediato).
 *
 * Config: mcp_config.json (formato estándar { "mcpServers": { name: {...} } })
 * o alta manual vía mcp_bridge.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { CONFIG } from "../core/config";
import { createLogger } from "../core/logger";
import { registerTool, unregisterTool, getTool } from "../tools/registry";
import type { AnyToolDefinition, ToolResult } from "../types";
import { ok, fail } from "../types";

const log = createLogger("mcp");

export type McpTransportKind = "stdio" | "http" | "sse";

export interface McpServerConfig {
  /** id único (nombre lógico) */
  name: string;
  transport: McpTransportKind;
  /** stdio */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** http/sse */
  url?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
}

export interface McpToolInfo {
  server: string;
  name: string;
  qualified: string;
  description: string;
  inputSchema: unknown;
}

interface ConnectedServer {
  cfg: McpServerConfig;
  client: Client;
  transport: StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport;
  tools: McpToolInfo[];
}

/** Validador JSON-Schema mínimo (required/properties/type) p/ tools MCP. */
function validateJsonSchema(schema: unknown, input: unknown): string | null {
  if (!schema || typeof schema !== "object") return null;
  const s = schema as {
    type?: string;
    required?: string[];
    properties?: Record<string, { type?: string; enum?: unknown[] }>;
  };
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return s.type === "object" || s.required ? "se esperaba un objeto" : null;
  }
  const obj = input as Record<string, unknown>;
  if (Array.isArray(s.required)) {
    for (const key of s.required) {
      if (obj[key] === undefined) return `falta el campo requerido: ${key}`;
    }
  }
  for (const [key, def] of Object.entries(s.properties ?? {})) {
    const v = obj[key];
    if (v === undefined || !def) continue;
    if (def.enum && !def.enum.includes(v)) {
      return `${key}: valor fuera de enum (${def.enum.map(String).join(", ")})`;
    }
    if (def.type === "string" && typeof v !== "string") return `${key} debe ser string`;
    if (def.type === "number" && typeof v !== "number") return `${key} debe ser number`;
    if (def.type === "boolean" && typeof v !== "boolean") return `${key} debe ser boolean`;
    if (def.type === "array" && !Array.isArray(v)) return `${key} debe ser array`;
    if (def.type === "object" && (typeof v !== "object" || v === null || Array.isArray(v))) {
      return `${key} debe ser object`;
    }
  }
  return null;
}

function qualify(server: string, tool: string): string {
  return `mcp__${server}__${tool}`;
}

/** Convierte el resultado MCP a payload JSON-serializable. */
function mcpResultToData(result: unknown): unknown {
  const r = result as {
    content?: Array<{ type: string; text?: string; data?: string; mimeType?: string; resource?: { text?: string; uri?: string } }>;
    isError?: boolean;
    structuredContent?: unknown;
  };
  if (r.structuredContent !== undefined && r.structuredContent !== null) {
    return r.structuredContent;
  }
  const parts = (r.content ?? []).map((c) => {
    if (c.type === "text") return c.text ?? "";
    if (c.type === "image") return `[image ${c.mimeType ?? "image/*"} ${c.data ? `${c.data.length}b b64` : ""}]`;
    if (c.type === "resource") return c.resource?.text ?? `[resource ${c.resource?.uri ?? ""}]`;
    return `[${c.type}]`;
  });
  return { text: parts.join("\n"), is_error: Boolean(r.isError), parts: r.content?.length ?? 0 };
}

class McpManager {
  private servers = new Map<string, ConnectedServer>();

  /** Alta de servidor + descubrimiento de tools + inyección en el registry. */
  async addServer(cfg: McpServerConfig): Promise<{ tools: McpToolInfo[] }> {
    if (this.servers.has(cfg.name)) {
      throw new Error(`servidor MCP ya conectado: ${cfg.name} (usa remove primero)`);
    }
    if (cfg.transport === "stdio" && !cfg.command) {
      throw new Error("transport stdio requiere `command`");
    }
    if ((cfg.transport === "http" || cfg.transport === "sse") && !cfg.url) {
      throw new Error(`transport ${cfg.transport} requiere ` + "`url`");
    }

    const client = new Client(
      { name: "opencarls", version: CONFIG.daemon.version },
      { capabilities: {} },
    );

    let transport: ConnectedServer["transport"];
    if (cfg.transport === "stdio") {
      transport = new StdioClientTransport({
        command: cfg.command!,
        args: cfg.args ?? [],
        env: { ...(process.env as Record<string, string>), ...(cfg.env ?? {}) },
        cwd: cfg.cwd ?? CONFIG.project_root,
        stderr: "pipe",
      });
      transport.onerror = (err) => log.warn(`stdio error en ${cfg.name}`, { err: String(err) });
    } else if (cfg.transport === "sse") {
      transport = new SSEClientTransport(new URL(cfg.url!), {
        requestInit: { headers: cfg.headers ?? {} },
      });
    } else {
      transport = new StreamableHTTPClientTransport(new URL(cfg.url!), {
        requestInit: { headers: cfg.headers ?? {} },
      });
    }

    await client.connect(transport);
    const listed = await client.listTools();
    const tools: McpToolInfo[] = (listed.tools ?? []).map((t) => ({
      server: cfg.name,
      name: t.name,
      qualified: qualify(cfg.name, t.name),
      description: (t.description ?? "").slice(0, 2_000),
      inputSchema: t.inputSchema ?? { type: "object", properties: {} },
    }));

    for (const t of tools) this.inject(t, client);
    this.servers.set(cfg.name, { cfg: { ...cfg }, client, transport, tools });
    log.info(`MCP ${cfg.name} conectado`, { transport: cfg.transport, tools: tools.length });
    return { tools };
  }

  private inject(t: McpToolInfo, client: Client): void {
    const def: AnyToolDefinition = {
      name: t.qualified,
      phase: 3,
      description: `[MCP:${t.server}] ${t.description || t.name}`,
      // validación real = JSON Schema del servidor (zod passthrough)
      inputSchema: z_unknown(),
      jsonSchema: t.inputSchema,
      async handler(input): Promise<ToolResult> {
        const invalid = validateJsonSchema(t.inputSchema, input);
        if (invalid) return fail(`input inválido para ${t.qualified}: ${invalid}`);
        try {
          const res = await client.callTool({ name: t.name, arguments: (input ?? {}) as Record<string, unknown> });
          if ((res as { isError?: boolean }).isError) {
            const data = mcpResultToData(res);
            const text = typeof data === "object" && data && "text" in data
              ? String((data as { text: unknown }).text)
              : JSON.stringify(data);
            return fail(`MCP ${t.qualified}: ${text.slice(0, 800)}`);
          }
          return ok(mcpResultToData(res));
        } catch (e) {
          return fail(`MCP ${t.qualified}: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
    };
    registerTool(def);
  }

  /** Baja en caliente: desconecta y purga sus tools del registry. */
  async removeServer(name: string): Promise<{ removed: number }> {
    const s = this.servers.get(name);
    if (!s) throw new Error(`servidor MCP no conectado: ${name}`);
    let removed = 0;
    for (const t of s.tools) {
      if (getTool(t.qualified)) {
        unregisterTool(t.qualified);
        removed++;
      }
    }
    this.servers.delete(name);
    try {
      await s.client.close();
    } catch {
      /* transporte ya caído */
    }
    log.info(`MCP ${name} desconectado`, { removed });
    return { removed };
  }

  listServers(): Array<{
    name: string;
    transport: McpTransportKind;
    url?: string | undefined;
    command?: string | undefined;
    tools: number;
    connected: boolean;
  }> {
    return [...this.servers.values()].map((s) => ({
      name: s.cfg.name,
      transport: s.cfg.transport,
      url: s.cfg.url,
      command: s.cfg.command,
      tools: s.tools.length,
      connected: true,
    }));
  }

  listTools(server?: string): McpToolInfo[] {
    const all = [...this.servers.values()].flatMap((s) => s.tools);
    return server ? all.filter((t) => t.server === server) : all;
  }

  callTool(qualified: string, args: unknown): Promise<unknown> {
    const serverName = qualified.startsWith("mcp__")
      ? qualified.split("__")[1] ?? ""
      : "";
    const s = this.servers.get(serverName);
    if (!s) throw new Error(`servidor MCP desconocido: ${serverName}`);
    const tool = s.tools.find((t) => t.qualified === qualified || t.name === qualified);
    if (!tool) throw new Error(`tool MCP desconocida: ${qualified}`);
    const invalid = validateJsonSchema(tool.inputSchema, args);
    if (invalid) throw new Error(invalid);
    return s.client
      .callTool({ name: tool.name, arguments: (args ?? {}) as Record<string, unknown> })
      .then(mcpResultToData);
  }

  /** Carga/reload de mcp_config.json (formato estándar {mcpServers:{…}}). */
  async loadConfig(path = CONFIG.mcp_config_path): Promise<{
    loaded: number;
    failed: Array<{ name: string; error: string }>;
  }> {
    if (!existsSync(path)) return { loaded: 0, failed: [] };
    const raw = JSON.parse(readFileSync(path, "utf8")) as {
      mcpServers?: Record<string, Record<string, unknown>>;
    };
    const entries = Object.entries(raw.mcpServers ?? {});
    let loaded = 0;
    const failed: Array<{ name: string; error: string }> = [];
    for (const [name, def] of entries) {
      if (def.enabled === false) continue;
      if (this.servers.has(name)) continue; // ya activo
      try {
        await this.addServer(normalizeCfg(name, def));
        loaded++;
      } catch (e) {
        failed.push({ name, error: e instanceof Error ? e.message : String(e) });
        log.warn(`MCP config: fallo al conectar ${name}`, { err: failed[failed.length - 1]!.error });
      }
    }
    return { loaded, failed };
  }

  /** Relee la config: conecta nuevas, desconecta las que desaparecieron. */
  async reloadConfig(path = CONFIG.mcp_config_path): Promise<{
    added: string[];
    removed: string[];
    failed: Array<{ name: string; error: string }>;
  }> {
    const added: string[] = [];
    const removed: string[] = [];
    const failed: Array<{ name: string; error: string }> = [];
    let cfgNames = new Set<string>();
    if (existsSync(path)) {
      try {
        const raw = JSON.parse(readFileSync(path, "utf8")) as {
          mcpServers?: Record<string, Record<string, unknown>>;
        };
        for (const [name, def] of Object.entries(raw.mcpServers ?? {})) {
          if (def.enabled === false) continue;
          cfgNames.add(name);
          if (this.servers.has(name)) continue;
          try {
            await this.addServer(normalizeCfg(name, def));
            added.push(name);
          } catch (e) {
            failed.push({ name, error: e instanceof Error ? e.message : String(e) });
          }
        }
      } catch (e) {
        failed.push({ name: "(config)", error: e instanceof Error ? e.message : String(e) });
      }
    }
    for (const name of [...this.servers.keys()]) {
      if (!cfgNames.has(name)) {
        await this.removeServer(name);
        removed.push(name);
      }
    }
    return { added, removed, failed };
  }

  async shutdown(): Promise<void> {
    for (const name of [...this.servers.keys()]) {
      try {
        await this.removeServer(name);
      } catch {
        /* best-effort */
      }
    }
  }

  /** Persiste la config actual en mcp_config.json (formato estándar). */
  saveConfig(path = CONFIG.mcp_config_path): { path: string; servers: number } {
    const mcpServers: Record<string, unknown> = {};
    for (const s of this.servers.values()) {
      const def: Record<string, unknown> =
        s.cfg.transport === "stdio"
          ? { command: s.cfg.command, args: s.cfg.args ?? [], env: s.cfg.env ?? {} }
          : { transport: s.cfg.transport, url: s.cfg.url, headers: s.cfg.headers ?? {} };
      mcpServers[s.cfg.name] = def;
    }
    const current = existsSync(path)
      ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>)
      : {};
    current.mcpServers = { ...((current.mcpServers as Record<string, unknown>) ?? {}), ...mcpServers };
    writeFileSync(path, JSON.stringify(current, null, 2) + "\n", "utf8");
    return { path, servers: this.servers.size };
  }
}

function normalizeCfg(name: string, def: Record<string, unknown>): McpServerConfig {
  if (typeof def.command === "string") {
    return {
      name,
      transport: "stdio",
      command: def.command,
      args: Array.isArray(def.args) ? def.args.map(String) : [],
      env: (def.env as Record<string, string> | undefined) ?? {},
      cwd: typeof def.cwd === "string" ? def.cwd : undefined,
      enabled: def.enabled !== false,
    };
  }
  const url = typeof def.url === "string" ? def.url : undefined;
  if (!url) throw new Error(`config de '${name}' sin command ni url`);
  const transport: McpTransportKind =
    def.transport === "sse" || String(url).includes("/sse") ? "sse" : "http";
  return {
    name,
    transport,
    url,
    headers: (def.headers as Record<string, string> | undefined) ?? {},
    enabled: def.enabled !== false,
  };
}

/** zod passthrough: la validación real usa jsonSchema (JSON Schema del MCP). */
function z_unknown(): z.ZodTypeAny {
  return z.unknown();
}

export const mcpManager = new McpManager();
