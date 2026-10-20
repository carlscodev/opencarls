/**
 * OpenCarls — Herramienta 2: `code_surgery`.
 *
 * Operaciones de alta velocidad sobre archivos usando las APIs nativas de
 * Bun (`Bun.file()` / `Bun.write()`):
 *
 *   - read_range         : lectura por rango de líneas numeradas.
 *   - write_full         : escritura completa (create/overwrite) con mkdir -p.
 *   - surgical_replace   : reemplazo exacto por bloque con dif unificado
 *                          (Myers, `src/util/diff.ts`) y validación de matches.
 *   - ast_outline        : esqueleto del archivo (TypeScript Compiler API para
 *                          TS/JS/JSON; heurísticas por lenguaje para el resto).
 *   - ripgrep_search     : búsqueda con `rg --json` (fallback interno si falta).
 */
import ts from "typescript";
import { z } from "zod";
import { createLogger } from "../core/logger";
import { diffStats, unifiedDiff } from "../util/diff";
import { run } from "../util/proc";
import type { ToolDefinition } from "../types";

const log = createLogger("tool:code_surgery");

const MAX_TEXT_BYTES = 16 * 1024 * 1024; // lecturas/escrituras de texto
const OUTLINE_MAX_BYTES = 4 * 1024 * 1024;

async function readText(path: string, maxBytes = MAX_TEXT_BYTES): Promise<string> {
  const f = Bun.file(path);
  if (!(await f.exists())) throw new Error(`archivo no existe: ${path}`);
  const size = f.size;
  if (size > maxBytes) {
    throw new Error(`archivo demasiado grande (${size} bytes > ${maxBytes}) para operación de texto`);
  }
  return await f.text();
}

function lineCount(s: string): number {
  if (s === "") return 0;
  let n = 1;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return s.endsWith("\n") ? n - 1 : n;
}

// ══════════════════════════════════════════════════════ AST OUTLINE ═══════

type OutlineNode = {
  kind: string;
  name: string;
  line: number;
  end_line?: number;
  exported?: boolean;
  flags?: string[];
  children?: OutlineNode[];
};

function langOf(path: string): string {
  const ext = path.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  const map: Record<string, string> = {
    ts: "typescript", tsx: "typescriptreact", js: "javascript", jsx: "javascriptreact",
    mjs: "javascript", cjs: "javascript", json: "json", py: "python", sh: "shell",
    bash: "shell", rs: "rust", go: "go", java: "java", kt: "kotlin", c: "c", h: "c",
    cpp: "cpp", cc: "cpp", hpp: "cpp", rb: "ruby", php: "php", cs: "csharp",
    sql: "sql", yaml: "yaml", yml: "yaml", toml: "toml", md: "markdown", html: "html",
    css: "css", scss: "scss", lua: "lua", swift: "swift",
  };
  return map[ext] ?? (ext ? ext : "unknown");
}

function lineAt(sf: ts.SourceFile, pos: number): number {
  return sf.getLineAndCharacterOfPosition(pos).line + 1;
}

function modifiersOf(node: ts.Node): string[] {
  const out: string[] = [];
  const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  for (const m of mods ?? []) {
    const raw = ts.SyntaxKind[m.kind] ?? "Modifier";
    out.push(String(raw).replace(/Keyword$/, "").replace(/^(.)/, (c) => c.toLowerCase()));
  }
  return out;
}

function outlineTs(sf: ts.SourceFile, maxDepth: number, maxNodes: number): OutlineNode[] {
  const nodes: OutlineNode[] = [];
  let budget = maxNodes;

  const visitStatements = (stmts: readonly ts.Statement[], depth: number): OutlineNode[] => {
    const out: OutlineNode[] = [];
    for (const st of stmts) {
      if (budget <= 0) break;
      const n = statementNode(st, depth);
      if (n) {
        out.push(n);
        budget--;
      }
    }
    return out;
  };

  const statementNode = (st: ts.Statement, depth: number): OutlineNode | null => {
    const mods = modifiersOf(st);
    const exported = mods.includes("export");
    const start = st.getStart(sf);
    const line = lineAt(sf, start);
    const endLine = lineAt(sf, st.getEnd());

    if (ts.isImportDeclaration(st)) {
      const spec = st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)
        ? st.moduleSpecifier.text
        : "?";
      const names = (st.importClause?.namedBindings && ts.isNamedImports(st.importClause.namedBindings)
        ? st.importClause.namedBindings.elements.map((e) => e.name.text).join(", ")
        : st.importClause?.name?.text) ?? "*";
      return { kind: "import", name: `${names} ← ${spec}`, line, end_line: endLine };
    }
    if (ts.isExportDeclaration(st)) {
      const spec = st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier) ? st.moduleSpecifier.text : "";
      return { kind: "export", name: spec ? `* ← ${spec}` : "(named)", line, end_line: endLine };
    }
    if (ts.isExportAssignment(st)) {
      return { kind: "export-default", name: st.expression.getText(sf).slice(0, 80), line, end_line: endLine };
    }
    if (ts.isFunctionDeclaration(st)) {
      const n: OutlineNode = {
        kind: st.asteriskToken ? "generator" : "function",
        name: st.name?.text ?? "(anonymous)",
        line,
        end_line: endLine,
        exported,
        flags: [...mods.filter((m) => m !== "export" && m !== "default"), ...(st.asteriskToken ? ["generator"] : [])],
      };
      if (depth < maxDepth && st.body) {
        n.children = visitStatements(st.body.statements, depth + 1);
      }
      return n;
    }
    if (ts.isClassDeclaration(st) || ts.isClassExpression(st)) {
      const n: OutlineNode = {
        kind: "class",
        name: st.name?.text ?? "(anonymous)",
        line,
        end_line: endLine,
        exported,
        children: [],
      };
      for (const m of st.members) {
        if (budget <= 0) break;
        const mMods = modifiersOf(m);
        const mName = ts.isConstructorDeclaration(m)
          ? "constructor"
          : m.name
            ? ts.isIdentifier(m.name)
              ? m.name.text
              : m.name.getText(sf).slice(0, 40)
            : "(anon)";
        let kind = "member";
        if (ts.isMethodDeclaration(m)) kind = "method";
        else if (ts.isConstructorDeclaration(m)) kind = "constructor";
        else if (ts.isGetAccessorDeclaration(m)) kind = "getter";
        else if (ts.isSetAccessorDeclaration(m)) kind = "setter";
        else if (ts.isPropertyDeclaration(m)) kind = "property";
        n.children!.push({
          kind,
          name: mName,
          line: lineAt(sf, m.getStart(sf)),
          flags: mMods,
        });
        budget--;
      }
      return n;
    }
    if (ts.isInterfaceDeclaration(st)) {
      return {
        kind: "interface",
        name: st.name.text,
        line,
        end_line: endLine,
        exported,
        children: st.members
          .filter(() => budget-- > 0)
          .map((mem) => {
            const mName = mem.name && ts.isIdentifier(mem.name) ? mem.name.text : mem.name?.getText(sf).slice(0, 40) ?? "?";
            const kind = ts.isMethodSignature(mem) ? "method-sig" : ts.isPropertySignature(mem) ? "property-sig" : "member";
            return { kind, name: mName, line: lineAt(sf, mem.getStart(sf)) };
          }),
      };
    }
    if (ts.isTypeAliasDeclaration(st)) {
      return { kind: "type", name: st.name.text, line, end_line: endLine, exported };
    }
    if (ts.isEnumDeclaration(st)) {
      return {
        kind: "enum",
        name: st.name.text,
        line,
        end_line: endLine,
        exported,
        children: st.members
          .filter(() => budget-- > 0)
          .map((em) => ({ kind: "enum-member", name: em.name.getText(sf), line: lineAt(sf, em.getStart(sf)) })),
      };
    }
    if (ts.isVariableStatement(st)) {
      const out: OutlineNode[] = [];
      const decls = st.declarationList.declarations;
      for (const d of decls) {
        if (budget <= 0) break;
        const name = ts.isIdentifier(d.name) ? d.name.text : d.name.getText(sf).slice(0, 60);
        const isFn = d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer));
        const declFlags = (st.declarationList.flags & ts.NodeFlags.Const)
          ? ["const"]
          : (st.declarationList.flags & ts.NodeFlags.Let)
            ? ["let"]
            : ["var"];
        const n: OutlineNode = {
          kind: isFn ? "const-fn" : "variable",
          name,
          line: lineAt(sf, d.getStart(sf)),
          exported,
          flags: declFlags,
        };
        if (isFn && depth < maxDepth) {
          const fn = d.initializer as ts.ArrowFunction | ts.FunctionExpression;
          if (fn.body && ts.isBlock(fn.body)) n.children = visitStatements(fn.body.statements, depth + 1);
        }
        out.push(n);
        budget--;
      }
      // Una sentencia `const a = 1, b = 2` → varios nodos; el caller espera 1.
      // Devolvemos el primero y enganchamos el resto como hermanos via callback:
      if (out.length === 1) return out[0]!;
      return {
        kind: "variables",
        name: out.map((o) => o.name).join(", "),
        line,
        end_line: endLine,
        exported,
        children: out,
      };
    }
    if (ts.isModuleDeclaration(st)) {
      return {
        kind: "namespace",
        name: st.name.getText(sf),
        line,
        end_line: endLine,
        exported,
        children: depth < maxDepth && st.body && ts.isModuleBlock(st.body)
          ? visitStatements(st.body.statements, depth + 1)
          : undefined,
      };
    }
    return null;
  };

  return visitStatements(sf.statements, 0);
}

function outlineJson(text: string, maxDepth: number, maxNodes: number): OutlineNode[] {
  // Heurística por líneas: claves con su indentación (profundidad = indent/2).
  const nodes: OutlineNode[] = [];
  const stack: OutlineNode[] = [];
  const lines = text.split("\n");
  let budget = maxNodes;
  for (let i = 0; i < lines.length && budget > 0; i++) {
    const line = lines[i]!;
    const m = line.match(/^(\s*)"([^"]+)"\s*:/);
    if (!m) continue;
    const indent = (m[1] ?? "").replace(/\t/g, "  ").length;
    const depth = Math.floor(indent / 2);
    if (depth > maxDepth) continue;
    const node: OutlineNode = { kind: "json-key", name: m[2] ?? "?", line: i + 1 };
    while (stack.length > depth) stack.pop();
    const parent = stack[depth - 1];
    if (parent) {
      (parent.children ??= []).push(node);
    } else {
      nodes.push(node);
    }
    stack[depth] = node;
    budget--;
  }
  return nodes;
}

const GENERIC_PATTERNS: Array<{ re: RegExp; kind: string }> = [
  { re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, kind: "function" },
  { re: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: "class" },
  { re: /^\s*(?:pub\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+([A-Za-z_$][\w$]*)/, kind: "function" },
  { re: /^\s*func\s+([A-Za-z_$][\w$]*)\s*\(/, kind: "function" },
  { re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[:=].*(?:=>|function\s*\(|\(\)\s*{)/, kind: "const-fn" },
  { re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/, kind: "variable" },
  { re: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/, kind: "interface" },
  { re: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)/, kind: "type" },
  { re: /^\s*(?:export\s+)?(?:enum|trait|struct)\s+([A-Za-z_$][\w$]*)/, kind: "type" },
  { re: /^\s*impl(?:<[^>]*>)?\s+([A-Za-z_$][\w<>: ]*)/, kind: "impl" },
  { re: /^\s*(?:async\s+)?def\s+([A-Za-z_$][\w$]*)/, kind: "function" },
  { re: /^\s*class\s+([A-Za-z_$][\w.]*)/, kind: "class" },
  { re: /^\s*(?:function\s+)?([A-Za-z_$][\w$]*)\s*\(\)\s*(?:\{|$)/, kind: "function" },
  { re: /^\s*(?:public|private|protected)?\s*(?:static\s+)?(?:final\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: "class" },
];

function outlineGeneric(text: string, maxNodes: number): OutlineNode[] {
  const nodes: OutlineNode[] = [];
  const lines = text.split("\n");
  const indentOf = (s: string) => (s.match(/^[ \t]*/) ?? [""])[0]!.replace(/\t/g, "  ").length;
  const stack: Array<{ depth: number; node: OutlineNode }> = [];
  for (let i = 0; i < lines.length && nodes.length + 0 < maxNodes; i++) {
    const line = lines[i]!;
    if (/^\s*(#|\/\/|\*|\/\*)/.test(line)) continue;
    let hit: OutlineNode | null = null;
    for (const { re, kind } of GENERIC_PATTERNS) {
      const m = re.exec(line);
      if (m) {
        hit = { kind, name: (m[1] ?? m[0] ?? "?").trim().slice(0, 80), line: i + 1 };
        break;
      }
    }
    if (!hit) continue;
    const depth = Math.floor(indentOf(line) / 2);
    while (stack.length > 0 && stack[stack.length - 1]!.depth >= depth) stack.pop();
    const parent = stack[stack.length - 1]?.node;
    if (parent) (parent.children ??= []).push(hit);
    else nodes.push(hit);
    stack.push({ depth, node: hit });
  }
  return nodes;
}

// ══════════════════════════════════════════════════ RIPGREP FALLBACK ═══════

interface RgMatch {
  path: string;
  line: number;
  column: number;
  text: string;
}

function globToRegex(glob: string): RegExp | null {
  if (!glob) return null;
  const esc = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  const anchored = glob.includes("/") ? esc : `(^|/)${esc}$`;
  try {
    return new RegExp(anchored);
  } catch {
    return null;
  }
}

const FALLBACK_SKIP_DIRS = new Set([
  "node_modules", ".git", ".agent", "dist", "build", "target", ".next", ".nuxt",
  "coverage", ".venv", "venv", "__pycache__", ".cache", ".turbo", ".output",
]);

async function rgFallback(
  pattern: string,
  root: string,
  opts: {
    glob?: string;
    ignore_case?: boolean;
    fixed?: boolean;
    word?: boolean;
    max_results: number;
  },
): Promise<{ matches: RgMatch[]; scanned_files: number; truncated: boolean }> {
  const flags = `m${opts.ignore_case ? "i" : ""}`;
  let re: RegExp;
  try {
    const core = opts.fixed ? pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : pattern;
    re = new RegExp(opts.word ? `\\b(?:${core})\\b` : core, flags);
  } catch (e) {
    throw new Error(`regex inválida: ${e instanceof Error ? e.message : String(e)}`);
  }
  const globRe = opts.glob ? globToRegex(opts.glob) : null;
  const matches: RgMatch[] = [];
  let scanned = 0;
  let truncated = false;

  const scanFile = async (full: string, rel: string): Promise<void> => {
    if (truncated) return;
    if (globRe && !globRe.test(rel) && !globRe.test(full.split("/").pop() ?? "")) return;
    try {
      const f = Bun.file(full);
      if (f.size > 2 * 1024 * 1024) return;
      scanned++;
      if (scanned > 50_000) {
        truncated = true;
        return;
      }
      const text = await f.text();
      if (text.includes("\0")) return; // binario
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const lineText = lines[i] ?? "";
        const m = re.exec(lineText);
        if (m) {
          matches.push({ path: full, line: i + 1, column: m.index + 1, text: lineText.slice(0, 400) });
          if (matches.length >= opts.max_results) {
            truncated = true;
            return;
          }
        }
      }
    } catch {
      /* ilegible */
    }
  };

  const { stat } = await import("node:fs/promises");
  let rootStat: import("node:fs").Stats;
  try {
    rootStat = await stat(root);
  } catch {
    return { matches, scanned_files: 0, truncated: false };
  }
  if (rootStat.isFile()) {
    await scanFile(root, root.split("/").pop() ?? root);
    return { matches, scanned_files: scanned, truncated };
  }

  const walk = async (dir: string): Promise<void> => {
    if (truncated) return;
    let iter: AsyncIterable<import("node:fs").Dirent>;
    try {
      const { opendir } = await import("node:fs/promises");
      iter = await opendir(dir);
    } catch {
      return;
    }
    for await (const ent of iter) {
      if (truncated) return;
      const full = `${dir}/${ent.name}`;
      if (ent.isDirectory()) {
        if (FALLBACK_SKIP_DIRS.has(ent.name)) continue;
        await walk(full);
      } else if (ent.isFile()) {
        const rel = full.startsWith(root) ? full.slice(root.length + 1) : full;
        await scanFile(full, rel);
      }
    }
  };

  await walk(root);
  return { matches, scanned_files: scanned, truncated };
}

// ══════════════════════════════════════════════════ SCHEMA + TOOL ══════════

const readRangeOp = z.object({
  op: z.literal("read_range"),
  path: z.string().min(1),
  start_line: z.number().int().min(1).default(1),
  end_line: z.number().int().min(1).optional(),
  show_line_numbers: z.boolean().default(true),
  max_lines: z.number().int().min(1).max(5_000).default(400),
});

const writeFullOp = z.object({
  op: z.literal("write_full"),
  path: z.string().min(1),
  content: z.string().max(32 * 1024 * 1024),
  create_parents: z.boolean().default(true),
});

const surgicalReplaceOp = z.object({
  op: z.literal("surgical_replace"),
  path: z.string().min(1),
  old_text: z.string().min(1),
  new_text: z.string(),
  replace_all: z.boolean().default(false),
  expected_matches: z.number().int().min(1).optional(),
  dry_run: z.boolean().default(false),
});

const astOutlineOp = z.object({
  op: z.literal("ast_outline"),
  path: z.string().min(1),
  max_depth: z.number().int().min(1).max(8).default(3),
  max_nodes: z.number().int().min(10).max(20_000).default(2_000),
});

const ripgrepOp = z.object({
  op: z.literal("ripgrep_search"),
  pattern: z.string().min(1),
  path: z.string().default("."),
  glob: z.string().max(200).optional(),
  ignore_case: z.boolean().default(false),
  fixed: z.boolean().default(false),
  word: z.boolean().default(false),
  context_before: z.number().int().min(0).max(20).default(0),
  context_after: z.number().int().min(0).max(20).default(0),
  max_results: z.number().int().min(1).max(5_000).default(200),
  timeout_ms: z.number().int().min(1_000).max(300_000).default(30_000),
});

export const codeSurgerySchema = z.discriminatedUnion("op", [
  readRangeOp,
  writeFullOp,
  surgicalReplaceOp,
  astOutlineOp,
  ripgrepOp,
]);

export type CodeSurgeryInput = z.infer<typeof codeSurgerySchema>;

export const codeSurgeryTool: ToolDefinition<typeof codeSurgerySchema> = {
  name: "code_surgery",
  phase: 1,
  description:
    "Edición de archivos de alta velocidad con APIs nativas de Bun. " +
    "Ops: read_range (líneas), write_full (create/overwrite), surgical_replace " +
    "(bloque exacto + dif unificado, validación de matches, dry_run), " +
    "ast_outline (estructura TS/JS/JSON + heurísticas multi-lenguaje), " +
    "ripgrep_search (rg --json con fallback interno).",
  inputSchema: codeSurgerySchema,
  async handler(input) {
    switch (input.op) {
      case "read_range": {
        const text = await readText(input.path);
        const all = text.split("\n");
        const total = text.endsWith("\n") ? all.length - 1 : all.length;
        const start = input.start_line;
        const end = Math.min(input.end_line ?? start + input.max_lines - 1, total, start + input.max_lines - 1);
        if (start > total) {
          return { path: input.path, total_lines: total, lines: [], note: "start_line fuera de rango" };
        }
        const slice = all.slice(start - 1, end);
        const body = input.show_line_numbers
          ? slice.map((l, i) => `${String(start + i).padStart(6)}| ${l}`).join("\n")
          : slice.join("\n");
        return {
          path: input.path,
          total_lines: total,
          start_line: start,
          end_line: end,
          content: body,
        };
      }

      case "write_full": {
        const { mkdirSync } = await import("node:fs");
        const { dirname } = await import("node:path");
        if (input.create_parents) mkdirSync(dirname(input.path), { recursive: true });
        const before = Bun.file(input.path).size;
        const existed = before > 0 || (await Bun.file(input.path).exists());
        const bytes = await Bun.write(input.path, input.content);
        return {
          path: input.path,
          bytes_written: bytes,
          bytes_before: existed ? before : 0,
          created: !existed,
        };
      }

      case "surgical_replace": {
        const oldAll = await readText(input.path);
        let count = 0;
        let idx = oldAll.indexOf(input.old_text);
        while (idx !== -1) {
          count++;
          idx = oldAll.indexOf(input.old_text, idx + input.old_text.length);
        }

        if (input.expected_matches !== undefined && count !== input.expected_matches) {
          return {
            ok: false,
            path: input.path,
            matches: count,
            expected: input.expected_matches,
            note: "conteo de matches distinto del esperado; nada escrito",
          };
        }
        if (count === 0) {
          const head = input.old_text.slice(0, 200).replace(/\n/g, "\\n");
          return {
            ok: false,
            path: input.path,
            matches: 0,
            note: `bloque old_text no encontrado (primeros 200 chars: ${head})`,
          };
        }
        if (count > 1 && !input.replace_all) {
          return {
            ok: false,
            path: input.path,
            matches: count,
            note: `old_text aparece ${count} veces; usa replace_all=true o expected_matches para desambiguar`,
          };
        }

        const newAll = input.replace_all
          ? oldAll.split(input.old_text).join(input.new_text)
          : oldAll.replace(input.old_text, input.new_text);

        const stats = diffStats(oldAll, newAll);
        const diff = unifiedDiff(oldAll, newAll, input.path);
        let written = 0;
        if (!input.dry_run) written = await Bun.write(input.path, newAll);

        return {
          ok: true,
          path: input.path,
          replacements: count,
          dry_run: input.dry_run,
          bytes_before: oldAll.length,
          bytes_after: newAll.length,
          added: stats.added,
          removed: stats.removed,
          written,
          diff,
        };
      }

      case "ast_outline": {
        const lang = langOf(input.path);
        const text = await readText(input.path, OUTLINE_MAX_BYTES);
        let nodes: OutlineNode[];
        let engine: string;

        if (lang === "json") {
          nodes = outlineJson(text, input.max_depth, input.max_nodes);
          engine = "json-lines";
        } else if (
          ["typescript", "typescriptreact", "javascript", "javascriptreact"].includes(lang)
        ) {
          const kind =
            input.path.endsWith(".tsx") || input.path.endsWith(".jsx")
              ? ts.ScriptKind.TSX
              : input.path.endsWith(".ts")
                ? ts.ScriptKind.TS
                : ts.ScriptKind.JS;
          const sf = ts.createSourceFile(input.path, text, ts.ScriptTarget.Latest, false, kind);
          nodes = outlineTs(sf, input.max_depth, input.max_nodes);
          engine = "typescript-compiler-api";
        } else {
          nodes = outlineGeneric(text, input.max_nodes);
          engine = "heuristic-regex";
        }

        return {
          path: input.path,
          language: lang,
          engine,
          total_lines: lineCount(text),
          nodes,
        };
      }

      case "ripgrep_search": {
        const rgCheck = await run(["rg", "--version"], { timeout_ms: 3_000, max_bytes: 1_024 });
        const available = rgCheck.exit_code === 0 && rgCheck.stdout.startsWith("ripgrep");

        if (available) {
          const args = ["rg", "--json", "--color", "never", "--no-messages"];
          if (input.ignore_case) args.push("-i");
          if (input.fixed) args.push("-F");
          if (input.word) args.push("-w");
          if (input.context_before > 0) args.push("-B", String(input.context_before));
          if (input.context_after > 0) args.push("-A", String(input.context_after));
          if (input.glob) args.push("--glob", input.glob);
          args.push("-e", input.pattern, "--", input.path);

          const res = await run(args, {
            timeout_ms: input.timeout_ms,
            max_bytes: 8 * 1024 * 1024,
          });
          if (res.exit_code === 2 && res.stderr) {
            return { ok: false, engine: "ripgrep", error: res.stderr.slice(0, 500) };
          }

          const matches: RgMatch[] = [];
          let truncated = false;
          let files = 0;
          for (const raw of res.stdout.split("\n")) {
            if (!raw) continue;
            if (matches.length >= input.max_results) {
              truncated = true;
              break;
            }
            try {
              const ev = JSON.parse(raw) as {
                type: string;
                data?: {
                  path?: { text: string };
                  lines?: { text: string };
                  line_number?: number;
                  submatches?: Array<{ match: { text: string }; start: number }>;
                  stats?: { searched_paths_count?: number };
                };
              };
              if (ev.type === "match" && ev.data?.path && ev.data.line_number !== undefined) {
                const textLine = (ev.data.lines?.text ?? "").replace(/\n$/, "");
                const start = ev.data.submatches?.[0]?.start ?? 0;
                matches.push({
                  path: ev.data.path.text,
                  line: ev.data.line_number,
                  column: start + 1,
                  text: textLine.slice(0, 400),
                });
              } else if (ev.type === "summary" && ev.data?.stats?.searched_paths_count !== undefined) {
                files = ev.data.stats.searched_paths_count;
              }
            } catch {
              /* línea parcial */
            }
          }
          if (res.timed_out) truncated = true;
          return {
            ok: true,
            engine: "ripgrep",
            pattern: input.pattern,
            count: matches.length,
            files,
            truncated: truncated || res.truncated,
            matches,
          };
        }

        log.warn("rg no disponible; usando fallback interno");
        const root = input.path;
        try {
          const { stat } = await import("node:fs/promises");
          await stat(root);
        } catch {
          return { ok: false, engine: "fallback", error: `path no existe: ${root}` };
        }
        const fb = await rgFallback(input.pattern, root, {
          glob: input.glob,
          ignore_case: input.ignore_case,
          fixed: input.fixed,
          word: input.word,
          max_results: input.max_results,
        });
        return {
          ok: true,
          engine: "fallback",
          pattern: input.pattern,
          count: fb.matches.length,
          scanned_files: fb.scanned_files,
          truncated: fb.truncated,
          matches: fb.matches,
        };
      }

      default: {
        const _exhaustive: never = input;
        return _exhaustive;
      }
    }
  },
};
