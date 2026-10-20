/**
 * OpenCarls — todo_board: tablero de tareas VIVAS en bun:sqlite.
 *
 * El estado persiste entre sesiones (tabla `todos`), es visible para la TUI
 * (status bar / panel) y acompaña el bucle Lockpack (EXECUTE → hardening →
 * distilación de skills). Operaciones: add, list, update, move, delete, stats.
 */
import { z } from "zod";
import type { AnyToolDefinition, ToolResult } from "../types";
import {
  addTodo,
  deleteTodo,
  listTodos,
  todoStats,
  updateTodo,
  type TodoRow,
} from "../memory/db";

// Contrato del registry: devolver la data CRUDA; errores → throw
// (el registry envuelve con ok()/fail() y captura excepciones).
const ok = <T,>(data: T): T => data;
const fail = (message: string): never => {
  throw new Error(message);
};

const STATUS = z.enum(["open", "in_progress", "blocked", "done", "all"]);

export const todoBoardTool: AnyToolDefinition = {
  name: "todo_board",
  phase: 2,
  description:
    "Tablero de tareas vivas persistido en SQLite (visible en la TUI). " +
    "ops: add (nueva), list (por status o all), update (cambia status/título/" +
    "prioridad/detalle), move (reordena position), delete, stats. " +
    "Prioridad 0 (máx) … 4 (mín); status: open|in_progress|blocked|done.",
  inputSchema: z.object({
    op: z.enum(["add", "list", "update", "move", "delete", "stats"]),
    id: z.number().int().min(1).optional(),
    title: z.string().min(1).max(500).optional(),
    detail: z.string().max(20_000).optional(),
    status: STATUS.optional(),
    priority: z.number().int().min(0).max(4).optional(),
    tags: z.array(z.string().min(1).max(60)).max(20).optional(),
    position: z.number().int().optional(),
    limit: z.number().int().min(1).max(1_000).default(200),
  }),
  async handler(input): Promise<unknown> {
    const i = input as {
      op: "add" | "list" | "update" | "move" | "delete" | "stats";
      id?: number;
      title?: string;
      detail?: string;
      status?: TodoRow["status"] | "all";
      priority?: number;
      tags?: string[];
      position?: number;
      limit: number;
    };
    try {
      switch (i.op) {
        case "add": {
          if (!i.title) return fail("add requiere `title`");
          const id = addTodo({
            title: i.title,
            detail: i.detail,
            status: i.status === "all" ? "open" : i.status,
            priority: i.priority,
            tags: i.tags,
          });
          return ok({ added: id, todo: listTodos("all", 1_000).find((t) => t.id === id) });
        }
        case "list": {
          const rows = listTodos(i.status ?? "all", i.limit);
          const stats = todoStats();
          return ok({
            count: rows.length,
            stats,
            todos: rows.map((t) => ({
              ...t,
              tags: JSON.parse(t.tags || "[]") as string[],
            })),
            markdown: renderBoard(rows),
          });
        }
        case "update": {
          if (i.id === undefined) return fail("update requiere `id`");
          const changed = updateTodo(i.id, {
            title: i.title,
            detail: i.detail,
            status: i.status === "all" ? undefined : i.status,
            priority: i.priority,
            tags: i.tags,
          });
          if (!changed) return fail(`todo ${i.id} no encontrado o sin cambios`);
          return ok({ updated: i.id, todo: listTodos("all", 1_000).find((t) => t.id === i.id) });
        }
        case "move": {
          if (i.id === undefined || i.position === undefined) {
            return fail("move requiere `id` y `position`");
          }
          const changed = updateTodo(i.id, { position: i.position });
          if (!changed) return fail(`todo ${i.id} no encontrado`);
          return ok({ moved: i.id, position: i.position });
        }
        case "delete": {
          if (i.id === undefined) return fail("delete requiere `id`");
          const deleted = deleteTodo(i.id);
          if (!deleted) return fail(`todo ${i.id} no encontrado`);
          return ok({ deleted: i.id });
        }
        case "stats": {
          const stats = todoStats();
          const open = listTodos("open", 10);
          const inProgress = listTodos("in_progress", 10);
          return ok({
            stats,
            top_open: open.slice(0, 5).map((t) => `${t.id} · ${t.title}`),
            in_progress: inProgress.map((t) => `${t.id} · ${t.title}`),
          });
        }
        default:
          return fail(`op desconocida: ${String(i.op)}`);
      }
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
  },
} as AnyToolDefinition;

function renderBoard(rows: TodoRow[]): string {
  const ICON: Record<string, string> = {
    open: "○",
    in_progress: "◐",
    blocked: "⊘",
    done: "●",
  };
  if (rows.length === 0) return "(tablero vacío)";
  return rows
    .map((t) => {
      const pri = t.priority <= 1 ? "!" : t.priority === 2 ? "·" : " ";
      return `${ICON[t.status] ?? "○"} [${t.status.padEnd(11)}] ${pri} #${t.id} ${t.title}`;
    })
    .join("\n");
}
