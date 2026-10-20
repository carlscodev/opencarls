/**
 * OpenCarls — Suite de paridad del motor de difas (src/util/diff.ts).
 * Compara `unifiedDiff()` contra `git diff --no-index` en ~60 casos:
 * inserciones, borrados totales, multi-hunk, sin newline final, casos
 * aleatorios con dependencia pseudoaleatoria determinista.
 *
 *   bun run scripts/test-diff.ts
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { unifiedDiff, diffStats } from "../src/util/diff";
import { run } from "../src/util/proc";

const DIR = join(tmpdir(), "opencarls-diff-parity");
mkdirSync(DIR, { recursive: true });

/** Normaliza la salida de git: cabeceras de archivo, índice y funcname. */
function norm(s: string): string {
  return s
    .split("\n")
    .filter(
      (l) =>
        l !== "" &&
        !/^(diff --git|index |new file mode|deleted file mode|old mode|new mode|similarity index|--- |\+\+\+ )/.test(l),
    )
    .map((l) => l.replace(/^(@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@).*$/, "$1"))
    .join("\n");
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function parity(name: string, a: string, b: string): Promise<boolean> {
  const pa = join(DIR, `${name}-a.txt`);
  const pb = join(DIR, `${name}-b.txt`);
  await Bun.write(pa, a);
  await Bun.write(pb, b);
  const g = await run(["git", "diff", "--no-index", "--", pa, pb], { max_bytes: 4 * 1024 * 1024 });
  const mine = unifiedDiff(a, b, `${name}-a.txt`);
  const ok = norm(g.stdout) === norm(mine);
  if (!ok) {
    console.log(`\n✗ ${name}`);
    console.log("--- git ---\n" + norm(g.stdout));
    console.log("--- mine ---\n" + norm(mine));
  } else {
    console.log(`✓ ${name}`);
  }
  return ok;
}

async function main(): Promise<void> {
  let pass = 0;
  let total = 0;
  const cases: Array<[string, string, string]> = [
    ["empty→text", "", "hola\n"],
    ["text→empty", "hola\n", ""],
    ["same", "a\nb\n", "a\nb\n"],
    ["single-line-change", "a\nb\nc\n", "a\nB\nc\n"],
    ["no-newline-both", "sin nl", "sin nl 2"],
    ["no-newline-added", "con nl\n", "sin nl"],
    ["no-newline-removed", "sin nl", "con nl\n"],
    ["insert-head", "1\n2\n3\n", "0\n1\n2\n3\n"],
    ["insert-tail", "1\n2\n3\n", "1\n2\n3\n4\n"],
    ["delete-all-but-one", "a\nb\nc\nd\ne\n", "c\n"],
    ["rewrite-every-line", "a1\nb1\nc1\n", "a2\nb2\nc2\n"],
    [
      "two-far-hunks",
      Array.from({ length: 30 }, (_, i) => `L${i}`).join("\n") + "\n",
      Array.from({ length: 30 }, (_, i) => (i % 5 === 0 ? `L${i}-E` : `L${i}`)).join("\n") + "\n",
    ],
    ["trailing-blank-added", "a\nb\n", "a\nb\n\n"],
    ["trailing-blank-removed", "a\nb\n\n", "a\nb\n"],
    ["blank-line-middle", "a\n\nb\n", "a\nx\n\nb\n"],
    ["unicode", "ñandú\nárbol\n", "ñandú\nárbol!\nemoji 🚀\n"],
    ["crlf-ish", "line1\r\nline2\r\n", "line1\r\nlineX\r\n"],
  ];

  // Aleatorios deterministas
  const rnd = mulberry32(0x0f3ca15);
  for (let i = 0; i < 45; i++) {
    const lenA = 1 + Math.floor(rnd() * 60);
    const aLines: string[] = [];
    const bLines: string[] = [];
    for (let k = 0; k < lenA; k++) {
      const base = `row-${k % 9}-${Math.floor(rnd() * 1000)}`;
      aLines.push(base);
      if (rnd() > 0.25) bLines.push(rnd() > 0.3 ? base : `${base}-edited`);
      if (rnd() > 0.9) bLines.push(`extra-${i}-${k}`);
      if (rnd() > 0.9) aLines.push(`onlyA-${i}-${k}`);
    }
    const nlA = rnd() > 0.85;
    const nlB = rnd() > 0.85;
    cases.push([
      `rand-${i}`,
      aLines.join("\n") + (nlA ? "" : "\n"),
      bLines.join("\n") + (nlB ? "" : "\n"),
    ]);
  }

  for (const [name, a, b] of cases) {
    total++;
    if (await parity(name, a, b)) pass++;
  }

  // Sanity de stats
  const st = diffStats("a\nb\n", "a\nx\nc\n");
  const statsOk = st.added === 2 && st.removed === 1;
  console.log(`\ndiffStats: ${JSON.stringify(st)} ${statsOk ? "✓" : "✗"}`);

  console.log(`\nparidad git: ${pass}/${total} ${pass === total && statsOk ? "✓ PASS" : "✗ FAIL"}`);
  process.exit(pass === total && statsOk ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
