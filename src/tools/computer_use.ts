/**
 * OpenCarls — computer_use: Visión Dual para control de pantalla.
 *
 * Modo 1 (NATIVO — OpenAI `computer_use_preview` / Anthropic `computer_20250124`):
 *   capturas LIMPIAS sin grilla a resolución exacta X11, `environment:"linux"`,
 *   y traducción de acciones nativas (`click`, `drag`, `keypress`, `scroll`,
 *   `type`, `wait`, …) a gnome_input/gnome_vision devolviendo el bloque
 *   `computer_call_output` con screenshot Base64.
 *
 * Modo 2 (UNIVERSAL — cualquier otro proveador/NIM): grilla graduado + crosshair
 *   (Set-of-Marks) con coordenadas normalizadas 0..1000 auto-escaladas.
 */
import { z } from "zod";
import type { AnyToolDefinition, ToolContext, ToolResult } from "../types";
import {
  gnomeVisionTool,
  gnomeVisionSchema,
  getScreenResolution,
  normalizedToPixels,
  type CoordSpace,
} from "./gnome_vision";
import { gnomeInputTool, gnomeInputSchema } from "./gnome_input";
import { detectNativeComputerUse, resolveProvider, defaultModel } from "../providers/router";

// Contrato del registry: devolver la data CRUDA; errores → throw
// (el registry envuelve con ok()/fail() y captura excepciones).
const ok = <T,>(data: T): T => data;
const fail = (message: string): never => {
  throw new Error(message);
};

export type NativeComputerAction =
  | { type: "click"; coordinate: [number, number]; button?: "left" | "right" | "middle"; clicks?: number }
  | { type: "double_click"; coordinate: [number, number] }
  | { type: "triple_click"; coordinate: [number, number] }
  | { type: "right_click"; coordinate: [number, number] }
  | { type: "drag"; start_coordinate: [number, number]; coordinate: [number, number]; button?: string }
  | { type: "key" | "keypress"; text?: string; keys?: string[] }
  | { type: "type"; text: string }
  | {
      type: "scroll";
      coordinate?: [number, number];
      direction?: "up" | "down" | "left" | "right";
      amount?: number;
      scroll_amount?: number;
      scroll_direction?: string;
    }
  | { type: "move"; coordinate: [number, number] }
  | { type: "screenshot" }
  | { type: "wait"; duration?: number }
  | { type: "hold_key"; text?: string; duration?: number };

export interface NativeComputerOutput {
  /** Bloque `computer_call_output` (OpenAI Responses). */
  output: {
    type: "computer_call_output";
    call_id?: string;
    output: { type: "screenshot"; image_url: string; detail?: string };
  };
  /** Bloque `tool_result` con imagen (Anthropic `computer_20250124`). */
  anthropic_output?: {
    type: "tool_result";
    tool_use_id: string;
    content: Array<{
      type: "image";
      source: { type: "base64"; media_type: "image/png"; data: string };
    }>;
  };
  action_result: { ok: boolean; action: string; summary: string; waited_ms: number };
  width: number;
  height: number;
}

const KEY_MAP: Record<string, string> = {
  ENTER: "Return",
  RETURN: "Return",
  ESC: "Escape",
  ESCAPE: "Escape",
  TAB: "Tab",
  SPACE: "space",
  BACKSPACE: "BackSpace",
  DELETE: "Delete",
  UP: "Up",
  DOWN: "Down",
  LEFT: "Left",
  RIGHT: "Right",
  HOME: "Home",
  END: "End",
  PAGEUP: "Page_Up",
  PAGEDOWN: "Page_Down",
  CTRL: "ctrl",
  CONTROL: "ctrl",
  ALT: "alt",
  SHIFT: "shift",
  META: "super",
  CMD: "super",
  COMMAND: "super",
  WINDOWS: "super",
  SUPER: "super",
};

/** Chord "CTRL+C" / ["ctrl","c"] / "ctrl+c" → combo xdotool ("ctrl+c"). */
export function chordToXdotool(keys: string[] | string): string {
  const parts = Array.isArray(keys)
    ? keys.flatMap((k) => k.split("+"))
    : keys.split("+");
  const mapped = parts
    .map((p) => {
      const t = p.trim();
      if (!t) return "";
      const up = t.toUpperCase();
      if (KEY_MAP[up]) return KEY_MAP[up];
      if (/^F\d{1,2}$/.test(up)) return `F${up.slice(1)}`;
      if (t.length === 1) return t.toLowerCase();
      return t.toLowerCase();
    })
    .filter(Boolean);
  return [...new Set(mapped)].join("+");
}

function resolveXY(
  action: NativeComputerAction,
  screen: { width: number; height: number },
  space: CoordSpace,
): { x: number; y: number; x2?: number; y2?: number } {
  const pick = (c?: [number, number]): { x: number; y: number } =>
    c ? normalizedToPixels(c[0], c[1], screen, space) : { x: 0, y: 0 };
  if (action.type === "drag") {
    const a = pick(action.start_coordinate);
    const b = pick(action.coordinate);
    return { x: a.x, y: a.y, x2: b.x, y2: b.y };
  }
  if ("coordinate" in action && action.coordinate) {
    return pick(action.coordinate);
  }
  return { x: 0, y: 0 };
}

const BUTTON: Record<string, number> = { left: 1, middle: 2, right: 3 };

async function takeScreenshot(
  clean: boolean,
  display: string,
): Promise<{ b64: string; width: number; height: number }> {
  const data = (await gnomeVisionTool.handler(
    gnomeVisionSchema.parse({
      op: "capture",
      ...(clean
        ? { grid: 0, clean: true, include_windows: false }
        : { grid: 64, clean: false }),
      max_width: clean ? undefined : 1_400,
      save_copy: false,
      display,
    }),
    { display },
  )) as {
    image_base64?: string;
    resized?: { width: number; height: number };
    width?: number;
    height?: number;
  };
  if (!data || typeof data !== "object" || !data.image_base64) {
    throw new Error("screenshot sin imagen");
  }
  return {
    b64: data.image_base64,
    width: data.resized?.width ?? data.width ?? 0,
    height: data.resized?.height ?? data.height ?? 0,
  };
}

/**
 * Traductor de acción nativa (OpenAI/Anthropic) → gnome_input + gnome_vision.
 * Devuelve SIEMPRE un `computer_call_output` con screenshot Base64 post-acción.
 */
export async function executeNativeComputerAction(
  action: NativeComputerAction,
  opts: {
    call_id?: string;
    tool_use_id?: string;
    display?: string;
    coord_space?: CoordSpace;
    native_provider?: "openai" | "anthropic";
  } = {},
): Promise<NativeComputerOutput> {
  const started = Date.now();
  const screen = getScreenResolution(opts.display);
  if (screen.width <= 0 || screen.height <= 0) {
    throw new Error(
      `X11 no disponible (DISPLAY=${screen.display}) — captura de pantalla imposible`,
    );
  }
  const space = opts.coord_space ?? "pixels";
  const display = opts.display ?? screen.display;
  const input = async (payload: Record<string, unknown>): Promise<unknown> => {
    const parsed = gnomeInputSchema.parse(payload);
    const r = (await gnomeInputTool.handler(parsed, { display })) as unknown;
    if (r && typeof r === "object" && "ok" in r && (r as { ok?: unknown }).ok === false) {
      throw new Error(`${String(payload.op)}: ${String((r as { error?: unknown }).error)}`);
    }
    return r;
  };

  let summary = "";
  let waited = 0;
  const xy = resolveXY(action, screen, space);

  switch (action.type) {
    case "click": {
      const clicks = action.clicks ?? 1;
      await input({
        op: "click",
        x: xy.x,
        y: xy.y,
        button: BUTTON[action.button ?? "left"] ?? 1,
        repeat: clicks,
        delay_ms: clicks > 1 ? 150 : 120,
      });
      summary = `click ${action.button ?? "left"} x${clicks} @(${xy.x},${xy.y})`;
      break;
    }
    case "double_click":
      await input({ op: "double_click", x: xy.x, y: xy.y });
      summary = `double_click @(${xy.x},${xy.y})`;
      break;
    case "triple_click":
      await input({ op: "click", x: xy.x, y: xy.y, button: 1, repeat: 3, delay_ms: 150 });
      summary = `triple_click @(${xy.x},${xy.y})`;
      break;
    case "right_click":
      await input({ op: "right_click", x: xy.x, y: xy.y });
      summary = `right_click @(${xy.x},${xy.y})`;
      break;
    case "drag":
      await input({
        op: "drag",
        x1: xy.x,
        y1: xy.y,
        x2: xy.x2 ?? xy.x,
        y2: xy.y2 ?? xy.y,
        button: BUTTON[action.button ?? "left"] ?? 1,
      });
      summary = `drag (${xy.x},${xy.y})→(${xy.x2},${xy.y2})`;
      break;
    case "key":
    case "keypress": {
      const raw = action.text ?? (action.keys ?? []).join("+");
      const combo = chordToXdotool(raw);
      await input({ op: "press_keys", keys: [combo] });
      summary = `key ${combo}`;
      break;
    }
    case "type":
      await input({ op: "type_text", text: action.text });
      summary = `type ${JSON.stringify(action.text.slice(0, 60))}`;
      break;
    case "scroll": {
      const amount = Math.max(1, Math.min(action.amount ?? action.scroll_amount ?? 5, 50));
      const dir = (action.direction ??
        (action.scroll_direction as "up" | "down" | "left" | "right" | undefined) ??
        "down") as "up" | "down" | "left" | "right";
      const payload: Record<string, unknown> = {
        op: "scroll",
        direction: dir,
        amount,
        ...(action.coordinate ? { x: xy.x, y: xy.y } : {}),
      };
      await input(payload);
      summary = `scroll ${dir} x${amount}`;
      break;
    }
    case "move":
      await input({ op: "mouse_move", x: xy.x, y: xy.y });
      summary = `move @(${xy.x},${xy.y})`;
      break;
    case "screenshot":
      summary = "screenshot";
      break;
    case "wait": {
      const secs = Math.min(Math.max(action.duration ?? 1, 0), 30);
      const t0 = Date.now();
      await new Promise((r) => setTimeout(r, secs * 1_000));
      waited = Date.now() - t0;
      summary = `wait ${secs}s`;
      break;
    }
    case "hold_key": {
      const secs = Math.min(Math.max(action.duration ?? 1, 0), 10);
      const combo = chordToXdotool(action.text ?? "SPACE");
      await input({ op: "key_down", keys: [combo] });
      await new Promise((r) => setTimeout(r, secs * 1_000));
      await input({ op: "key_up", keys: [combo] });
      waited = secs * 1_000;
      summary = `hold_key ${combo} ${secs}s`;
      break;
    }
    default:
      throw new Error(`acción no soportada: ${(action as { type: string }).type}`);
  }

  const shot = await takeScreenshot(true, display);
  const output = {
    type: "computer_call_output" as const,
    ...(opts.call_id ? { call_id: opts.call_id } : {}),
    output: {
      type: "screenshot" as const,
      image_url: `data:image/png;base64,${shot.b64}`,
      detail: "high",
    },
  };
  const anthropic_output = opts.tool_use_id
    ? {
        type: "tool_result" as const,
        tool_use_id: opts.tool_use_id,
        content: [
          {
            type: "image" as const,
            source: {
              type: "base64" as const,
              media_type: "image/png" as const,
              data: shot.b64,
            },
          },
        ],
      }
    : undefined;
  void started;
  return {
    output,
    anthropic_output,
    action_result: { ok: true, action: action.type, summary, waited_ms: waited },
    width: shot.width,
    height: shot.height,
  };
}

const actionSchema = z.union([
  z.object({
    type: z.enum(["click", "double_click", "triple_click", "right_click", "move"]),
    coordinate: z.tuple([z.number(), z.number()]),
    button: z.enum(["left", "right", "middle"]).optional(),
    clicks: z.number().int().min(1).max(3).optional(),
  }),
  z.object({
    type: z.literal("drag"),
    start_coordinate: z.tuple([z.number(), z.number()]),
    coordinate: z.tuple([z.number(), z.number()]),
    button: z.string().optional(),
  }),
  z.object({
    type: z.enum(["key", "keypress"]),
    text: z.string().optional(),
    keys: z.array(z.string()).optional(),
  }),
  z.object({ type: z.literal("type"), text: z.string().max(10_000) }),
  z.object({
    type: z.literal("scroll"),
    coordinate: z.tuple([z.number(), z.number()]).optional(),
    direction: z.enum(["up", "down", "left", "right"]).optional(),
    amount: z.number().int().min(1).max(50).optional(),
    scroll_amount: z.number().int().optional(),
    scroll_direction: z.string().optional(),
  }),
  z.object({ type: z.literal("screenshot") }),
  z.object({ type: z.literal("wait"), duration: z.number().min(0).max(30).optional() }),
  z.object({
    type: z.literal("hold_key"),
    text: z.string().optional(),
    duration: z.number().min(0).max(10).optional(),
  }),
]) as unknown as z.ZodType<NativeComputerAction>;

const computerUseSchema = z.object({
  op: z.enum(["mode", "screenshot", "execute"]),
  call_id: z.string().optional(),
  tool_use_id: z.string().optional(),
  action: actionSchema.optional(),
  coord_space: z
    .enum(["pixels", "normalized_1000", "normalized_0_1"])
    .default("pixels")
    .describe("espacio de coordenadas de `action` (modo universal usa normalized_1000)"),
  mode: z.enum(["native", "universal"]).optional().describe("fuerza modo para screenshot"),
  grid: z.number().int().min(16).max(256).optional(),
});

export type ComputerUseInput = z.infer<typeof computerUseSchema>;

function agentIdentity(ctx: ToolContext): { provider: string; model: string } {
  const cfg = resolveProvider(ctx.agent?.provider_id);
  let model: string;
  if (ctx.agent?.model) model = ctx.agent.model;
  else {
    try {
      model = defaultModel(cfg);
    } catch {
      model = "unknown";
    }
  }
  return { provider: cfg.id, model };
}

export const computerUseTool: AnyToolDefinition = {
  name: "computer_use",
  phase: 2,
  description:
    "Visión Dual de pantalla. op=mode informa proveedor nativo (openai/anthropic/" +
    "null) y resolución; op=screenshot captura limpia (nativo) o con grilla SoM " +
    "(universal); op=execute traduce acciones computer-use o coords 0..1000 y " +
    "devuelve computer_call_output con screenshot Base64 post-acción.",
  inputSchema: computerUseSchema,
  async handler(rawInput, ctx): Promise<unknown> {
    const parsed = rawInput as ComputerUseInput;
    const { provider, model } = agentIdentity(ctx);
    const native = detectNativeComputerUse(provider, model);
    const display = ctx.display;
    const screen = getScreenResolution(display);

    if (parsed.op === "mode") {
      return ok({
        native_provider: native,
        mode: native ? "native" : "universal",
        environment: "linux",
        provider,
        model,
        screen: { width: screen.width, height: screen.height, display: screen.display },
        note:
          native === "openai"
            ? "capturas clean sin grilla; environment=linux"
            : native === "anthropic"
              ? "computer_20250124; extended_thinking round-trip"
              : "modo universal: grilla SoM + coords 0..1000 auto-escaladas",
      });
    }

    if (parsed.op === "screenshot") {
      const useNativeClean = (parsed.mode ?? "universal") === "native" && native !== null;
      const payload = (await gnomeVisionTool.handler(
        gnomeVisionSchema.parse({
          op: "capture",
          ...(useNativeClean
            ? { grid: 0, clean: true, include_windows: false, max_width: undefined }
            : { grid: parsed.grid ?? 64, clean: false, include_windows: true, max_width: 1_400 }),
          save_copy: false,
          ...(display ? { display } : {}),
        }),
        { display: ctx.display },
      )) as Record<string, unknown>;
      return ok({
        ...payload,
        mode: useNativeClean ? "native" : "universal",
        environment: "linux",
        screen: { width: screen.width, height: screen.height },
      });
    }

    // op === execute
    if (!parsed.action) return fail("execute requiere `action`");
    if (screen.width <= 0 || screen.height <= 0) {
      return fail(
        `X11 no disponible (DISPLAY=${screen.display}) — instala/activa X11 o usa bash_session`,
      );
    }
    try {
      const result = await executeNativeComputerAction(parsed.action, {
        call_id: parsed.call_id,
        tool_use_id: parsed.tool_use_id,
        display,
        coord_space: parsed.coord_space,
        native_provider: native ?? undefined,
      });
      let som: Record<string, unknown> | null = null;
      if (!native) {
        const cap = (await gnomeVisionTool.handler(
          gnomeVisionSchema.parse({
            op: "capture",
            grid: parsed.grid ?? 64,
            clean: false,
            include_windows: true,
            max_width: 1_400,
            save_copy: false,
            ...(display ? { display } : {}),
          }),
          { display: ctx.display },
        )) as Record<string, unknown>;
        if (cap && typeof cap.image_base64 === "string") som = cap;
      }
      return ok({
        native_provider: native,
        mode: native ? "native" : "universal",
        action_result: result.action_result,
        computer_call_output: result.output,
        ...(result.anthropic_output ? { anthropic_tool_result: result.anthropic_output } : {}),
        screenshot: {
          width: result.width,
          height: result.height,
          base64_len: result.output.output.image_url.length,
        },
        ...(som ? { next_som: { image_base64: som.image_base64, cells: som.cells } } : {}),
      });
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
  },
} as AnyToolDefinition;
