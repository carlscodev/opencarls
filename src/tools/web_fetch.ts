/**
 * OpenCarls — web_fetch: URL → Markdown limpio.
 *
 * Usa Bun nativo (HTMLRewriter + fetch). Elimina ruido (scripts, estilos,
 * nav/footer/aside/form/ads), convierte encabezados, listas, tablas, enlaces
 * (absolutizados), imágenes y bloques de código a Markdown, y decodifica
 * entidades. Respeta timeouts, tamaño máximo y content-type.
 */
import { z } from "zod";
import type { AnyToolDefinition, ToolResult } from "../types";

// Contrato del registry: devolver la data CRUDA; errores → throw
// (el registry envuelve con ok()/fail() y captura excepciones).
const ok = <T,>(data: T): T => data;
const fail = (message: string): never => {
  throw new Error(message);
};

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 OpenCarls/0.1";

const NOISE_SELECTORS = [
  "script", "style", "noscript", "template", "iframe", "svg", "canvas",
  "nav", "footer", "aside", "form", "button",
  "[role=navigation]", "[role=banner]", "[role=contentinfo]",
  "[aria-hidden=true]", "[class*=cookie]", "[class*=newsletter]",
  "[id*=cookie]", "[class*=advertisement]", "[id*=div-gpt-ad]",
];

function decodeEntities(s: string): string {
  const named: Record<string, string> = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
    ndash: "–", mdash: "—", hellip: "…", laquo: "«", raquo: "»",
    copy: "©", reg: "®", trade: "™", deg: "°", middot: "·", bull: "•",
  };
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex: string) => {
      try { return String.fromCodePoint(Number.parseInt(hex, 16)); } catch { return ""; }
    })
    .replace(/&#(\d+);/g, (_m, dec: string) => {
      try { return String.fromCodePoint(Number.parseInt(dec, 10)); } catch { return ""; }
    })
    .replace(/&([a-zA-Z]+);/g, (m, name: string) => named[name] ?? m);
}

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

function absolutize(href: string | undefined, base: string): string {
  if (!href) return "";
  try { return new URL(href, base).toString(); } catch { return href; }
}

const FENCE_MARK = "\u0001FENCE";

/** HTML (ya sin ruido) → Markdown. */
export function htmlToMarkdown(html: string, baseUrl: string): string {
  let out = html.replace(/<!--[\s\S]*?-->/g, "");

  const fences: string[] = [];
  out = out.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_m, inner: string) => {
    const code = decodeEntities(inner.replace(/<[^>]*>/g, ""));
    fences.push("```\n" + code.replace(/\n{3,}/g, "\n\n").trimEnd() + "\n```");
    return "\n\n" + FENCE_MARK + (fences.length - 1) + "\n\n";
  });

  out = out.replace(
    /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi,
    (_m, lvl: string, inner: string) =>
      "\n\n" + "#".repeat(Number(lvl)) + " " + stripTags(inner) + "\n\n",
  );

  out = out.replace(/<img[^>]*>/gi, (tag) => {
    const src = /src=["']([^"']+)["']/i.exec(tag)?.[1];
    const alt = /alt=["']([^"']*)["']/i.exec(tag)?.[1] ?? "";
    if (!src || src.startsWith("data:")) return "";
    return "![" + stripTags(alt) + "](" + absolutize(src, baseUrl) + ")";
  });

  out = out.replace(
    /<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_m, href: string, inner: string) => {
      const text = stripTags(inner);
      const url = absolutize(href, baseUrl);
      if (!text && !url) return "";
      if (!text) return "<" + url + ">";
      if (!url || url.startsWith("javascript:")) return text;
      return "[" + text + "](" + url + ")";
    },
  );

  out = out.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, inner: string) => {
    const cleaned = stripTags(inner);
    return cleaned ? "\n- " + cleaned : "\n";
  });
  out = out.replace(/<\/?(ul|ol|menu)[^>]*>/gi, "\n");

  out = out.replace(/<table[^>]*>([\s\S]*?)<\/table>/gi, (_m, inner: string) => {
    const rows: string[][] = [];
    const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let rm: RegExpExecArray | null;
    while ((rm = rowRe.exec(inner))) {
      const cells: string[] = [];
      const cellRe = /<(t[hd])[^>]*>([\s\S]*?)<\/t[hd]>/gi;
      let cm: RegExpExecArray | null;
      while ((cm = cellRe.exec(rm[1] ?? ""))) cells.push(stripTags(cm[2] ?? ""));
      if (cells.length) rows.push(cells);
    }
    if (rows.length === 0) return "";
    const header = rows[0] ?? [];
    const sep = header.map(() => "---");
    const body = rows.slice(1).map((r) => r.map((c) => c.replace(/\|/g, "\\|")));
    return (
      "\n\n" +
      [header, sep, ...body].map((r) => "| " + r.join(" | ") + " |").join("\n") +
      "\n\n"
    );
  });

  out = out.replace(
    /<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi,
    (_m, inner: string) => "\n\n> " + stripTags(inner) + "\n\n",
  );

  out = out.replace(
    /<(p|div|section|article|header|main|figure|figcaption|dl|dt|dd|hr|br)(\s[^>]*)?\/?>/gi,
    "\n\n",
  );
  out = out.replace(
    /<\/(p|div|section|article|header|main|figure|figcaption|dl|dt|dd)>/gi,
    "\n\n",
  );

  out = out.replace(/<[^>]+>/g, " ");
  out = decodeEntities(out);
  out = out.replace(
    new RegExp(FENCE_MARK + "(\\d+)", "g"),
    (_m, idx: string) => fences[Number(idx)] ?? "",
  );

  return out
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function stripNoise(html: string): Promise<string> {
  let rewriter = new HTMLRewriter();
  for (const sel of NOISE_SELECTORS) {
    rewriter = rewriter.on(sel, {
      element(el) {
        el.remove();
      },
    });
  }
  const res = rewriter.transform(
    new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } }),
  );
  return res.text();
}

export const webFetchTool: AnyToolDefinition = {
  name: "web_fetch",
  phase: 2,
  description:
    "Descarga una URL (http/https, con timeout y tope de bytes) y devuelve " +
    "Markdown limpio: sin scripts/estilos/nav/footer/ads, encabezados, listas, " +
    "tablas, enlaces absolutos y bloques de código preservados. JSON → fence.",
  inputSchema: z.object({
    url: z.string().url("url inválida"),
    max_bytes: z.number().int().min(1_024).max(8_000_000).default(2_000_000),
    timeout_ms: z.number().int().min(1_000).max(120_000).default(30_000),
    markdown: z.boolean().default(true),
    extract_title: z.boolean().default(true),
  }),
  async handler(input): Promise<unknown> {
    const { url, max_bytes, timeout_ms, markdown, extract_title } = input as {
      url: string;
      max_bytes: number;
      timeout_ms: number;
      markdown: boolean;
      extract_title: boolean;
    };
    if (!/^https?:\/\//i.test(url)) return fail("solo http/https: " + url);
    const started = Date.now();
    let res: Response;
    try {
      res = await fetch(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(timeout_ms),
        headers: {
          "user-agent": UA,
          accept: "text/html,application/xhtml+xml,application/json,text/plain,*/*;q=0.8",
          "accept-language": "es-ES,es;q=0.9,en;q=0.8",
        },
      });
    } catch (e) {
      return fail("fetch falló: " + (e instanceof Error ? e.message : String(e)));
    }
    if (!res.ok) return fail("HTTP " + res.status + " para " + url);

    const ctype = res.headers.get("content-type") ?? "";
    const finalUrl = res.url || url;

    const reader = res.body?.getReader();
    if (!reader) return fail("respuesta sin body");
    const chunks: Uint8Array[] = [];
    let total = 0;
    let truncated = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > max_bytes) {
        const keep = Math.max(value.byteLength - (total - max_bytes), 0);
        chunks.push(value.subarray(0, keep));
        total = max_bytes;
        truncated = true;
        try { await reader.cancel(); } catch { /* noop */ }
        break;
      }
      chunks.push(value);
    }
    const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    const charset = /charset=([\w-]+)/i.exec(ctype)?.[1]?.toLowerCase();
    const bodyText = buf.toString(
      charset && charset !== "utf-8" ? (charset as BufferEncoding) : "utf8",
    );

    if (ctype.includes("application/json")) {
      let pretty = bodyText;
      try { pretty = JSON.stringify(JSON.parse(bodyText), null, 2); } catch { /* crudo */ }
      return ok({
        url, final_url: finalUrl, status: res.status, content_type: ctype, title: null,
        markdown: markdown ? "```json\n" + pretty + "\n```" : pretty,
        bytes: total, truncated, fetched_ms: Date.now() - started,
      });
    }

    if (ctype.startsWith("image/")) {
      return ok({
        url, final_url: finalUrl, status: res.status, content_type: ctype, title: null,
        markdown: "*(imagen " + ctype + ", " + total + " bytes — usar image_search)*",
        bytes: total, truncated, fetched_ms: Date.now() - started,
      });
    }

    const isHtml = ctype.includes("html") || /^\s*<(!doctype|html)/i.test(bodyText);
    if (!isHtml) {
      return ok({
        url, final_url: finalUrl, status: res.status, content_type: ctype, title: null,
        markdown: bodyText,
        bytes: total, truncated, fetched_ms: Date.now() - started,
      });
    }

    const titleRaw = extract_title
      ? /<title[^>]*>([\s\S]*?)<\/title>/i.exec(bodyText)?.[1]
      : undefined;
    const title = titleRaw ? decodeEntities(titleRaw.replace(/\s+/g, " ").trim()) : null;
    const cleaned = await stripNoise(bodyText);
    const md = htmlToMarkdown(cleaned, finalUrl);
    return ok({
      url, final_url: finalUrl, status: res.status, content_type: ctype, title,
      markdown: markdown
        ? md
        : decodeEntities(cleaned.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()),
      bytes: total, truncated, fetched_ms: Date.now() - started,
    });
  },
} as AnyToolDefinition;
