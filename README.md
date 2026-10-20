# OpenCarls

**Daemon agéntico perpetuo + Gateway + CLI** — Bun + TypeScript (strict), estilo
Claude Code / OpenClaw / Hermes Agent, diseñado para correr **días o semanas
sin interrupción** en una máquina aislada con Ubuntu Desktop (GNOME/X11).

> **REGLA DE ORO — ZERO-CONFIRMATION / YOLO MODE**
> Entorno aislado dedicado. El agente **no** programa confirmaciones `[y/N]`,
> ni listas negras de comandos, ni bloqueos de `sudo`, ni pausas de aprobación.
> Toda herramienta se ejecuta en el acto.

---

## Quickstart

```bash
# 1) Entorno Ubuntu (Bun, xdotool, wmctrl, scrot, ripgrep, xclip, sudo NOPASSWD,
#    política GNOME sin bloqueos, X11 sin restricciones):
bash setup_ubuntu.sh

# 2) Dependencias
bun install

# 3) Verificación de Fase 1 (BD + 4 tools + paridad de diffs vs git)
bun run smoke
bun run test:diff
bun run typecheck

# 4) Bench de herramientas
bun run tools                       # catálogo
bun run src/index.ts exec bash_session '{"op":"exec","command":"uname -a"}'
bun run src/index.ts exec code_surgery '{"op":"ripgrep_search","pattern":"TODO","path":"."}'
bun run stats                       # memoria + telemetría SQLite
```

## Arquitectura

```
opencarls/
├── setup_ubuntu.sh            # Fase 1: entorno Ubuntu aislado sin restricciones
├── package.json / tsconfig.json
├── scripts/
│   ├── smoke.ts               # verificación integral Fase 1
│   └── test-diff.ts           # paridad de difas unificadas vs git (62 casos)
└── src/
    ├── index.ts               # entrada CLI/drun (bench: tools | exec | stats)
    ├── types.ts               # contrato ToolDefinition / ToolResult
    ├── core/
    │   ├── config.ts          # rutas .agent/, telemetría, DISPLAY
    │   └── logger.ts          # logger con anillo en memoria (→ CLI/Gateway)
    ├── memory/
    │   └── db.ts              # bun:sqlite WAL + FTS5 (sesiones, episódica,
    │                          #   backlog, skills, tool_calls)
    ├── tools/
    │   ├── registry.ts        # registro + ejecución validada con zod
    │   ├── bash_session.ts    # ① sesión Bash persistente
    │   ├── code_surgery.ts    # ② edición quirúrgica + AST + ripgrep
    │   ├── gnome_vision.ts    # ③ captura + cuadrícula Set-of-Marks (sharp)
    │   └── gnome_input.ts     # ④ mouse/teclado/ventanas (xdotool/wmctrl)
    ├── util/
    │   ├── diff.ts            # Myers O(ND) + difas unificadas (paridad con git)
    │   └── proc.ts            # Bun.spawn / spawnSync con timeouts
    ├── skills/                # (Fase 2) Skill Forge Hermes
    ├── mcp/                   # (Fase 2) Native MCP Host
    ├── gateway/               # (Fase 3) Bun.serve HTTP + WS + SSE
    ├── cli/                   # (Fase 4) TUI estilo Claude Code (ink)
    └── core/lockpack-loop.ts  # (Fase 3) bucle de 4 fases
```

## Sistemas nucleares (roadmap)

| Fase | Sistema | Estado |
|------|---------|--------|
| **1** | Bootstrap, `bun:sqlite` (WAL+FTS5) y las 4 herramientas core | ✅ implementada |
| **2** | Motor evolutivo **Hermes** (`skill_forge`: SKILL.md + tool.ts + hot-reload) y **MCP host** (`@modelcontextprotocol/sdk`, stdio/SSE, spawner en caliente) | ⏳ |
| **3** | **Lockpack Loop** (EXECUTE → HARDEN_AND_AUDIT → VISUAL_CRITIQUE → SKILL_DISTILLATION), **compactor** de contexto (>65 % ⇒ compactación episódica + watchdog de recursos) y **gateway** `Bun.serve` (REST+SSE+WS) | ⏳ |
| **4** | **CLI TUI** estilo Claude Code (fase actual, logs, diffs, telemetría) | ⏳ |

## Catálogo de herramientas (Fase 1)

### ① `bash_session` — sesión Bash persistente
| Op | Descripción |
|----|-------------|
| `exec` | Comando con `cwd`/`env` acumulativos, `stdin_data` (heredoc), `stdin_mode:'inherit'` para interactivos, timeout con escalada **SIGINT al árbol de hijos → TERM → kill de grupo** (la sesión sobrevive al timeout: rc=130) |
| `bg` | Proceso background con log propio (`.agent/logs/bg-*.log`) |
| `list_bg` / `kill_bg` | PIDs vivos + kill recursivo (`kill_tree`) |
| `send_stdin` | Interactividad (REPLs, editores) |
| `tail_log` | Últimas N líneas + `follow_seconds` (streaming acotado) |
| `state` / `reset` | Estado de la sesión / respawn limpio |

Detalles de ingeniería: bash arranca con `--noediting` (cero echo readline) y
`set +m`; cada línea se envuelve con un **sentinel único** `RS OC|nonce|rc|cwd RS`;
los comandos que contienen `exit` corren en **subshell con reconciliación**
de PWD y exports (`export -p` + `compgen -e`), preservando la semántica exacta
de `exit N` sin perder la persistencia. `sudo` funciona directo (NOPASSWD).

### ② `code_surgery` — edición de alta velocidad
* `read_range` — lectura por rango de líneas numeradas.
* `write_full` — escritura completa (`Bun.write`) con `mkdir -p`.
* `surgical_replace` — reemplazo exacto por bloque + **dif unificado** (Myers
  propio, paridad byte-a-byte con `git diff`), validación de nº de matches,
  `replace_all` y `dry_run`.
* `ast_outline` — esqueleto del archivo: **TypeScript Compiler API** para
  TS/JS/JSON (imports, funciones, clases/métodos, interfaces, tipos, enums,
  namespaces con profundidad), heurísticas por lenguaje para el resto.
* `ripgrep_search` — `rg --json` (glob, -i, -F, -w, contexto) con **fallback
  interno** cuando `rg` no está instalado.

### ③ `gnome_vision` — ojos del agente
Captura X11 en cascada (`scrot` → `gnome-screenshot` → `import`), dibuja con
`sharp` la **cuadrícula graduada (X, Y)** cada N px + crosshair del cursor +
etiquetas legibles sobre cualquier fondo, y devuelve `image_base64` + árbol de
ventanas (`wmctrl -lG` + ventana activa). Op `state` sin imagen.

### ④ `gnome_input` — manos del agente
`click`, `double_click`, `right_click`, `drag` (interpolación easing),
`type_text`, `press_keys` (combos validados: `ctrl+alt+t`, `super`…),
`scroll`, `window_focus`, `window_move`, `window_close`, `get_state`.
Todo vía argv sin shell → sin inyección; validación zod estricta.

## Memoria persistente (`.agent/opencarls.db`)

* `episodic_memory` + `episodic_memory_fts` (FTS5 `unicode61 remove_diacritics`):
  destino de la compactación de contexto (Fase 3) con `importance` y
  `token_estimate` para priorizar recuperación.
* `hardening_backlog` — backlog del Lockpack (severidad/estado/fase).
* `skills_registry` + `skills_fts` — índice de skills (Fase 2).
* `sessions` — detección de crashes (huérfanas → `crashed` en el arranque).
* `tool_calls` — latencias/errores por herramienta (alimenta la telemetría).
* PRAGMAs: `WAL`, `synchronous=NORMAL`, `busy_timeout=5000`, `mmap=256MB`.

## Scripts

| Comando | Qué hace |
|---------|----------|
| `bun run smoke` | 119 aserciones (Fases 1–4): BD/FTS, bash, code_surgery, gnome, diffs + providers/router/reasoning/SSE/json_schema, multi_patch, lsp, web_fetch, computer_use, todo_board, skill_forge, compactor, gateway (boot port 0 + SSE), MCP, TUI |
| `bun run test:diff` | 62 casos de paridad `unifiedDiff` vs `git diff --no-index` |
| `bun run typecheck` | `tsc --noEmit` en strict mode |
| `bun run tools` / `bun run stats` | Catálogo / telemetría |
| `bun run gateway` | Gateway HTTP+SSE+WS (LOCKPACK remoto) |
| `bun run tui` | TUI "Architectural Monolith" (RollingThoughtBox) |
| `bun run e2e` | Prueba de fuego E2E con NVIDIA NIM real |

## Estado de verificación (Fases 1–4)

```
typecheck .......... ✅ 0 errores (strict + noUncheckedIndexedAccess)
smoke .............. ✅ 119 pass / 0 fail / 1 skip (captura X11: requiere sesión gráfica)
test:diff .......... ✅ 62/62 paridad con git diff --no-index
```

---

# Fases 2–4 — Actualización mayor

## Router multi-proveedor universal (`src/providers/`)

11 proveedores con `ProviderDef`/`ChatRequest` unificados (`types.ts`):

| Proveedor | Detalles |
|-----------|----------|
| **nvidia** (default) | `https://integrate.api.nvidia.com/v1`, timeout **600_000 ms**, keep-alive, reintentos expo ante 429/502/503/504 (jitter, `Retry-After` respetado), SSE tolerante a silencios largos (keep-alive 15 s) |
| openai / openai-compatible | `chat/completions` + `/1/responses` automático para `computer_use_preview`; cualquier `base_url` (openrouter, moonshot, deepseek, groq, ollama, vllm…) |
| anthropic | `extended_thinking` + `computer_20250124`; bloque thinking/signature reenviado entre turnos |
| gemini | API native `streamGenerateContent?alt=sse` |

* **Unified stream**: `sse.ts` (parser tolerante a `data:` sin `event:`, líneas partidas, keep-alives) + `reasoning.ts`.
* **Reasoning extractor en vivo**: `delta.reasoning_content` / `delta.reasoning`; etiquetas `<invalid>…</invalid>` inline en content (máquina de estados, sin confundir la palabra "invalid"); reasoning summary de OpenAI → todos emiten `onReasoningDelta(chunk)`. Cap global 512 KiB.
* **json_schema.ts**: zod 3 clásico **e** híbrido/zod 4 (checks, `typeName`, `_def.shape` función, enum `values[]`/`entries{}`, arrays con `minLength/maxLength` o checks) → JSON Schema con `readChecks`, `shape fn`, `typeName`, enum dual.

## Visión Dual (`src/tools/computer_use.ts`)

* **Modo 1 nativo** (OpenAI `computer_use_preview` / Anthropic `computer_20250124`): capturas **limpias sin grid**, resolución exacta X11, `environment:"linux"`, traductor `executeNativeComputerAction` (click/double_click/drag/keypress/move/screenshot/scroll/type/wait → `gnome_input` + `gnome_vision`) que devuelve `computer_call_output` con screenshot Base64.
* **Modo 2 universal**: grid graduado sharp + crosshair, coords normalizadas `0..1000` (o `0..1`) auto-escaladas a la resolución real.

## Tools (Fase 2) — `src/tools/`

* **multi_patch** — transacción atómica multi-archivo: `replace_exact` / `regex_replace` (con `expect_count`) / `insert_after` / `append` / `create` / `delete` / `rename`; **rollback total** ante cualquier fallo; `dry_run` con diff combinado (colores + plain).
* **lsp_diagnostics** — `tsc --noEmit` / `bash -n` / `python3 -m py_compile` con **línea + columna**; inferencia por extensión/contenido.
* **web_fetch** — URL → Markdown limpio (headings, links, lists, code fences, entidades); sólo http/https.
* **todo_board** — tareas vivas en `bun:sqlite` (`todos` + índices), visibles en la TUI: add/list/update/delete/stats + Markdown render.
* **skill_forge** — `.agent/skills/<slug>/` = `SKILL.md` + `tool.ts` + `schema.json`; ops `create | refine (version++) | search (FTS5) | execute | hot_reload`; hot reload con `import(rutaAbsoluta + "?" + Date.now())` (el cache-bust con `file://` no funciona en Bun — verificado).
* **mcp_bridge** — `src/mcp/mcp-manager.ts`: JSON-RPC 2.0 sobre stdio + HTTP/SSE, descubre tools del servidor y las inyecta en el ToolRegistry, alta/baja de servidores en caliente (`addServer/removeServer/list`).

`src/tools/bundle.ts` → `registerAllTools()` (11 tools Fases 1–3). El agente, el gateway y el e2e autoregistran si el registry está vacío.

## Bucle perpetuo "LOCKPACK" (`src/core/lockpack-loop.ts`)

`EXECUTE → HARDEN_AND_AUDIT → VISUAL_CRITIQUE → SKILL_DISTILLATION` en loop:

* **HARDEN_AND_AUDIT**: diagnósticos (`runDiagnostics`) + `verify_cmd` (inferido: tsconfig → `tsc`, package.json → `bun run test`, …); hallazgos al `hardening_backlog` y a la memoria episódica.
* **VISUAL_CRITIQUE**: screenshot (`import -window root`, fallback) o DOM; crítico de arte en vivo emitiendo `{score, verdict, issues, directives}`; si `score < critique_target` → refinamiento agéntico hasta `max_visual_refinements`.
* **SKILL_DISTILLATION**: el agente crea `lockpack-cycle-N` con skill_forge (fallback determinista garantiza la skill aunque el LLM falle).
* **Aceptación**: `audit.clean && (!visual || score ≥ critique_target)`. `LockpackReport {cycles, accepted, stop_reason: criteria|max_cycles|fatal, target_dir, duration_ms, tokens}`.

**Gateway** (`src/gateway/server.ts`, `bun run gateway`): `Bun.serve` HTTP + SSE + WebSocket. `POST /api/run {mode:"agent"|"lockpack", task, target_dir?, provider?, model?, verify_cmd?, max_cycles?, critique_target?, visual?}` → `202 {run_id}`; `GET /events?run=<id>` frames `event: <phase|agent|log|done>`; `GET /health | /api/state | /api/todos | /api/skills`.

## TUI "Architectural Monolith" (`src/cli/tui.ts`, `bun run tui`)

* Minimalismo de lujo: `#09090B/#18181B`, texto `#FAFAFA`, metadatos `#71717A`, bordes `╭─╮│╰─╯ #27272A`, acentos `#10B981/#F59E0B`. Cero cyberpunk, cajas ASCII genéricas.
* **RollingThoughtBox**: exactamente **4 líneas**, indicador `⠋ Thinking... 4.2s` (10 frames), fade-scroll por edad `rgb(82,82,91) → (113,113,122) → (161,161,170) → (228,228,231)`; colapso `✦ Thought for 12.4s · 380 tokens`.
* Tarjetas tool `⚡ bash_session · cmd · 1.2s`; diffs con fondo verde/rojo oscuro; status bar `[Provider/Model] · [Phase] · [Skills] · [Context %]`; render ANSI diferencial (`\x1b[row;1H\x1b[2K`), alt screen, resize → repaint.

## Prueba de fuego E2E (`bun run e2e`)

Agente autónomo con **NVIDIA NIM real** (`deepseek-ai/deepseek-v4.1-flash`, alta latencia tolerada) ejecuta LOCKPACK sobre `/tmp/opencarls-demo`: construye una landing/mini-app moderna (index.html + styles.css + app.js self-contained), la verifica (`bun run test`), audita jerarquía/diseño con crítica visual y destila su **primer skill** con skill_forge.
