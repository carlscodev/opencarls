/**
 * OpenCarls — multi_patch: transacción ATÓMICA de parches multi-archivo.
 *
 * Aplica N ediciones en un solo paso; si CUALQUIERA falla se revierte TODO
 * (rollback byte-a-byte de los archivos ya modificados, borrando los creados
 * en la transacción) y no se toca nada más. Devuelve el diff combinado.
 *
 * dry_run=true valida toda la transacción en un estado EN MEMORIA sin escribir
 * un solo byte al disco.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, relative } from "node:path";
import { z } from "zod";
import type { AnyToolDefinition, ToolResult } from "../types";
import { CONFIG } from "../core/config";
import { unifiedDiff } from "../util/diff";

// Contrato del registry: devolver la data CRUDA; errores → throw
// (el registry envuelve con ok()/fail() y captura excepciones).
const ok = <T,>(data: T): T => data;
const fail = (message: string): never => {
  throw new Error(message);
};

export type PatchInstruction =
  | {
      path: string;
      op: "replace";
      find: string;
      replace: string;
      expect_count?: number | undefined;
    }
  | { path: string; op: "append"; content: string }
  | { path: string; op: "prepend"; content: string }
  | { path: string; op: "create"; content: string; overwrite?: boolean | undefined }
  | { path: string; op: "delete"; content_hash?: string | undefined }
  | { path: string; op: "rename"; to: string }
  | {
      path: string;
      op: "regex_replace";
      pattern: string;
      flags: string;
      replace: string;
      expect_count?: number | undefined;
    };

interface Backup {
  path: string;
  /** null = no existía antes de la transacción */
  previous: string | null;
}

interface TxState {
  /** modo dry: estados nuevos viven aquí; disco intacto */
  mem: Map<string, string | null> | null;
  backups: Backup[];
  touched: Set<string>;
}

function readState(root: string, abs: string, tx: TxState): string | null {
  if (tx.mem?.has(abs)) return tx.mem.get(abs) ?? null;
  if (existsSync(abs)) return readFileSync(abs, "utf8");
  void root;
  return null;
}

/** Calcula el contenido nuevo SIN escribir. Lanza en cualquier violación. */
function computeNext(original: string | null, instr: PatchInstruction, abs: string): string | null {
  switch (instr.op) {
    case "create": {
      if (original !== null && !instr.overwrite) {
        throw new Error(`create: ya existe (usa overwrite): ${instr.path}`);
      }
      return instr.content;
    }
    case "append": {
      if (original === null) throw new Error(`append: no existe: ${instr.path}`);
      return original + instr.content;
    }
    case "prepend": {
      if (original === null) throw new Error(`prepend: no existe: ${instr.path}`);
      return instr.content + original;
    }
    case "replace": {
      if (original === null) throw new Error(`replace: no existe: ${instr.path}`);
      const count = original.split(instr.find).length - 1;
      const expect = instr.expect_count ?? 1;
      if (count === 0) throw new Error(`replace: find no encontrado en ${instr.path}`);
      if (count !== expect) {
        throw new Error(
          `replace: find aparece ${count} veces, se esperaban ${expect} en ${instr.path}`,
        );
      }
      return original.split(instr.find).join(instr.replace);
    }
    case "regex_replace": {
      if (original === null) throw new Error(`regex_replace: no existe: ${instr.path}`);
      if (!/^[gimsuy]*$/.test(instr.flags)) {
        throw new Error(`regex_replace: flags inválidas: ${instr.flags}`);
      }
      const flags = instr.flags.includes("g") ? instr.flags : `${instr.flags}g`;
      const re = new RegExp(instr.pattern, flags);
      const count = original.match(re)?.length ?? 0;
      const expect = instr.expect_count ?? 1;
      if (count === 0) throw new Error(`regex_replace: sin matches en ${instr.path}`);
      if (count !== expect) {
        throw new Error(
          `regex_replace: ${count} matches, se esperaban ${expect} en ${instr.path}`,
        );
      }
      return original.replace(re, instr.replace);
    }
    case "delete": {
      if (original === null) throw new Error(`delete: no existe: ${instr.path}`);
      if (instr.content_hash) {
        const h = createHash("sha256").update(original, "utf8").digest("hex");
        if (h !== instr.content_hash) {
          throw new Error(`delete: sha256 del contenido distinto en ${instr.path}`);
        }
      }
      void abs;
      return null;
    }
    case "rename": {
      if (original === null) throw new Error(`rename: no existe: ${instr.path}`);
      return original; // el contenido se traslada al destino
    }
    default: {
      const never: never = instr;
      throw new Error(`op desconocida: ${JSON.stringify(never)}`);
    }
  }
}

function applyOne(root: string, instr: PatchInstruction, tx: TxState): void {
  const abs = isAbsolute(instr.path) ? instr.path : join(root, instr.path);
  const toPath = instr.op === "rename" ? instr.to : null;
  const toAbs = toPath ? (isAbsolute(toPath) ? toPath : join(root, toPath)) : null;

  if (toAbs && tx.touched.has(toAbs)) {
    throw new Error(`rename destino ya tocado en esta transacción: ${toPath}`);
  }

  const original = readState(root, abs, tx);
  // Backup de estado PREVIO al disco (solo una vez por archivo)
  if (tx.backups.every((b) => b.path !== abs)) {
    const diskPrev = existsSync(abs) ? readFileSync(abs, "utf8") : null;
    tx.backups.push({ path: abs, previous: diskPrev });
  }
  const next = computeNext(original, instr, abs);

  if (tx.mem) {
    if (toAbs) {
      tx.mem.set(abs, null);
      if (tx.backups.every((b) => b.path !== toAbs)) {
        tx.backups.push({ path: toAbs, previous: existsSync(toAbs) ? readFileSync(toAbs, "utf8") : null });
      }
      tx.mem.set(toAbs, next);
      tx.touched.add(toAbs);
    } else if (next === null) {
      tx.mem.set(abs, null);
    } else {
      tx.mem.set(abs, next);
    }
    tx.touched.add(abs);
    return;
  }

  // Modo escritura real
  if (toAbs) {
    if (existsSync(toAbs)) throw new Error(`rename: destino ya existe: ${toPath}`);
    if (tx.backups.every((b) => b.path !== toAbs)) {
      tx.backups.push({ path: toAbs, previous: null });
    }
    mkdirSync(dirname(toAbs), { recursive: true });
    renameSync(abs, toAbs);
    tx.touched.add(toAbs);
    tx.touched.add(abs);
    return;
  }
  if (next === null) {
    if (existsSync(abs)) unlinkSync(abs);
    tx.touched.add(abs);
    return;
  }
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, next, "utf8");
  tx.touched.add(abs);
}

function rollback(tx: TxState): void {
  for (let i = tx.backups.length - 1; i >= 0; i--) {
    const b = tx.backups[i]!;
    try {
      if (b.previous === null) {
        if (existsSync(b.path)) unlinkSync(b.path);
      } else {
        mkdirSync(dirname(b.path), { recursive: true });
        writeFileSync(b.path, b.previous, "utf8");
      }
    } catch {
      /* best-effort */
    }
  }
}

export const multiPatchTool: AnyToolDefinition = {
  name: "multi_patch",
  phase: 2,
  description:
    "Aplica N instrucciones de parche (replace/regex_replace/append/prepend/" +
    "create/delete/rename) en un SOLO paso transaccional: si una falla se " +
    "revierte TODO (rollback) y no queda ningún cambio a medias. dry_run " +
    "valida en memoria. Devuelve el diff combinado de todos los archivos.",
  inputSchema: z.object({
    patches: z
      .array(
        z.discriminatedUnion("op", [
          z.object({
            path: z.string().min(1),
            op: z.literal("replace"),
            find: z.string().min(1),
            replace: z.string(),
            expect_count: z.number().int().min(1).optional(),
          }),
          z.object({ path: z.string().min(1), op: z.literal("append"), content: z.string() }),
          z.object({ path: z.string().min(1), op: z.literal("prepend"), content: z.string() }),
          z.object({
            path: z.string().min(1),
            op: z.literal("create"),
            content: z.string(),
            overwrite: z.boolean().optional(),
          }),
          z.object({
            path: z.string().min(1),
            op: z.literal("delete"),
            content_hash: z.string().optional(),
          }),
          z.object({ path: z.string().min(1), op: z.literal("rename"), to: z.string().min(1) }),
          z.object({
            path: z.string().min(1),
            op: z.literal("regex_replace"),
            pattern: z.string().min(1),
            flags: z.string().default("g"),
            replace: z.string(),
            expect_count: z.number().int().min(1).optional(),
          }),
        ]),
      )
      .min(1)
      .max(200),
    dry_run: z.boolean().default(false),
    root: z
      .string()
      .optional()
      .describe("raíz opcional (default: project_root de OpenCarls)"),
  }),
  async handler(input): Promise<unknown> {
    const { patches, dry_run, root } = input as {
      patches: PatchInstruction[];
      dry_run: boolean;
      root?: string | undefined;
    };
    const base = root
      ? isAbsolute(root)
        ? root
        : join(CONFIG.project_root, root)
      : CONFIG.project_root;

    const tx: TxState = {
      mem: dry_run ? new Map() : null,
      backups: [],
      touched: new Set(),
    };

    const applied: Array<{ path: string; op: string }> = [];
    try {
      for (const p of patches) {
        applyOne(base, p, tx);
        applied.push({ path: p.path, op: p.op });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!dry_run) rollback(tx);
      return fail(`transacción abortada${dry_run ? " (dry_run, nada escrito)" : " y revertida"}: ${msg}`);
    }

    if (dry_run) {
      return ok({
        dry_run: true,
        applied: applied.length,
        files: [...new Set(patches.map((p) => p.path))],
        applied_ops: applied,
        note: "dry_run: transacción válida; ningún byte escrito",
      });
    }

    // Diff combinado post-escritura (estado nuevo vs backup previo)
    const relFiles = [...new Set(tx.touched)].map((abs) =>
      abs.startsWith(base) ? relative(base, abs) || abs : abs,
    );
    const hunks: string[] = [];
    let additions = 0;
    let deletions = 0;
    for (const abs of tx.touched) {
      const b = tx.backups.find((x) => x.path === abs);
      const before = b?.previous ?? "";
      const after = existsSync(abs) ? readFileSync(abs, "utf8") : "";
      if (before === after) continue;
      const rel = abs.startsWith(base) ? relative(base, abs) || abs : abs;
      const d = unifiedDiff(before, after, rel, 3);
      if (!d) continue;
      hunks.push(d);
      for (const line of d.split("\n")) {
        if (line.startsWith("+") && !line.startsWith("+++")) additions++;
        else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
      }
    }

    return ok({
      applied: applied.length,
      files: relFiles,
      additions,
      deletions,
      diff: hunks.join("\n"),
      applied_ops: applied,
    });
  },
} as AnyToolDefinition;
