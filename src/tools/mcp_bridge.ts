/**
 * OpenCarls — mcp_bridge: herramienta para el agente sobre el McpManager.
 *
 * ops: add_server (alta en caliente + descubre tools y las inyecta en el
 * registry), remove (baja en caliente), list (servidores+tools), call
 * (invoca tool MCP), reload_config (relee mcp_config.json),
 * save_config (persiste alta manual). JSON-RPC 2.0 vía SDK oficial
 * (stdio + Streamable HTTP + SSE).
 */
import { z } from "zod";
import type { AnyToolDefinition, ToolResult } from "../types";
import { mcpManager, type McpTransportKind } from "../mcp/mcp-manager";

// Contrato del registry: devolver la data CRUDA; errores → throw
// (el registry envuelve con ok()/fail() y captura excepciones).
const ok = <T,>(data: T): T => data;
const fail = (message: string): never => {
  throw new Error(message);
};

export const mcpBridgeTool: AnyToolDefinition = {
  name: "mcp_bridge",
  phase: 3,
  description:
    "Puente MCP (JSON-RPC 2.0). ops: add_server (stdio/http/sse; descubre " +
    "tools/list y las inyecta como mcp__<server>__<tool> en caliente), " +
    "remove (desconecta y purga), list (servidores + tools), call (invoca), " +
    "reload_config (sync con mcp_config.json), save_config (persiste).",
  inputSchema: z.object({
    op: z.enum(["add_server", "remove", "list", "call", "reload_config", "save_config"]),
    name: z.string().min(1).max(64).optional(),
    transport: z.enum(["stdio", "http", "sse"]).optional(),
    command: z.string().min(1).optional(),
    args: z.array(z.string()).max(64).optional(),
    env: z.record(z.string()).optional(),
    cwd: z.string().optional(),
    url: z.string().url().optional(),
    headers: z.record(z.string()).optional(),
    tool: z.string().min(1).max(200).optional().describe("para op=call: mcp__srv__tool"),
    tool_input: z.record(z.unknown()).optional().describe("payload para op=call"),
    server: z.string().min(1).max(64).optional().describe("filtro de list"),
  }),
  async handler(input): Promise<unknown> {
    const i = input as {
      op: "add_server" | "remove" | "list" | "call" | "reload_config" | "save_config";
      name?: string;
      transport?: McpTransportKind;
      command?: string;
      args?: string[];
      env?: Record<string, string>;
      cwd?: string;
      url?: string;
      headers?: Record<string, string>;
      tool?: string;
      tool_input?: Record<string, unknown>;
      server?: string;
    };
    try {
      switch (i.op) {
        case "add_server": {
          if (!i.name) return fail("add_server requiere `name`");
          const transport: McpTransportKind =
            i.transport ?? (i.command ? "stdio" : i.url && i.url.includes("/sse") ? "sse" : i.url ? "http" : "stdio");
          const r = await mcpManager.addServer({
            name: i.name,
            transport,
            command: i.command,
            args: i.args,
            env: i.env,
            cwd: i.cwd,
            url: i.url,
            headers: i.headers,
          });
          return ok({
            server: i.name,
            transport,
            injected: r.tools.map((t) => t.qualified),
            count: r.tools.length,
            note: r.tools.length === 0 ? "conectado sin tools" : "tools inyectadas en el registry",
          });
        }
        case "remove": {
          if (!i.name) return fail("remove requiere `name`");
          const r = await mcpManager.removeServer(i.name);
          return ok({ server: i.name, unregistered: r.removed });
        }
        case "list": {
          const servers = mcpManager.listServers();
          const tools = mcpManager.listTools(i.server);
          return ok({
            servers,
            tools: tools.map((t) => ({
              qualified: t.qualified,
              server: t.server,
              name: t.name,
              description: t.description.slice(0, 200),
            })),
            count: tools.length,
          });
        }
        case "call": {
          if (!i.tool) return fail("call requiere `tool`");
          const data = await mcpManager.callTool(i.tool, i.tool_input ?? {});
          return ok({ tool: i.tool, data });
        }
        case "reload_config": {
          const r = await mcpManager.reloadConfig();
          return ok(r);
        }
        case "save_config": {
          const r = mcpManager.saveConfig();
          return ok(r);
        }
        default:
          return fail(`op desconocida: ${String(i.op)}`);
      }
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
  },
} as AnyToolDefinition;
