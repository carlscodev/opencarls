/**
 * OpenCarls — zod 3 → JSON Schema (draft-07) para `tools` de chat/completions
 * y /responses. Cubre exhaustivamente los tipos usados por el catálogo
 * nativo + skills: object/record/array/tuple/union/discriminatedUnion/enum/
 * literal/string/number/int/boolean/null/optional/default/nullable/effects/
 * pipe/any/unknown/branded/promise. Nunca lanza: cae a `{}` (acepta todo).
 */
import type { z } from "zod";

type Json = Record<string, unknown>;

interface Ctx {
  seen: Set<z.ZodTypeAny>;
}

function defOf(schema: z.ZodTypeAny): z.ZodTypeDef {
  return (schema as unknown as { _def: z.ZodTypeDef })._def;
}


/** Checks híbridos de zod 3.25+: legacy {kind,value} o {$ZodCheck*._zod.def}. */
interface CheckInfo {
  kind: string;
  value: unknown;
  format?: string | undefined;
  pattern?: RegExp | undefined;
}
function readChecks(schema: z.ZodTypeAny): CheckInfo[] {
  const d = defOf(schema) as unknown as { checks?: unknown[] };
  const raw = Array.isArray(d.checks) ? d.checks : [];
  const out: CheckInfo[] = [];
  for (const c of raw) {
    const o = c as Record<string, unknown> & { _zod?: { def?: Record<string, unknown> } };
    const zd = o?._zod?.def;
    const kind =
      (typeof o?.kind === "string" ? o.kind : undefined) ??
      (typeof zd?.check === "string" ? (zd.check as string) : undefined);
    if (!kind) continue;
    const value =
      o?.value ??
      (kind === "min_length" || kind === "greater_than" ? zd?.minimum ?? zd?.value : undefined) ??
      (kind === "max_length" || kind === "less_than" ? zd?.maximum ?? zd?.value : undefined) ??
      zd?.value;
    out.push({
      kind,
      value,
      format: (zd?.format as string | undefined) ?? (o?.format as string | undefined),
      pattern: (zd?.pattern as RegExp | undefined) ?? (o?.regex as RegExp | undefined),
    });
  }
  return out;
}

function typeName(schema: z.ZodTypeAny): string {
  const d = defOf(schema) as unknown as { typeName?: string };
  if (typeof d.typeName === "string" && d.typeName) return d.typeName;
  const ctor = (schema as unknown as { constructor?: { name?: string } }).constructor;
  return ctor?.name ?? "Unknown";
}

function convert(schema: z.ZodTypeAny, ctx: Ctx): Json {
  if (ctx.seen.has(schema)) return {}; // recursión defensiva
  ctx.seen.add(schema);
  try {
    return convertInner(schema, ctx);
  } catch {
    return {};
  } finally {
    ctx.seen.delete(schema);
  }
}

function convertInner(schema: z.ZodTypeAny, ctx: Ctx): Json {
  const d = defOf(schema) as Record<string, unknown>;
  const kind =
    (typeof d.type === "string" ? d.type : undefined) ??
    typeName(schema).replace(/^Zod/, "").toLowerCase();

  switch (kind) {
    case "string": {
      const out: Json = { type: "string" };
      for (const c of readChecks(schema)) {
        if (c.kind === "min" || c.kind === "min_length") out.minLength = c.value;
        else if (c.kind === "max" || c.kind === "max_length") out.maxLength = c.value;
        else if (c.kind === "email" || c.format === "email") out.format = "email";
        else if (c.kind === "url" || c.format === "url") out.format = "uri";
        else if (c.kind === "uuid" || c.format === "uuid") out.format = "uuid";
        else if ((c.kind === "regex" || c.kind === "string_format") && c.pattern) {
          out.pattern = c.pattern instanceof RegExp ? c.pattern.source : String(c.pattern);
        }
      }
      return out;
    }
    case "number":
    case "bigint": {
      const out: Json = { type: "number" };
      for (const c of readChecks(schema)) {
        if (c.kind === "int" || (c.kind === "number_format" && (c.format === "safeint" || c.format === "int"))) {
          out.type = "integer";
        } else if (c.kind === "min" || c.kind === "greater_than") out.minimum = c.value;
        else if (c.kind === "max" || c.kind === "less_than") out.maximum = c.value;
      }
      return out;
    }
    case "boolean":
      return { type: "boolean" };
    case "null":
      return { type: "null" };
    case "undefined":
      return { not: {} };
    case "literal": {
      const v = d.value;
      const t = v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
      return { type: t === "number" ? "number" : t, const: v };
    }
    case "enum": {
      // zod 3: _def.values[] · zod 4: _def.entries{}
      const rawValues = Array.isArray(d.values)
        ? (d.values as unknown[])
        : Object.values((d.entries ?? d.values ?? {}) as Record<string, unknown>);
      const values2 = rawValues.filter(
        (v) => typeof v === "string" || typeof v === "number" || typeof v === "boolean",
      ) as Array<string | number | boolean>;
      const types = new Set(values2.map((v) => typeof v));
      return {
        ...(types.size === 1 ? { type: [...types][0] } : {}),
        enum: values2,
      };
    }
    case "nativeEnum": {
      const values = Object.values((d.values ?? d.entries ?? {}) as Record<string, unknown>).filter(
        (v) => typeof v === "string" || typeof v === "number",
      );
      const types = new Set(values.map((v) => typeof v));
      return { ...(types.size === 1 ? { type: [...types][0] } : {}), enum: values };
    }
    case "array": {
      const out: Json = { type: "array" };
      // zod 3 clásico: el elemento vive en `_def.type` (que NO es string);
      // zod 4 / híbrido: `_def.element`.
      const element = (d.element ?? (typeof d.type !== "string" ? d.type : undefined)) as
        | z.ZodTypeAny
        | undefined;
      if (element && typeof element === "object" && "_def" in element) {
        out.items = convert(element, ctx);
      }
      // zod 3 clásico: def.minLength/maxLength/exactLength directos
      const minL = (d.minLength as { value?: number } | undefined)?.value;
      const maxL = (d.maxLength as { value?: number } | undefined)?.value;
      const exactL = (d.exactLength as { value?: number } | undefined)?.value;
      if (minL !== undefined) out.minItems = minL;
      if (maxL !== undefined) out.maxItems = maxL;
      if (exactL !== undefined) {
        out.minItems = exactL;
        out.maxItems = exactL;
      }
      // híbrido/zod4: checks con kind
      for (const c of readChecks(schema)) {
        if (c.kind === "min" || c.kind === "min_length") out.minItems = c.value;
        else if (c.kind === "max" || c.kind === "max_length") out.maxItems = c.value;
      }
      return out;
    }
    case "tuple": {
      const items = (d.items ?? []) as z.ZodTypeAny[];
      return {
        type: "array",
        prefixItems: items.map((it) => convert(it, ctx)),
        minItems: items.length,
        maxItems: items.length,
      };
    }
    case "object":
    case "discriminatedUnion": {
      const rawShape = (d.shape ?? {}) as Record<string, z.ZodTypeAny> | (() => Record<string, z.ZodTypeAny>);
      const shape = (typeof rawShape === "function" ? (rawShape as () => Record<string, z.ZodTypeAny>)() : rawShape) as Record<string, z.ZodTypeAny>;
      const properties: Record<string, Json> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = convert(value, ctx);
        if (!isOptional(value)) required.push(key);
      }
      const out: Json = { type: "object", properties };
      if (required.length) out.required = required;
      if (d.unknownKeys === "strict") out.additionalProperties = false;
      if (kind === "discriminatedUnion") {
        const disc = d.discriminator as string | undefined;
        if (disc) {
          out.properties = { ...properties, [disc]: properties[disc] ?? { type: "string" } };
          if (!required.includes(disc)) required.push(disc);
          out.required = required;
        }
      }
      return out;
    }
    case "record":
    case "map": {
      const valueType = (d.valueType ?? d.value) as z.ZodTypeAny | undefined;
      return {
        type: "object",
        additionalProperties: valueType ? convert(valueType, ctx) : true,
      };
    }
    case "union":
    case "anyOf": {
      const options = (d.options ?? []) as z.ZodTypeAny[];
      if (options.length === 1) return convert(options[0]!, ctx);
      return { anyOf: options.map((o) => convert(o, ctx)) };
    }
    case "intersection": {
      const left = convert(d.left as z.ZodTypeAny, ctx);
      const right = convert(d.right as z.ZodTypeAny, ctx);
      return { allOf: [left, right] };
    }
    case "optional": {
      const inner = convert(d.innerType as z.ZodTypeAny, ctx);
      return inner;
    }
    case "nullable":
      return { anyOf: [convert(d.innerType as z.ZodTypeAny, ctx), { type: "null" }] };
    case "default": {
      const inner = convert(d.innerType as z.ZodTypeAny, ctx);
      const dv = d.defaultValue;
      return { ...inner, default: typeof dv === "function" ? (dv as () => unknown)() : dv };
    }
    case "catch": {
      return convert(d.innerType as z.ZodTypeAny, ctx);
    }
    case "effects":
    case "pipe": {
      // effects: usa el esquema ORIGINAL si existe; pipe: schema de entrada
      const src = (d.schema ?? d.in) as z.ZodTypeAny | undefined;
      return src ? convert(src, ctx) : {};
    }
    case "branded":
    case "readonly":
    case "promise":
    case "lazy": {
      const inner = (d.innerType ?? d.getter) as z.ZodTypeAny | (() => z.ZodTypeAny) | undefined;
      if (typeof inner === "function") return convert((inner as () => z.ZodTypeAny)(), ctx);
      return inner ? convert(inner as z.ZodTypeAny, ctx) : {};
    }
    case "any":
    case "unknown":
      return {};
    case "void":
      return {};
    default: {
      // último recurso: intentar innerType
      const inner = (d as { innerType?: z.ZodTypeAny }).innerType;
      return inner ? convert(inner, ctx) : {};
    }
  }
}

function isOptional(schema: z.ZodTypeAny): boolean {
  const t = typeName(schema);
  if (t === "ZodOptional" || t === "ZodDefault") return true;
  const kind =
    (defOf(schema) as { type?: string }).type ?? typeName(schema).replace(/^Zod/, "").toLowerCase();
  if (kind === "optional" || kind === "default") return true;
  if (kind === "effects" || kind === "pipe") {
    const src = (defOf(schema) as { schema?: z.ZodTypeAny }).schema;
    return src ? isOptional(src) : false;
  }
  return schema.isOptional();
}

/** Convierte un zod schema a JSON Schema draft-07 (nunca lanza). */
export function zodToJsonSchema(schema: z.ZodTypeAny): Json {
  try {
    return convert(schema, { seen: new Set() });
  } catch {
    return {};
  }
}

/** Tool definition → payload `tools` de chat/completions (function type). */
export function toOpenAiTool(def: {
  name: string;
  description: string;
  inputSchema?: z.ZodTypeAny;
  jsonSchema?: unknown;
}): { type: "function"; function: { name: string; description: string; parameters: Json } } {
  const parameters =
    def.jsonSchema && typeof def.jsonSchema === "object"
      ? (def.jsonSchema as Json)
      : def.inputSchema
        ? zodToJsonSchema(def.inputSchema)
        : { type: "object", properties: {} };
  return {
    type: "function",
    function: {
      name: def.name,
      description: def.description.trim().replace(/\s+/g, " ").slice(0, 4_000),
      parameters: parameters.type ? parameters : { ...parameters, type: "object" },
    },
  };
}
