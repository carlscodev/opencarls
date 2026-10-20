/**
 * OpenCarls — Herramienta 3: `gnome_vision`.
 *
 * Captura el escritorio X11 de Ubuntu GNOME (scrot → gnome-screenshot →
 * import, en cascada), dibuja en memoria con `sharp` la **cuadrícula
 * graduada de coordenadas (X, Y)** cada N px + marcador del cursor actual
 * (Set-of-Marks), y devuelve la imagen optimizada en base64 junto con el
 * árbol de ventanas activas (`wmctrl -lG` + ventana focuseada).
 */
import { join } from "node:path";
import sharp from "sharp";
import { z } from "zod";
import { CONFIG, ensureAgentDirs, tmpFile } from "../core/config";
import { createLogger } from "../core/logger";
import { run, runSync } from "../util/proc";
import type { ToolDefinition } from "../types";

const log = createLogger("tool:gnome_vision");

export interface WindowRow {
  id: string;
  desktop: number;
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  active: boolean;
}

function resolveDisplay(override?: string): string {
  return override ?? process.env.DISPLAY ?? CONFIG.display;
}

/** Captura del root window con cadena de fallbacks. */
async function captureScreen(
  display: string,
  timeoutMs: number,
): Promise<{ path: string; method: string }> {
  const env = { DISPLAY: display };
  const attempts: Array<{ method: string; args: string[] }> = [
    { method: "scrot", args: ["scrot", "-o", "-q", "92"] },
    { method: "gnome-screenshot", args: ["gnome-screenshot", "-f"] },
    { method: "import", args: ["import", "-window", "root"] },
  ];
  const errors: string[] = [];

  for (const a of attempts) {
    const out = tmpFile("shot", "png");
    const args = [...a.args, out];
    const bin = a.args[0]!;
    const check = await run([bin, "--help"], { timeout_ms: 3_000, max_bytes: 256 });
    if (check.exit_code !== 0 && check.exit_code !== 1 && check.exit_code !== null) {
      errors.push(`${bin}: no instalado`);
      continue;
    }
    const r = await run(args, { env, timeout_ms: timeoutMs, max_bytes: 64 * 1024 });
    const f = Bun.file(out);
    if ((await f.exists()) && f.size > 1024) {
      return { path: out, method: a.method };
    }
    errors.push(`${bin}: exit=${r.exit_code} ${r.stderr.trim().slice(0, 160)}`);
  }
  throw new Error(`captura falló en todos los métodos → ${errors.join(" | ")}`);
}

/** Cursor actual vía xdotool. */
function getCursor(display: string): { x: number; y: number } | null {
  const r = runSync(["xdotool", "getmouselocation", "--shell"], {
    env: { DISPLAY: display },
    max_bytes: 4_096,
  });
  if (r.exit_code !== 0) return null;
  const x = r.stdout.match(/^X=(\d+)/m)?.[1];
  const y = r.stdout.match(/^Y=(\d+)/m)?.[1];
  if (x === undefined || y === undefined) return null;
  return { x: Number(x), y: Number(y) };
}

/** Árbol de ventanas + id de la activa. */
export function getWindows(display: string): { windows: WindowRow[]; active_id: string | null } {
  const r = runSync(["wmctrl", "-lG"], { env: { DISPLAY: display }, max_bytes: 256 * 1024 });
  const act = runSync(["xdotool", "getactivewindow"], { env: { DISPLAY: display }, max_bytes: 4_096 });
  const activeDec = act.exit_code === 0 ? act.stdout.trim() : null;
  const activeHex = activeDec ? `0x${Number(activeDec).toString(16)}`.toLowerCase() : null;

  const windows: WindowRow[] = [];
  if (r.exit_code === 0) {
    for (const line of r.stdout.split("\n")) {
      const m = line.match(/^0x([0-9a-fA-F]+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(.*)$/);
      if (!m) continue;
      const hexId = `0x${m[1]!.toLowerCase()}`;
      windows.push({
        id: hexId,
        desktop: Number(m[2]),
        x: Number(m[3]),
        y: Number(m[4]),
        w: Number(m[5]),
        h: Number(m[6]),
        title: (m[7] ?? "").trim(),
        active: activeHex !== null && hexId === activeHex,
      });
    }
  }
  return { windows, active_id: activeHex ?? activeDec };
}

/** Resolución exacta de la pantalla X11 (para computer_use nativo). */
export function getScreenResolution(
  display?: string,
): { width: number; height: number; display: string } {
  const d = resolveDisplay(display);
  const geo = runSync(["xdotool", "getdisplaygeometry"], { env: { DISPLAY: d }, max_bytes: 1_024 });
  const [gw, gh] = geo.stdout.trim().split(/\s+/).map((n) => Number(n));
  return { width: gw || 0, height: gh || 0, display: d };
}

export type CoordSpace = "pixels" | "normalized_1000" | "normalized_0_1";

/** Auto-escala coordenadas (0..1000 / 0..1 / píxeles) a la resolución real. */
export function normalizedToPixels(
  x: number,
  y: number,
  screen: { width: number; height: number },
  space: CoordSpace = "pixels",
): { x: number; y: number } {
  if (space === "pixels") return { x: Math.round(x), y: Math.round(y) };
  const maxX = space === "normalized_1000" ? 1000 : 1;
  const maxY = space === "normalized_1000" ? 1000 : 1;
  return {
    x: Math.round((Math.max(0, Math.min(maxX, x)) / maxX) * Math.max(screen.width - 1, 0)),
    y: Math.round((Math.max(0, Math.min(maxY, y)) / maxY) * Math.max(screen.height - 1, 0)),
  };
}

/** SVG en memoria: grilla cada `grid` px con etiquetas + crosshair cursor. */
export function buildOverlaySvg(
  width: number,
  height: number,
  opts: {
    grid: number;
    show_grid: boolean;
    label_every: number;
    cursor: { x: number; y: number } | null;
    show_cursor: boolean;
  },
): string {
  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
  );

  if (opts.show_grid && opts.grid > 0) {
    const lines: string[] = [];
    for (let x = opts.grid; x < width; x += opts.grid) {
      lines.push(`<line x1="${x}" y1="0" x2="${x}" y2="${height}" />`);
    }
    for (let y = opts.grid; y < height; y += opts.grid) {
      lines.push(`<line x1="0" y1="${y}" x2="${width}" y2="${y}" />`);
    }
    parts.push(
      `<g stroke="#00ffaa" stroke-opacity="0.32" stroke-width="1">${lines.join("")}</g>`,
    );
    // Ejes fuertes en x=0/y=0
    parts.push(
      `<g stroke="#00ffaa" stroke-opacity="0.85" stroke-width="1.5">` +
        `<line x1="0" y1="0" x2="0" y2="${height}" /><line x1="0" y1="0" x2="${width}" y2="0" /></g>`,
    );
  }

  if (opts.show_grid && opts.label_every > 0) {
    const labelTop: string[] = [];
    const labelLeft: string[] = [];
    const font = `font-family="DejaVu Sans Mono, Liberation Mono, monospace" font-size="11" font-weight="bold"`;
    for (let x = 0; x <= width; x += opts.label_every) {
      const t = String(x);
      labelTop.push(
        `<text x="${Math.min(x + 3, width - 24)}" y="13" ${font}>${t}</text>`,
      );
    }
    for (let y = opts.label_every; y <= height; y += opts.label_every) {
      const t = String(y);
      labelLeft.push(
        `<text x="3" y="${Math.min(y - 4, height - 4)}" ${font}>${t}</text>`,
      );
    }
    // Pass 1: contorno oscuro (legibilidad sobre cualquier fondo)…
    parts.push(
      `<g fill="none" stroke="#000000" stroke-width="3" stroke-linejoin="round">` +
        [...labelTop, ...labelLeft].join("") +
        `</g>`,
    );
    // …pass 2: masa negra, pass 3: relleno claro → texto con borde oscuro.
    parts.push(
      `<g fill="#000000">${[...labelTop, ...labelLeft].join("")}</g>`,
    );
    parts.push(
      `<g fill="#d7fff1">${[...labelTop, ...labelLeft].join("")}</g>`,
    );
  }

  if (opts.show_cursor && opts.cursor) {
    const { x, y } = opts.cursor;
    parts.push(
      `<g stroke="#ff3b30" stroke-width="1.5" stroke-dasharray="7 5" stroke-opacity="0.95">` +
        `<line x1="${x}" y1="0" x2="${x}" y2="${height}" />` +
        `<line x1="0" y1="${y}" x2="${width}" y2="${y}" /></g>` +
        `<circle cx="${x}" cy="${y}" r="9" fill="none" stroke="#ff3b30" stroke-width="2.5" />` +
        `<circle cx="${x}" cy="${y}" r="2.5" fill="#ff3b30" />`,
    );
    const tag = `${x},${y}`;
    const lx = Math.min(x + 14, width - 90);
    const ly = Math.min(Math.max(y + 20, 16), height - 6);
    const font = `font-family="DejaVu Sans Mono, Liberation Mono, monospace" font-size="13" font-weight="bold"`;
    parts.push(`<text x="${lx + 1}" y="${ly + 1}" ${font} fill="#000000">${tag}</text>`);
    parts.push(`<text x="${lx}" y="${ly}" ${font} fill="#ffd60a">${tag}</text>`);
  }

  parts.push("</svg>");
  return parts.join("");
}

// ══════════════════════════════════════════════ SCHEMA + TOOL ══════════════

const captureOp = z.object({
  op: z.literal("capture").default("capture"),
  grid: z.number().int().min(0).max(1_000).default(100),
  show_grid: z.boolean().default(true),
  label_every: z.number().int().min(0).max(1_000).optional(),
  show_cursor: z.boolean().default(true),
  format: z.enum(["jpeg", "png", "webp"]).default("jpeg"),
  quality: z.number().int().min(10).max(100).default(82),
  max_width: z.number().int().min(200).max(7_680).optional(),
  include_windows: z.boolean().default(true),
  save_copy: z.boolean().default(false),
  clean: z
    .boolean()
    .default(false)
    .describe("true = captura LIMPIA sin grilla (modo Computer-Use nativo OpenAI/Anthropic)"),
  display: z.string().optional(),
  timeout_ms: z.number().int().min(1_000).max(60_000).default(15_000),
});

const stateOp = z.object({
  op: z.literal("state"),
  display: z.string().optional(),
});

/** Si el input no trae `op`, se asume `capture` (default del catálogo). */
function withDefaultCaptureOp(v: unknown): unknown {
  if (v && typeof v === "object" && !Array.isArray(v) && !("op" in (v as object))) {
    return { ...(v as object), op: "capture" };
  }
  return v;
}

export const gnomeVisionSchema = z.preprocess(
  withDefaultCaptureOp,
  z.discriminatedUnion("op", [captureOp, stateOp]),
);
export type GnomeVisionInput = z.infer<typeof gnomeVisionSchema>;

export const gnomeVisionTool: ToolDefinition<typeof gnomeVisionSchema> = {
  name: "gnome_vision",
  phase: 1,
  description:
    "Captura el escritorio X11/GNOME, dibuja cuadrícula graduada de coordenadas " +
    "X,Y cada `grid` px + crosshair del cursor con `sharp`, y devuelve la imagen " +
    "en base64 con el árbol de ventanas (wmctrl -lG + activa). " +
    "Ops: capture (default) | state (sin imagen, solo cursor+ventanas).",
  inputSchema: gnomeVisionSchema,
  async handler(input) {
    const display = resolveDisplay(input.display);

    if (input.op === "state") {
      const cursor = getCursor(display);
      const { windows, active_id } = getWindows(display);
      const geo = runSync(["xdotool", "getdisplaygeometry"], {
        env: { DISPLAY: display },
        max_bytes: 1_024,
      });
      const [gw, gh] = geo.stdout.trim().split(/\s+/).map((n) => Number(n));
      return { display, screen: { w: gw || 0, h: gh || 0 }, cursor, windows, active_id };
    }

    const started = performance.now();
    const labelEvery = input.label_every ?? input.grid;

    // 1) Captura
    const { path: shotPath, method } = await captureScreen(display, input.timeout_ms);

    // 2) Cursor + ventanas (antes de componer, para dibujar encima)
    const cursor = getCursor(display);
    const { windows, active_id } = input.include_windows
      ? getWindows(display)
      : { windows: [] as WindowRow[], active_id: null };

    // 3) Overlay con sharp
    const img = sharp(shotPath);
    const meta = await img.metadata();
    const width = meta.width ?? 0;
    const height = meta.height ?? 0;
    if (!width || !height) throw new Error("captura sin dimensiones válidas");

    let pipeline = img;
    let scale = 1;
    let outWidth = width;
    if (!input.clean) {
      const svg = buildOverlaySvg(width, height, {
        grid: input.grid,
        show_grid: input.show_grid && input.grid > 0,
        label_every: labelEvery > 0 ? labelEvery : 0,
        cursor,
        show_cursor: input.show_cursor,
      });
      // Rasterizar el SVG EXACTAMENTE al tamaño de la base: sharp rechaza
      // overlays más grandes ("must have same dimensions or smaller") cuando
      // el raster del SVG no calza con la captura (resoluciones/Xvfb variables).
      const svgRaster = await sharp(Buffer.from(svg))
        .resize(width, height, { fit: "fill" })
        .png()
        .toBuffer();
      pipeline = img.composite([{ input: svgRaster, top: 0, left: 0 }]);
    }
    if (!input.clean && input.max_width && width > input.max_width) {
      outWidth = input.max_width;
      scale = input.max_width / width;
      pipeline = pipeline.resize({ width: input.max_width, withoutEnlargement: true });
    }
    if (input.format === "jpeg") pipeline = pipeline.flatten({ background: "#000000" });

    const buffer = await pipeline
      .toFormat(input.format, input.format === "png" ? {} : { quality: input.quality })
      .toBuffer();

    // 4) Limpieza + copia opcional
    try {
      const { unlink } = await import("node:fs/promises");
      await unlink(shotPath).catch(() => {});
    } catch {
      /* noop */
    }
    let saved: string | null = null;
    if (input.save_copy) {
      ensureAgentDirs();
      saved = join(CONFIG.captures_dir, `vision-${Date.now()}.${input.format === "jpeg" ? "jpg" : input.format}`);
      await Bun.write(saved, buffer);
    }

    const mime =
      input.format === "jpeg" ? "image/jpeg" : input.format === "png" ? "image/png" : "image/webp";

    log.info("captura compuesta", {
      method,
      size: `${width}x${height}`,
      bytes: buffer.byteLength,
      windows: windows.length,
      ms: Math.round(performance.now() - started),
    });

    return {
      image_base64: Buffer.from(buffer).toString("base64"),
      mime,
      width: outWidth,
      height: Math.round(height * scale),
      original_width: width,
      original_height: height,
      scale,
      cursor,
      windows,
      active_id,
      capture_method: method,
      saved_copy: saved,
      elapsed_ms: Math.round(performance.now() - started),
    };
  },
};
