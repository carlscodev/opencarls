/**
 * OpenCarls — Herramienta 4: `gnome_input`.
 *
 * Control físico del escritorio X11/GNOME vía `xdotool` / `wmctrl`:
 * click / double_click / right_click / drag / type_text / press_keys /
 * scroll / window_focus + helpers de estado (cursor, pantalla, ventanas).
 * Sin confirmaciones: cada acción se ejecuta en el acto.
 */
import { z } from "zod";
import { CONFIG } from "../core/config";
import { createLogger } from "../core/logger";
import { runSync } from "../util/proc";
import type { ToolDefinition } from "../types";

const log = createLogger("tool:gnome_input");

const COORD_MIN = -100_000;
const COORD_MAX = 100_000;

function resolveDisplay(override?: string): string {
  return override ?? process.env.DISPLAY ?? CONFIG.display;
}

function xdo(args: string[], display: string, timeoutMs = 8_000) {
  void timeoutMs; // runSync no expone timeout; operaciones X11 son síncronas cortas
  const r = runSync(["xdotool", ...args], { env: { DISPLAY: display }, max_bytes: 64 * 1024 });
  if (r.exit_code !== 0 && r.exit_code !== null) {
    throw new Error(
      `xdotool ${args[0] ?? ""} falló (exit=${r.exit_code}): ${(r.stderr || r.stdout).trim().slice(0, 300)}`,
    );
  }
  return r;
}

function wm(args: string[], display: string) {
  const r = runSync(["wmctrl", ...args], { env: { DISPLAY: display }, max_bytes: 64 * 1024 });
  return r;
}

/** Mover el cursor (sync) si se proporcionan coordenadas. */
function moveIf(display: string, x?: number, y?: number): void {
  if (x !== undefined && y !== undefined) {
    xdo(["mousemove", "--sync", String(Math.round(x)), String(Math.round(y))], display);
  }
}

// ══════════════════════════════════════════════ SCHEMA + TOOL ══════════════

const xy = { x: z.number().int().min(COORD_MIN).max(COORD_MAX).optional(), y: z.number().int().min(COORD_MIN).max(COORD_MAX).optional() };

const clickOp = z.object({
  op: z.literal("click"),
  ...xy,
  button: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(1),
  repeat: z.number().int().min(1).max(10).default(1),
  delay_ms: z.number().int().min(0).max(2_000).default(120),
});

const doubleClickOp = z.object({
  op: z.literal("double_click"),
  ...xy,
  delay_ms: z.number().int().min(50).max(2_000).default(150),
});

const rightClickOp = z.object({ op: z.literal("right_click"), ...xy });

const dragOp = z.object({
  op: z.literal("drag"),
  x1: z.number().int().min(COORD_MIN).max(COORD_MAX),
  y1: z.number().int().min(COORD_MIN).max(COORD_MAX),
  x2: z.number().int().min(COORD_MIN).max(COORD_MAX),
  y2: z.number().int().min(COORD_MIN).max(COORD_MAX),
  button: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(1),
  steps: z.number().int().min(1).max(60).default(10),
  step_delay_ms: z.number().int().min(0).max(500).default(25),
});

const typeTextOp = z.object({
  op: z.literal("type_text"),
  text: z.string().min(1).max(100_000),
  delay_ms: z.number().int().min(0).max(500).default(14),
  clear_modifiers: z.boolean().default(true),
});

const pressKeysOp = z.object({
  op: z.literal("press_keys"),
  keys: z
    .array(z.string().regex(/^[A-Za-z0-9_+\-]+$/, "combo inválido: usa 'ctrl+alt+t', 'super', 'Return'"))
    .min(1)
    .max(20),
  delay_ms: z.number().int().min(0).max(2_000).default(60),
  clear_modifiers: z.boolean().default(true),
});

const scrollOp = z.object({
  op: z.literal("scroll"),
  ...xy,
  direction: z.enum(["up", "down", "left", "right"]).default("down"),
  amount: z.number().int().min(1).max(50).default(3),
  delay_ms: z.number().int().min(0).max(500).default(40),
});

const windowFocusOp = z.object({
  op: z.literal("window_focus"),
  query: z.string().min(1).optional(),
  window_id: z.string().regex(/^0x[0-9a-fA-F]+$/, "window_id en formato 0x…").optional(),
  display: z.string().optional(),
});

const windowMoveOp = z.object({
  op: z.literal("window_move"),
  query: z.string().min(1).optional(),
  window_id: z.string().regex(/^0x[0-9a-fA-F]+$/).optional(),
  x: z.number().int().min(COORD_MIN).max(COORD_MAX),
  y: z.number().int().min(COORD_MIN).max(COORD_MAX),
  width: z.number().int().min(1).max(30_000).optional(),
  height: z.number().int().min(1).max(30_000).optional(),
  display: z.string().optional(),
});

const windowCloseOp = z.object({
  op: z.literal("window_close"),
  query: z.string().min(1).optional(),
  window_id: z.string().regex(/^0x[0-9a-fA-F]+$/).optional(),
  display: z.string().optional(),
});

const getStateOp = z.object({ op: z.literal("get_state"), display: z.string().optional() });

const mouseMoveOp = z.object({
  op: z.literal("mouse_move"),
  x: z.number().int().min(COORD_MIN).max(COORD_MAX),
  y: z.number().int().min(COORD_MIN).max(COORD_MAX),
});

const KEY_RE = { regex: /^[A-Za-z0-9_+\-]+$/, msg: "combo inválido: usa 'ctrl+shift', 'Return'" } as const;
const keyDownOp = z.object({
  op: z.literal("key_down"),
  keys: z.array(z.string().regex(KEY_RE.regex, KEY_RE.msg)).min(1).max(5),
});
const keyUpOp = z.object({
  op: z.literal("key_up"),
  keys: z.array(z.string().regex(KEY_RE.regex, KEY_RE.msg)).min(1).max(5),
});

export const gnomeInputSchema = z.discriminatedUnion("op", [
  clickOp,
  doubleClickOp,
  rightClickOp,
  dragOp,
  typeTextOp,
  pressKeysOp,
  scrollOp,
  windowFocusOp,
  windowMoveOp,
  windowCloseOp,
  getStateOp,
  mouseMoveOp,
  keyDownOp,
  keyUpOp,
]);
export type GnomeInputInput = z.infer<typeof gnomeInputSchema>;

const SCROLL_BUTTON: Record<"up" | "down" | "left" | "right", number> = {
  up: 4,
  down: 5,
  left: 6,
  right: 7,
};

export const gnomeInputTool: ToolDefinition<typeof gnomeInputSchema> = {
  name: "gnome_input",
  phase: 1,
  description:
    "Control físico del escritorio X11/GNOME (xdotool/wmctrl), sin confirmaciones. " +
    "Ops: click, double_click, right_click, drag, type_text, press_keys (combos " +
    "'ctrl+alt+t', 'super'), scroll (up/down/left/right), window_focus, " +
    "window_move, window_close, get_state (cursor+pantalla+ventanas).",
  inputSchema: gnomeInputSchema,
  async handler(input) {
    const display = resolveDisplay("display" in input ? input.display : undefined);

    switch (input.op) {
      case "click": {
        moveIf(display, input.x, input.y);
        const args = ["click"];
        if (input.delay_ms !== 120) args.push("--delay", String(input.delay_ms));
        if (input.repeat > 1) args.push("--repeat", String(input.repeat));
        args.push(String(input.button));
        xdo(args, display);
        log.debug("click", { button: input.button, x: input.x, y: input.y, repeat: input.repeat });
        return { action: "click", button: input.button, repeat: input.repeat, x: input.x ?? null, y: input.y ?? null };
      }

      case "double_click": {
        moveIf(display, input.x, input.y);
        xdo(["click", "--repeat", "2", "--delay", String(input.delay_ms), "1"], display);
        return { action: "double_click", x: input.x ?? null, y: input.y ?? null };
      }

      case "right_click": {
        moveIf(display, input.x, input.y);
        xdo(["click", "3"], display);
        return { action: "right_click", x: input.x ?? null, y: input.y ?? null };
      }

      case "drag": {
        const steps = input.steps;
        const parts: string[] = [
          `xdotool mousemove --sync ${Math.round(input.x1)} ${Math.round(input.y1)}`,
          `sleep 0.06`,
          `xdotool mousedown ${input.button}`,
          `sleep 0.06`,
        ];
        for (let i = 1; i <= steps; i++) {
          const t = i / steps;
          // Aceleración suave en el tramo inicial/del final
          const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
          const x = Math.round(input.x1 + (input.x2 - input.x1) * e);
          const y = Math.round(input.y1 + (input.y2 - input.y1) * e);
          parts.push(`xdotool mousemove --sync ${x} ${y}`);
          if (input.step_delay_ms > 0) parts.push(`sleep ${(input.step_delay_ms / 1000).toFixed(3)}`);
        }
        parts.push(`xdotool mousemove --sync ${Math.round(input.x2)} ${Math.round(input.y2)}`);
        parts.push(`sleep 0.05`);
        parts.push(`xdotool mouseup ${input.button}`);
        const r = runSync(["bash", "-c", parts.join("; ")], {
          env: { DISPLAY: display },
          max_bytes: 32 * 1024,
        });
        if (r.exit_code !== 0) {
          throw new Error(`drag falló (exit=${r.exit_code}): ${r.stderr.trim().slice(0, 300)}`);
        }
        log.debug("drag", { from: [input.x1, input.y1], to: [input.x2, input.y2] });
        return {
          action: "drag",
          from: { x: input.x1, y: input.y1 },
          to: { x: input.x2, y: input.y2 },
          button: input.button,
          steps,
        };
      }

      case "type_text": {
        const args = ["type"];
        if (input.clear_modifiers) args.push("--clearmodifiers");
        args.push("--delay", String(input.delay_ms), "--", input.text);
        xdo(args, display);
        log.debug("type_text", { chars: input.text.length });
        return { action: "type_text", chars: input.text.length };
      }

      case "press_keys": {
        const args = ["key"];
        if (input.clear_modifiers) args.push("--clearmodifiers");
        args.push("--delay", String(input.delay_ms), ...input.keys);
        xdo(args, display);
        log.debug("press_keys", { keys: input.keys });
        return { action: "press_keys", keys: input.keys };
      }

      case "scroll": {
        moveIf(display, input.x, input.y);
        const button = SCROLL_BUTTON[input.direction];
        xdo(["click", "--repeat", String(input.amount), "--delay", String(input.delay_ms), String(button)], display);
        log.debug("scroll", { direction: input.direction, amount: input.amount });
        return { action: "scroll", direction: input.direction, amount: input.amount, x: input.x ?? null, y: input.y ?? null };
      }

      case "window_focus": {
        if (!input.query && !input.window_id) throw new Error("requiere query o window_id");
        if (input.window_id) {
          const r = xdo(["windowactivate", "--sync", input.window_id], display);
          return { action: "window_focus", by: "window_id", window_id: input.window_id, raw: r.stdout.trim() || null };
        }
        const r = wm(["-a", input.query!], display);
        if (r.exit_code !== 0) {
          throw new Error(`wmctrl -a '${input.query}' falló: ${r.stderr.trim().slice(0, 200)}`);
        }
        return { action: "window_focus", by: "query", query: input.query };
      }

      case "window_move": {
        if (!input.query && !input.window_id) throw new Error("requiere query o window_id");
        const w = input.width ?? -1;
        const h = input.height ?? -1;
        const spec = `0,${Math.round(input.x)},${Math.round(input.y)},${w},${h}`;
        const target = input.window_id ?? input.query!;
        const args = input.window_id
          ? ["-i", "-r", input.window_id, "-e", spec]
          : ["-r", input.query!, "-e", spec];
        const r = wm(args, display);
        if (r.exit_code !== 0) {
          throw new Error(`window_move falló (exit=${r.exit_code}): ${r.stderr.trim().slice(0, 200)}`);
        }
        return { action: "window_move", target, x: input.x, y: input.y, width: input.width ?? null, height: input.height ?? null };
      }

      case "window_close": {
        if (!input.query && !input.window_id) throw new Error("requiere query o window_id");
        const args = input.window_id ? ["-i", "-c", input.window_id] : ["-c", input.query!];
        const r = wm(args, display);
        if (r.exit_code !== 0) {
          throw new Error(`window_close falló (exit=${r.exit_code}): ${r.stderr.trim().slice(0, 200)}`);
        }
        return { action: "window_close", target: input.window_id ?? input.query };
      }

      case "mouse_move": {
        xdo(["mousemove", "--sync", String(input.x), String(input.y)], display);
        log.debug("mouse_move", { x: input.x, y: input.y });
        return { action: "mouse_move", x: input.x, y: input.y };
      }
      case "key_down":
      case "key_up": {
        const cmd = input.op === "key_down" ? "keydown" : "keyup";
        for (const combo of input.keys) {
          const tokens = combo.split("+").filter(Boolean);
          const seq = input.op === "key_down" ? tokens : [...tokens].reverse();
          for (const t of seq) xdo([cmd, t], display);
        }
        log.debug(input.op, { keys: input.keys });
        return { action: input.op, keys: input.keys };
      }

      case "get_state": {
        const mouse = runSync(["xdotool", "getmouselocation", "--shell"], {
          env: { DISPLAY: display },
          max_bytes: 4_096,
        });
        const cursor = {
          x: Number(mouse.stdout.match(/^X=(\d+)/m)?.[1] ?? -1),
          y: Number(mouse.stdout.match(/^Y=(\d+)/m)?.[1] ?? -1),
        };
        const geo = runSync(["xdotool", "getdisplaygeometry"], {
          env: { DISPLAY: display },
          max_bytes: 1_024,
        });
        const [gw, gh] = geo.stdout.trim().split(/\s+/).map((n) => Number(n));
        const act = runSync(["xdotool", "getactivewindow", "getwindowname"], {
          env: { DISPLAY: display },
          max_bytes: 4_096,
        });
        const wins = wm(["-lG"], display);
        const windows = wins.stdout
          .split("\n")
          .map((line) => {
            const m = line.match(/^0x([0-9a-fA-F]+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(.*)$/);
            if (!m) return null;
            return {
              id: `0x${m[1]!.toLowerCase()}`,
              desktop: Number(m[2]),
              x: Number(m[3]),
              y: Number(m[4]),
              w: Number(m[5]),
              h: Number(m[6]),
              title: (m[7] ?? "").trim(),
            };
          })
          .filter((w): w is NonNullable<typeof w> => w !== null);

        return {
          display,
          screen: { w: gw || 0, h: gh || 0 },
          cursor,
          active_window: act.exit_code === 0 ? act.stdout.trim() : null,
          windows,
        };
      }

      default: {
        const _exhaustive: never = input;
        return _exhaustive;
      }
    }
  },
};
