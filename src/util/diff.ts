/**
 * OpenCarls — Difus unificadas (Myers O(ND) sobre líneas) para los diffs de
 * `code_surgery.surgical_replace`. Autónomo: cero dependencias externas.
 *
 * Pipeline: recorte de prefijo/sufijo común → Myers (acotado) → hunks
 * unificados con 3 líneas de contexto (formato `diff -u` / git).
 */
export type DiffOpType = "equal" | "add" | "del";

export interface DiffOp {
  type: DiffOpType;
  text: string;
}

export interface HunkLine {
  type: DiffOpType;
  text: string;
}

export interface UnifiedHunk {
  a_start: number;
  a_count: number;
  b_start: number;
  b_count: number;
  header: string;
  lines: HunkLine[];
}

const MYERS_MAX_D = 20_000; // cota de edición; por encima → bloques
const NAIVE_MAX_CELLS = 40_000_000;

/** Recorta el prefijo/sufijo común (barato: deja a Myers en la región chica). */
function trimCommon(
  a: string[],
  b: string[],
): { a: string[]; b: string[]; pre: number; suf: number } {
  let pre = 0;
  const minLen = Math.min(a.length, b.length);
  while (pre < minLen && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < minLen - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  return { a: a.slice(pre, a.length - suf), b: b.slice(pre, b.length - suf), pre, suf };
}

function blockOps(del: string[], add: string[]): DiffOp[] {
  return [
    ...del.map((t): DiffOp => ({ type: "del", text: t })),
    ...add.map((t): DiffOp => ({ type: "add", text: t })),
  ];
}

/** Myers O(ND) (greedy con traza de V). Devuelve ops o null si D > cota. */
function myers(a: string[], b: string[]): DiffOp[] | null {
  const N = a.length;
  const M = b.length;
  const MAX = N + M;
  if (MAX > MYERS_MAX_D) return null;

  const offset = MAX + 1;
  const v = new Int32Array(2 * MAX + 3);
  const trace: Int32Array[] = [];

  for (let d = 0; d <= MAX; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      const down =
        k === -d || (k !== d && (v[offset + k - 1] ?? -1) < (v[offset + k + 1] ?? -1));
      let x = down ? (v[offset + k + 1] ?? 0) : (v[offset + k - 1] ?? 0) + 1;
      let y = x - k;
      while (x < N && y >= 0 && y < M && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= N && y >= M) return backtrack(trace, a, b, offset);
    }
  }
  return null;
}

function backtrack(trace: Int32Array[], a: string[], b: string[], offset: number): DiffOp[] {
  const ops: DiffOp[] = [];
  let x = a.length;
  let y = b.length;

  for (let d = trace.length - 1; d >= 0; d--) {
    const v = trace[d]!;
    const k = x - y;
    const down =
      k === -d || (k !== d && (v[offset + k - 1] ?? -1) < (v[offset + k + 1] ?? -1));
    const prevK = down ? k + 1 : k - 1;
    const prevX = v[offset + prevK] ?? 0;
    const prevY = prevX - prevK;

    while (x > prevX && y > prevY) {
      ops.push({ type: "equal", text: a[x - 1]! });
      x--;
      y--;
    }
    if (d === 0) break;
    if (x === prevX) {
      if (y > 0) ops.push({ type: "add", text: b[y - 1]! });
      y--;
    } else {
      if (x > 0) ops.push({ type: "del", text: a[x - 1]! });
      x--;
    }
  }
  ops.reverse();
  return ops;
}

/**
 * Modelo de lineas AL ESTILO diff(1)/git: cada linea lleva su bandera de
 * newline final codificada en un sufijo de 2 chars (N = tiene fin de linea,
 * W = sin newline). Asi 'x\\n' y 'x' son lineas DIFERENTES y el marcador
 * backslash-No newline at end of file coincide byte a byte con git.
 */
const NL_N = "\u0000N";
const NL_W = "\u0000W";

function toDiffLines(text: string): string[] {
  if (text === "") return [];
  const hasNl = text.endsWith("\n");
  const raw = text.split("\n");
  if (hasNl) raw.pop(); // artefacto del split tras el \\n final
  if (raw.length === 0) return [];
  const last = raw.length - 1;
  return raw.map((l, i) => l + (i === last && !hasNl ? NL_W : NL_N));
}

function renderLine(l: string): string {
  if (l.endsWith(NL_W)) return l.slice(0, -NL_W.length);
  if (l.endsWith(NL_N)) return l.slice(0, -NL_N.length);
  return l;
}

function lacksNl(l: string): boolean {
  return l.endsWith(NL_W);
}

/** Diff de lineas completo (ops en orden; textos con sufijo NL_N/NL_W). */
export function diffLines(aRaw: string, bRaw: string): DiffOp[] {
  const a = toDiffLines(aRaw);
  const b = toDiffLines(bRaw);

  const { a: ta, b: tb, pre, suf } = trimCommon(a, b);

  let mid: DiffOp[];
  if (ta.length === 0 && tb.length === 0) {
    mid = [];
  } else if (ta.length * tb.length > NAIVE_MAX_CELLS) {
    mid = blockOps(ta, tb);
  } else {
    mid = myers(ta, tb) ?? blockOps(ta, tb);
  }

  const ops: DiffOp[] = [];
  for (let i = 0; i < pre; i++) ops.push({ type: "equal", text: a[i]! });
  ops.push(...mid);
  for (let i = a.length - suf; i < a.length; i++) ops.push({ type: "equal", text: a[i]! });
  return ops;
}

/** Construye hunks unificados con `context` líneas de contexto. */
export function unifiedHunks(ops: DiffOp[], context = 3): UnifiedHunk[] {
  interface Row {
    op: DiffOp;
    aLine: number | null;
    bLine: number | null;
  }
  const rows: Row[] = [];
  let aPtr = 1;
  let bPtr = 1;
  for (const op of ops) {
    if (op.type === "equal") rows.push({ op, aLine: aPtr++, bLine: bPtr++ });
    else if (op.type === "del") rows.push({ op, aLine: aPtr++, bLine: null });
    else rows.push({ op, aLine: null, bLine: bPtr++ });
  }

  const include = new Array<boolean>(rows.length).fill(false);
  for (let i = 0; i < rows.length; i++) {
    if (rows[i]!.op.type === "equal") continue;
    const from = Math.max(0, i - context);
    const to = Math.min(rows.length - 1, i + context);
    for (let j = from; j <= to; j++) include[j] = true;
  }

  const hunks: UnifiedHunk[] = [];
  let i = 0;
  while (i < rows.length) {
    if (!include[i]) {
      i++;
      continue;
    }
    const start = i;
    let end = i;
    while (end + 1 < rows.length && include[end + 1]) end++;

    const slice = rows.slice(start, end + 1);
    const aLines = slice.map((r) => r.aLine).filter((n): n is number => n !== null);
    const bLines = slice.map((r) => r.bLine).filter((n): n is number => n !== null);
    const aStart = aLines.length > 0 ? Math.min(...aLines) : 0;
    const bStart = bLines.length > 0 ? Math.min(...bLines) : 0;
    const aCount = aLines.length;
    const bCount = bLines.length;

    const header = `@@ -${aStart}${aCount === 1 ? "" : "," + aCount} +${bStart}${
      bCount === 1 ? "" : "," + bCount
    } @@`;

    hunks.push({
      a_start: aStart,
      a_count: aCount,
      b_start: bStart,
      b_count: bCount,
      header,
      lines: slice.map((r) => ({ type: r.op.type, text: r.op.text })),
    });
    i = end + 1;
  }
  return hunks;
}

/** Dif unificado completo con cabeceros `---` / `+++` (y marcadores de EOF). */
export function unifiedDiff(
  oldText: string,
  newText: string,
  path: string,
  context = 3,
): string {
  if (oldText === newText) return "";
  const ops = diffLines(oldText, newText);
  const hunks = unifiedHunks(ops, context);
  if (hunks.length === 0) return "";

  const out: string[] = [`--- a/${path.replace(/^\/+/, "")}`, `+++ b/${path.replace(/^\/+/, "")}`];
  for (const h of hunks) {
    out.push(h.header);
    for (const l of h.lines) {
      const pfx = l.type === "equal" ? " " : l.type === "add" ? "+" : "-";
      out.push(pfx + renderLine(l.text));
      // La bandera W (sin newline) viaja en la propia linea: git la imprime
      // justo despues de la linea afectada. Una linea igual W en A y B es la
      // misma linea -> un unico marcador.
      const marker =
        (l.type !== "add" && lacksNl(l.text)) || (l.type !== "del" && lacksNl(l.text));
      if (marker) out.push("\\ No newline at end of file");
    }
  }
  return out.join("\n") + "\n";
}

/** Resumen estadístico para telemetría. */
export function diffStats(oldText: string, newText: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const op of diffLines(oldText, newText)) {
    if (op.type === "add") added++;
    else if (op.type === "del") removed++;
  }
  return { added, removed };
}
