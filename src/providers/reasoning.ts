/**
 * OpenCarls — Extractor de razonamiento en vivo (máquina de estados por PARES).
 *
 * Normaliza cualquier "pensamiento" del modelo a eventos `reasoning_delta`:
 *  - `delta.reasoning_content` / `delta.reasoning` → lo hace el adapter
 *    (NVIDIA, DeepSeek R1, Moonshot, OpenRouter) pasándolo directo.
 *  - Etiquetas inline DENTRO del `content` normal → este extractor con estado:
 *      `Winvalid`…`invalid`         (DeepSeek/Qwen inline)
 *      `<thinking>`…`</thinking>`   (Anthropic-style en proxies OpenAI)
 *    Tolera marcadores partidos entre chunks de red (sin emitir restos).
 *
 * Emisión real-time: dentro del bloque, cada chunk se emite como delta salvo
 * una cola de retención que permite detectar el cierre partido sin emitir
 * nunca un marcador parcial al consumidor.
 */

/** Pares (apertura, cierre) soportados. El cierre del par abierto es el único que cierra. */
const MARKER_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["<invalid", "</invalid>"], // spec OpenCarls: etiqueta invalid inline en content
  ["<thinking>", "</thinking>"],
];

const OPEN_MARKERS = MARKER_PAIRS.map(([o]) => o);
const CLOSE_BY_OPEN: Record<string, string[]> = {
  "<invalid": ["</invalid>"],
  "<thinking>": ["</thinking>"],
};
const ALL_CLOSE_MARKERS = Object.values(CLOSE_BY_OPEN).flat();
const MAX_MARKER = Math.max(...OPEN_MARKERS.map((m) => m.length), ...ALL_CLOSE_MARKERS.map((m) => m.length));
/** Cota de seguridad: 512 KiB de pensamiento sin cerrar. */
const MAX_THINKING = 512 * 1024;

export interface FeedResult {
  /** Pensamiento extraído de este chunk (en vivo). */
  reasoning: string;
  /** Contenido "normal" restante (sin bloques de pensamiento). */
  content: string;
}

function earliest(buf: string, markers: readonly string[]): { i: number; len: number; marker: string } {
  let best = -1;
  let len = 0;
  let marker = "";
  for (const m of markers) {
    const i = buf.indexOf(m);
    if (i !== -1 && (best === -1 || i < best)) {
      best = i;
      len = m.length;
      marker = m;
    }
  }
  return { i: best, len, marker };
}

/** Mayor longitud L>0 tal que el sufijo de largo L de `s` es prefijo de algún
 *  marker (sin ser marker completo). */
function partialSuffix(s: string, markers: readonly string[]): number {
  const max = Math.min(MAX_MARKER - 1, s.length - 1);
  for (let len = max; len > 0; len--) {
    const suffix = s.slice(s.length - len);
    for (const m of markers) {
      if (m.startsWith(suffix) && m.length > suffix.length) return len;
    }
  }
  return 0;
}

export class ReasoningTagExtractor {
  private state: "outside" | "inside" = "outside";
  /** Par abierto actual (para saber qué cierre cierra). */
  private openMarker = "";
  private hold = "";
  private thinkingBytes = 0;

  feed(delta: string): FeedResult {
    if (!delta) return { reasoning: "", content: "" };
    let out = "";
    let thinking = "";
    let buf = this.hold + delta;
    this.hold = "";

    if (this.state === "outside") {
      for (;;) {
        const { i, len, marker } = earliest(buf, OPEN_MARKERS);
        if (i === -1) {
          // ¿sufijo parcial de una apertura? → retener
          const ps = partialSuffix(buf, OPEN_MARKERS);
          if (ps > 0) {
            out += buf.slice(0, buf.length - ps);
            this.hold = buf.slice(buf.length - ps);
          } else {
            out += buf;
          }
          break;
        }
        const partial = partialSuffix(buf.slice(i + len), OPEN_MARKERS);
        // ¿podría haber apertura más larga cruzando el borde del chunk? si el
        // match completo es también prefijo de otro marker, retener
        if (i + len >= buf.length && OPEN_MARKERS.some((m) => m !== marker && m.startsWith(marker))) {
          out += buf.slice(0, i);
          this.hold = buf.slice(i);
          break;
        }
        out += buf.slice(0, i);
        this.state = "inside";
        this.openMarker = marker;
        this.thinkingBytes = 0;
        buf = buf.slice(i + len);
        void partial;
        break; // el resto lo procesa la fase "inside" de esta misma llamada
      }
    }

    if (this.state === "inside") {
      const closes = CLOSE_BY_OPEN[this.openMarker] ?? [this.openMarker];
      for (;;) {
        const { i, len } = earliest(buf, closes);
        if (i === -1) {
          const ps = partialSuffix(buf, closes);
          const emitLen = ps > 0 ? buf.length - ps : buf.length;
          const chunk = buf.slice(0, emitLen);
          this.thinkingBytes += chunk.length;
          if (this.thinkingBytes > MAX_THINKING) {
            // desbloquear: el "pensamiento" es contenido corrupto gigante
            this.state = "outside";
            this.openMarker = "";
            out += chunk;
            this.hold = "";
            break;
          }
          thinking += chunk;
          this.hold = ps > 0 ? buf.slice(emitLen) : "";
          break;
        }
        // ¿cierre parcial al final del buffer? retener para el próximo chunk
        if (i + len >= buf.length) {
          const ps = partialSuffix(buf.slice(i), closes);
          if (ps > 0 && i + ps >= buf.length - 1) {
            const head = buf.slice(0, i);
            this.thinkingBytes += head.length;
            thinking += head;
            this.hold = buf.slice(i);
            break;
          }
        }
        const chunk = buf.slice(0, i);
        this.thinkingBytes += chunk.length;
        thinking += chunk;
        this.state = "outside";
        this.openMarker = "";
        buf = buf.slice(i + len);
        break; // volvemos al loop principal del caller (fuera→busca nueva apertura)
      }
      // tras cerrar, seguir procesando el resto en modo outside
      if (this.state === "outside" && buf.length) {
        const rest = this.feedOutside(buf);
        out += rest.content;
        thinking += rest.reasoning;
      }
    }

    return { reasoning: thinking, content: out };
  }

  /** Segunda fase fuera de bloque (buscar otra apertura tras un cierre). */
  private feedOutside(buf: string): FeedResult {
    let out = "";
    let thinking = "";
    for (;;) {
      const { i, len, marker } = earliest(buf, OPEN_MARKERS);
      if (i === -1) {
        const ps = partialSuffix(buf, OPEN_MARKERS);
        if (ps > 0) {
          out += buf.slice(0, buf.length - ps);
          this.hold = buf.slice(buf.length - ps);
        } else {
          out += buf;
        }
        break;
      }
      out += buf.slice(0, i);
      this.state = "inside";
      this.openMarker = marker;
      this.thinkingBytes = 0;
      buf = buf.slice(i + len);
      // procesar interior inline
      const closes = CLOSE_BY_OPEN[marker] ?? [marker];
      const { i: ci, len: cl } = earliest(buf, closes);
      if (ci === -1) {
        const ps = partialSuffix(buf, closes);
        const emitLen = ps > 0 ? buf.length - ps : buf.length;
        thinking += buf.slice(0, emitLen);
        this.hold = ps > 0 ? buf.slice(emitLen) : "";
        buf = "";
        break;
      }
      thinking += buf.slice(0, ci);
      this.state = "outside";
      this.openMarker = "";
      buf = buf.slice(ci + cl);
    }
    return { reasoning: thinking, content: out };
  }

  /** Flujo final de stream: devuelve lo retenido (flush). */
  flush(): FeedResult {
    const pending = this.hold;
    this.hold = "";
    if (this.state === "inside") {
      // sin cierre: todo el hold es thinking
      const t = pending;
      this.thinkingBytes += t.length;
      return { reasoning: t, content: "" };
    }
    // fuera: el hold podría ser apertura incompleta → contenido literal
    return { reasoning: "", content: pending };
  }

  get inside(): boolean {
    return this.state === "inside";
  }
}

export const REASONING_OPEN_MARKERS = [...OPEN_MARKERS];
export const REASONING_CLOSE_MARKERS = [...ALL_CLOSE_MARKERS];
