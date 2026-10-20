/**
 * OpenCarls — skill_forge: forja y ejecución de skills reutilizables.
 *
 * Estructura por skill (bajo CONFIG.skills_dir = .agent/skills/):
 *   <slug>/SKILL.md     frontmatter (name/description/triggers/version) + guía
 *   <slug>/schema.json  { name, description, parameters: JSON Schema }
 *   <slug>/tool.ts      export async function handler(input, ctx) [+ inputSchema]
 *
 * ops: create | refine (version++) | search (FTS5) | execute | hot_reload.
 * execute/hot_reload importan el módulo con `import(path + "?t=" + Date.now())`
 * (cache-busting) por lo que las refinamientos aplican al instante, sin
 * reiniciar el proceso.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { AnyToolDefinition, ToolContext, ToolResult } from "../types";
import { CONFIG } from "../core/config";
import { createLogger } from "../core/logger";
import {
  bumpSkillStats,
  getSkill,
  registerSkill,
  searchSkills,
} from "../memory/db";

// Contrato del registry: devolver la data CRUDA; errores → throw
// (el registry envuelve con ok()/fail() y captura excepciones).
const ok = <T,>(data: T): T => data;
const fail = (message: string): never => {
  throw new Error(message);
};

const log = createLogger("skill_forge");

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
}

function skillDir(slug: string): string {
  return join(CONFIG.skills_dir, slug);
}

function bumpPatch(version: string): string {
  const parts = version.split(".").map((n) => Number(n));
  const [maj = 0, min = 0, pat = 0] = [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
  return `${maj}.${min}.${pat + 1}`;
}

function renderSkillMd(meta: {
  name: string;
  description: string;
  triggers: string[];
  version: string;
  body: string;
}): string {
  return [
    "---",
    `name: ${JSON.stringify(meta.name)}`,
    `description: ${JSON.stringify(meta.description)}`,
    `triggers: [${meta.triggers.map((t) => JSON.stringify(t)).join(", ")}]`,
    `version: ${meta.version}`,
    "updated_at: " + new Date().toISOString(),
    "---",
    "",
    meta.body.trim(),
    "",
  ].join("\n");
}

function readSkillDir(slug: string): {
  md: { name: string; description: string; triggers: string[]; version: string; body: string };
  schema: { name: string; description: string; parameters: unknown } | null;
  code: string | null;
} {
  const dir = skillDir(slug);
  const mdPath = join(dir, "SKILL.md");
  if (!existsSync(mdPath)) throw new Error(`skill no existe: ${slug}`);
  const raw = readFileSync(mdPath, "utf8");
  const fm = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
  const front = fm?.[1] ?? "";
  const body = fm?.[2] ?? raw;
  const pick = (k: string): string =>
    new RegExp(`^${k}:\\s*(.+)$`, "m").exec(front)?.[1]?.trim() ?? "";
  let name = pick("name");
  let description = pick("description");
  let version = pick("version") || "0.1.0";
  let triggers: string[] = [];
  const trigLine = new RegExp(`^triggers:\\s*(.+)$`, "m").exec(front)?.[1]?.trim();
  if (trigLine) {
    try {
      const parsed = JSON.parse(
        trigLine.startsWith("[") ? trigLine : `[${trigLine}]`,
      );
      if (Array.isArray(parsed)) triggers = parsed.map(String);
    } catch {
      triggers = trigLine
        .replace(/^\[|\]$/g, "")
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
    }
  }
  name = name.replace(/^"(.*)"$/, "$1");
  description = description.replace(/^"(.*)"$/, "$1");
  const schemaPath = join(dir, "schema.json");
  const schema = existsSync(schemaPath)
    ? (JSON.parse(readFileSync(schemaPath, "utf8")) as {
        name: string;
        description: string;
        parameters: unknown;
      })
    : null;
  const toolPath = join(dir, "tool.ts");
  const code = existsSync(toolPath) ? readFileSync(toolPath, "utf8") : null;
  return { md: { name, description, triggers, version, body: body.trim() }, schema, code };
}

interface SkillModule {
  handler: (input: unknown, ctx?: unknown) => Promise<unknown> | unknown;
  inputSchema?: z.ZodTypeAny;
}

let importSeq = 0;

/** `import(file?t=…)` → recarga sin reiniciar (hot); secuencia única para
 *  evitar colisiones de Date.now() en el mismo milisegundo. */
async function importSkill(slug: string): Promise<SkillModule> {
  const toolPath = join(skillDir(slug), "tool.ts");
  if (!existsSync(toolPath)) throw new Error(`tool.ts ausente: ${slug}`);
  // NOTA: Bun descarta `?query` en URLs file:// — se usa ruta ABSOLUTA + query.
  const url = toolPath + "?t=" + Date.now() + "_" + ++importSeq;
  const mod = (await import(url)) as Partial<SkillModule>;
  if (typeof mod.handler !== "function") {
    throw new Error(`tool.ts de ${slug} no exporta handler(input, ctx)`);
  }
  return mod as SkillModule;
}

function validateLite(schema: unknown, input: unknown): string | null {
  if (!schema || typeof schema !== "object") return null;
  const s = schema as { required?: string[]; properties?: Record<string, { type?: string }> };
  if (Array.isArray(s.required) && input && typeof input === "object") {
    const obj = input as Record<string, unknown>;
    for (const key of s.required) {
      if (obj[key] === undefined) return `falta el campo requerido: ${key}`;
    }
  }
  return null;
}

export const skillForgeTool: AnyToolDefinition = {
  name: "skill_forge",
  phase: 2,
  description:
    "Forja de skills reutilizables en .agent/skills/<slug>/ (SKILL.md + " +
    "schema.json + tool.ts). ops: create (forja), refine (edita y sube " +
    "version++), search (FTS5 sobre el registro), execute (corre handler con " +
    "import cache-busted), hot_reload (reimporta y reporta exports).",
  inputSchema: z.object({
    op: z.enum(["create", "refine", "search", "execute", "hot_reload"]),
    slug: z.string().min(2).max(64).optional(),
    name: z.string().min(1).max(120).optional(),
    description: z.string().min(1).max(2_000).optional(),
    triggers: z.array(z.string().min(1).max(120)).max(30).optional(),
    instructions: z.string().max(100_000).optional(),
    parameters: z.record(z.unknown()).optional().describe("JSON Schema de params"),
    code: z.string().min(40).max(400_000).optional().describe("TS con export handler"),
    input: z.record(z.unknown()).optional().describe("payload para execute"),
    query: z.string().min(1).max(200).optional(),
    limit: z.number().int().min(1).max(50).default(10),
    overwrite: z.boolean().default(false),
  }),
  async handler(raw, ctx): Promise<unknown> {
    const i = raw as {
      op: "create" | "refine" | "search" | "execute" | "hot_reload";
      slug?: string;
      name?: string;
      description?: string;
      triggers?: string[];
      instructions?: string;
      parameters?: Record<string, unknown>;
      code?: string;
      input?: Record<string, unknown>;
      query?: string;
      limit: number;
      overwrite: boolean;
    };
    const started = Date.now();
    try {
      switch (i.op) {
        case "create": {
          const slug = i.slug ? i.slug : slugify(i.name ?? "");
          if (!SLUG_RE.test(slug)) {
            return fail(`slug inválido '${slug}' (minúsculas, dígitos, guiones)`);
          }
          if (!i.name || !i.description || !i.instructions || !i.code) {
            return fail("create requiere name, description, instructions y code");
          }
          if (!/export\s+(async\s+)?function\s+handler/.test(i.code)) {
            return fail("code debe contener `export (async) function handler(input, ctx)`");
          }
          const dir = skillDir(slug);
          if (existsSync(join(dir, "SKILL.md")) && !i.overwrite) {
            return fail(`skill '${slug}' ya existe — usa refine u overwrite=true`);
          }
          mkdirSync(dir, { recursive: true });
          const version = "0.1.0";
          const triggers = i.triggers ?? [];
          writeFileSync(
            join(dir, "SKILL.md"),
            renderSkillMd({
              name: i.name,
              description: i.description,
              triggers,
              version,
              body: i.instructions,
            }),
            "utf8",
          );
          writeFileSync(
            join(dir, "schema.json"),
            JSON.stringify(
              {
                name: slug,
                description: i.description,
                parameters: i.parameters ?? { type: "object", properties: {} },
              },
              null,
              2,
            ) + "\n",
            "utf8",
          );
          writeFileSync(join(dir, "tool.ts"), i.code.endsWith("\n") ? i.code : i.code + "\n", "utf8");
          registerSkill({
            slug,
            name: i.name,
            description: i.description,
            triggers,
            version,
            path: dir,
            status: "active",
            source_task: ctx?.session_id ?? null,
          });
          log.info("skill creado", { slug, version });
          return ok({ slug, version, path: dir, files: ["SKILL.md", "schema.json", "tool.ts"] });
        }

        case "refine": {
          if (!i.slug) return fail("refine requiere `slug`");
          const existing = getSkill(i.slug);
          if (!existing) return fail(`skill inexistente: ${i.slug}`);
          const cur = readSkillDir(i.slug);
          const version = bumpPatch(existing.version);
          const description = i.description ?? existing.description;
          const name = i.name ?? existing.name;
          const triggers = i.triggers ?? JSON.parse(existing.triggers || "[]");
          const body = i.instructions ?? cur.md.body;
          writeFileSync(
            join(skillDir(i.slug), "SKILL.md"),
            renderSkillMd({ name, description, triggers, version, body }),
            "utf8",
          );
          if (i.parameters || i.description) {
            writeFileSync(
              join(skillDir(i.slug), "schema.json"),
              JSON.stringify(
                {
                  name: i.slug,
                  description,
                  parameters: i.parameters ?? cur.schema?.parameters ?? { type: "object", properties: {} },
                },
                null,
                2,
              ) + "\n",
              "utf8",
            );
          }
          if (i.code) {
            if (!/export\s+(async\s+)?function\s+handler/.test(i.code)) {
              return fail("code debe contener `export (async) function handler(input, ctx)`");
            }
            writeFileSync(
              join(skillDir(i.slug), "tool.ts"),
              i.code.endsWith("\n") ? i.code : i.code + "\n",
              "utf8",
            );
          }
          // re-registro (upsert preserva success_count) con status activo
          registerSkill({
            slug: i.slug,
            name,
            description,
            triggers,
            version,
            path: skillDir(i.slug),
            status: "active",
          });
          log.info("skill refinado", { slug: i.slug, version });
          return ok({
            slug: i.slug,
            version,
            hot: "el siguiente execute/hot_reload usa import con ?t= (sin reiniciar)",
          });
        }

        case "search": {
          if (!i.query) return fail("search requiere `query`");
          const rows = searchSkills(i.query, i.limit);
          return ok({
            count: rows.length,
            skills: rows.map((r) => ({
              slug: r.slug,
              name: r.name,
              description: r.description,
              version: r.version,
              status: r.status,
              success_count: r.success_count,
              fail_count: r.fail_count,
              score: r.success_count + r.fail_count > 0
                ? Math.round((r.success_count / (r.success_count + r.fail_count)) * 100)
                : null,
            })),
          });
        }

        case "execute": {
          if (!i.slug) return fail("execute requiere `slug`");
          const meta = getSkill(i.slug);
          if (!meta) return fail(`skill inexistente: ${i.slug}`);
          const { schema } = readSkillDir(i.slug);
          let payload = i.input ?? {};
          let mod: SkillModule;
          try {
            mod = await importSkill(i.slug);
          } catch (e) {
            bumpSkillStats(i.slug, false);
            return fail(`import falló: ${e instanceof Error ? e.message : String(e)}`);
          }
          if (mod.inputSchema) {
            const parsed = mod.inputSchema.safeParse(payload);
            if (!parsed.success) {
              return fail(`input inválido: ${parsed.error.issues.slice(0, 3).map((x) => `${x.path.join(".")}: ${x.message}`).join("; ")}`);
            }
            payload = parsed.data as Record<string, unknown>;
          }
          const lite = validateLite(schema?.parameters, payload);
          if (lite) return fail(lite);
          try {
            const out = await mod.handler(payload, ctx);
            bumpSkillStats(i.slug, true);
            return ok({
              slug: i.slug,
              result: out,
              duration_ms: Date.now() - started,
              reloaded: true,
            });
          } catch (e) {
            bumpSkillStats(i.slug, false);
            return fail(`handler lanzó: ${e instanceof Error ? e.message : String(e)}`);
          }
        }

        case "hot_reload": {
          if (!i.slug) return fail("hot_reload requiere `slug`");
          const meta = getSkill(i.slug);
          if (!meta) return fail(`skill inexistente: ${i.slug}`);
          try {
            const mod = await importSkill(i.slug);
            const exports = Object.keys(mod);
            return ok({
              slug: i.slug,
              reloaded: true,
              exports,
              has_handler: typeof mod.handler === "function",
              has_zod_schema: Boolean(mod.inputSchema),
              version: meta.version,
              duration_ms: Date.now() - started,
            });
          } catch (e) {
            return fail(`hot_reload falló: ${e instanceof Error ? e.message : String(e)}`);
          }
        }

        default:
          return fail(`op desconocida: ${String(i.op)}`);
      }
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
  },
} as AnyToolDefinition;

void (undefined as ToolContext | undefined);
