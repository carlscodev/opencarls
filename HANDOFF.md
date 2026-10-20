# HANDOFF — OpenCarls (Fases 1–4)

> **Fecha**: 2026-10-20 (UTC) · **Autor**: sesión Arena (Agente) · **Repo**: https://github.com/flormariap/opencarls (`main` = `f156d7c` + este handoff)
> **Objeto de este documento**: TODO lo que queda pendiente, con orden de ejecución recomendado y comandos. Quien tome el relevo debe poder continuar sin reconstruir contexto.

---

## 1. Estado general

Código de las **4 fases completo y publicado**. Lo que falta es casi todo **verificación en vivo** y **una pasada de E2E que termine `accepted: true`**.

| Verificación | Estado | Último momento |
|---|---|---|
| `bun run typecheck` | ✅ 0 errores | tras el último cambio (`execute-retry` en lockpack) |
| `bun run smoke` | ✅ 119 pass / 0 fail / 1 skip | **antes** del cambio `execute-retry` (ver §2.1) |
| `bun run test:diff` | ✅ 62/62 | mismo |
| E2E NVIDIA (`bun run e2e`) | ❌ **nunca terminó `accepted:true`** | ver §3 |

**Artefactos clave del repo**: `src/providers/` (11 proveedores + reasoning + SSE + json_schema), `src/tools/` (11 tools registrados por `registerAllTools()`), `src/core/lockpack-loop.ts`, `src/core/agent.ts`, `src/gateway/server.ts`, `src/cli/tui.ts`, `src/mcp/mcp-manager.ts`, `src/memory/{db,compactor}.ts`, `scripts/{smoke,smoke-phase2,test-diff,e2e}.ts`.

---

## 2. Pendientes CRÍTICOS (orden de ejecución)

### 2.1 Re-verificación completa tras los últimos 4 cambios
Se modificó código **después** del último smoke verde:

1. `src/core/lockpack-loop.ts` → retry de EXECUTE (hasta 2×, 10 s) ante `stopped==="error"`.
2. `src/core/agent.ts` + lockpack → autoregistro `registerAllTools()` si el registry está vacío.
3. `src/tools/lsp_diagnostics.ts` → archivos no soportados (html/css/…) se omiten en vez de lanzar.
4. `src/tools/gnome_vision.ts` → raster del SVG de grid con `resize(width,height,fit:'fill')` antes de `composite` (arregla "Image to composite must have same dimensions or smaller").
5. `scripts/e2e.ts` → `ok` exige `report.accepted`.

```bash
export PATH="$HOME/.bun/bin:$PATH"
bun run typecheck && bun run smoke && bun run test:diff
# Esperado: 0 errores · 119/0/1 · 62/62
```

### 2.2 E2E NVIDIA hasta `E2E ✅ ÉXITO` (la prueba de fuego)
`bun run e2e` debe terminar con `report.accepted === true` (audit limpio + crítica ≥ 8 + skill creada + archivos presentes).

**Historial de runs (sandbox)** — lecciones ya aplicadas:

| Run | Resultado | Causa | Fix aplicado |
|---|---|---|---|
| #1 | 0 tools, archivos vacíos | registry vacío en el proceso e2e | `registerAllTools()` en e2e + guard en `Agent.run`/`runLockpack` |
| #2 | ciclos 1–2 reales: landing 39 KB, crítica **8.7/8.6**, skills `lockpack-cycle-1/2` creadas; jamás `accepted` | `lsp_diagnostics` lanzaba con `styles.css` → `audit.clean=false` siempre | fix §1.3 (omitir no soportados) |
| #3 | fatal en 38 min | **HTTP 504** del upstream NVIDIA (01:00 UTC, saturación) + `produced=true` impedía retry del stream | retry de EXECUTE ×2 en lockpack |
| #4 | en curso/dejado corriendo en el sandbox | — | — |

**Riesgos al correrlo en la VPS** (ver §4): latencia alta de `deepseek-ai/deepseek-v4.1-flash` (turnos de 2–7 min, silencios de hasta 10 min son normales), 504 en horas pico → reintentar; Xvfb necesario para capturas (§5).

```bash
bun run e2e        # 20–90 min según carga de NVIDIA
# Si sale ❌ por 504/timeout: relanzar. Si sale ❌ por checks,
# revisar el REPORTE FINAL (cycle audit/critique/skill) y los tickets
# de hardening_backlog en .agent/opencarls.db
```

---

## 3. Pendientes funcionales (por módulo, aún sin probar en vivo)

Ninguno rompe lo entregado; son las piezas que solo tienen tests sintéticos:

1. **Gateway — run remoto completo**: `bun run gateway` y luego `POST /api/run {mode:"agent"|"lockpack", task, target_dir?}` → seguir `GET /api/events?run=<id>` hasta `done`. En smoke solo se prueba boot en puerto 0 + `/health` + SSE hello + `/api/state` + validación 400.
2. **MCP bridge con servidor real**: falta un servidor de prueba (p. ej. cualquier MCP stdio) → `mcp_bridge {op:"add"}` → verificar que sus tools aparecen en el registry y ejecutan. Hoy solo: config inexistente, stdio sin `command` rechazado, `list` vacío.
3. **TUI en PTY real**: smoke valida `RollingThoughtBox` (4 líneas, fade 82/113/161/228, colapso, ansiWidth) pero nadie ha visto `bun run tui` en una terminal interactiva con resize → probar a mano: `/connect`, streaming, colapso de thinking, status bar.
4. **Providers no-NVIDIA en vivo**: `openai`/`anthropic`/`openrouter`/etc. solo con mocks/estructura. Si consigues claves: un `completeChat` live por cada uno. **Anthropic**: verificar bloque `extended_thinking` + `computer_20250124`; **openai-responses**: probar `computer_use_preview` con `OPENCARLS_PROVIDER=openai`.
5. **computer_use nativo real**: el traductor `executeNativeComputerAction` está cubierto por smoke (sin X11 falla limpio) y el modo universal funcionó en e2e; falta un ciclo nativo completo (captura limpia → acciones → `computer_call_output` con screenshot Base64) contra OpenAI o Anthropic con X11 activo.
6. **web_fetch contra red real**: solo fixtures locales (md + rechazo ftp). Probar una URL pública.
7. **`setup_ubuntu.sh` no instala `xvfb`** (ni `node`): en la VPS headless las capturas/`import` de ImageMagick necesitan display. Añadir `xvfb` a la lista de paquetes (línea ~34) y arrancar `Xvfb :0` (o `xvfb-run`) antes del e2e; el agente en run #2 lo levantó a mano con un `bash_session`, no debe depender de eso.
8. **Limpieza de huérfanos al salir**: en el sandbox quedaron vivos `python3 -m http.server` (8765/8099) y Xvfb tras matar runs — `bashSession.shutdown()` no mata procesos *background* arrancados con `&` de otros runs. Revisar `src/util/proc.ts` kill-tree al cerrar sesión (§4).

---

## 4. Bugs conocidos / riesgos abiertos

1. **Bun + `AbortSignal.timeout` en cuerpo SSE**: se observó un fetch vivo **27 min** con el socket en idle tras enviar el body, sin que disparara el timeout de 600 s (no 100 % confirmado: pudieron intervenir reintentos con conexión reutilizada). El guardia `SseIdleError` (10 min sin chunks) sí existe en `src/providers/sse.ts` y cubre el caso una vez iniciado el body. **Acción**: si se reproduce de nuevo, instrumentar `chatStream` (log de `attempt`, `Date.now()` por fase) y, si hace falta, añadir un watchdog duro (`Promise.race` con timer propio) alrededor de la colecta del stream.
2. **`produced` bloquea el retry del stream**: en `openai_completions.chatStream`, si ya salió `text_delta`/`reasoning_delta` y luego muere el proveedor → **no** se reintenta (error al agente). Mitigado por el retry de EXECUTE del lockpack; **un `agent.run` directo (fuera de lockpack) sigue muriendo con el primer error de stream**. Considerar permitir retry cuando no haya tool_calls ejecutados.
3. **504 de NVIDIA en horas pico** (~01:00 UTC): saturación del endpoint. No es bug nuestro; reintento + re-ejecución lo absorben. Si persiste, bajar `max_tokens` del agente o cambiar `OPENCARLS_MODEL` (`z-ai/glm-5.3-flash` figura en el catálogo).
4. **`thinking` de deepseek se come presupuestos**: critique/distill pasan `extra: { chat_template_kwargs: { thinking: false } }` + `max_tokens` 1800–3000. Si cambias de modelo, revisar que ese extra siga siendo correcto (vLLM/NIM). `completeChat` con `max_tokens` bajos devuelve `content:""` si el razonamiento se lo gasta.
5. **Smoke `skip=1`**: captura X11 de gnome_vision (requiere sesión gráfica). En headless contar con Xvfb para que pase.
6. **`e2e` destruye y recrea `/tmp/opencarls-demo`** en cada arranque (incluye `package.json` semilla con script `test`). No apuntar `OPENCARLS_E2E_DIR` a un directorio con datos valiosos.
7. **PAT de GitHub en el historial del chat**: se recomendó **rotarlo** (Settings → Developer settings → Fine-grained tokens). El `.git/config` del repo está limpio (push con `http.extraheader`, token no persistido) y `.env`/`.agent/` están en `.gitignore` con verificación de 0 secretos en el commit.

---

## 5. Entorno y credenciales (VPS)

```bash
git clone https://github.com/flormariap/opencarls.git && cd opencarls
curl -fsSL https://bun.sh/install | bash && export PATH="$HOME/.bun/bin:$PATH"
bun install
# .env (chmod 600) — NUNCA versionado:
NVIDIA_API_KEY=nvapi-...
OPENCARLS_PROVIDER=nvidia
OPENCARLS_MODEL=deepseek-ai/deepseek-v4.1-flash
# extras opcionales: OPENAI_API_KEY, ANTHROPIC_API_KEY, OPENROUTER_API_KEY…
```

* Xvfb + ImageMagick para modo visual: `sudo apt-get install -y xvfb imagemagick scrot xdotool wmctrl` y `Xvfb :0 &` (o completar `setup_ubuntu.sh`, §3.7).
* Sin teclado/gráfico la crítica visual cae a **fallback DOM** (lee `index.html`) — funciona igual, solo cambia `mode` (`dom` vs `screenshot`).

### Comandos de verificación
```bash
bun run typecheck   # tsc --noEmit strict
bun run smoke       # 119 checks Fases 1–4 (1 skip X11)
bun run test:diff   # 62 casos paridad unifiedDiff vs git
bun run tools       # catálogo · bun run stats → telemetría
bun run gateway     # HTTP+SSE+WS (ver §3.1)
bun run tui         # TUI (ver §3.3)
bun run e2e         # prueba de fuego (ver §2.2)
```

---

## 6. Contratos rápidos (no re-descubrir)

* **Bun + `import()`**: cache-bust solo con **ruta absoluta + `?query`**; `file://` no funciona (verificado). Skill hot-reload usa esto (`skill_forge`).
* **zod 3.25.76 híbrido**: checks en `_def.checks` (kind clásico) **o** `_zod.def`; `_def.shape` puede ser función; arrays usan `def.minLength/maxLength = {value}` y el elemento vive en `def.type` (¡no en `def.element`!); enum dual `values[]`/`entries{}`. Tests: ejecutar desde el CWD del proyecto (fuera auto-instala zod 4).
* **Gateway** `POST /api/run` → `202 {run_id}`; SSE `event: <phase|agent|log|done>\ndata: {...}\n\n`; `GET /health|/api/state|/api/todos|/api/skills`.
* **Lockpack aceptación**: `audit.clean && (!visual || critique.score ≥ critique_target)`; `stop_reason: criteria | max_cycles | fatal`.
* **TUI**: L0 spinner `⠋` 10 fps + `Thinking... Ns`; 4 líneas exactas; FADE por edad `rgb(82,82,91)→(113,113,122)→(161,161,170)→(228,228,231)`; colapso `✦ Thought for N.Ns · N tokens`; differ por línea `\x1b[row;1H\x1b[2K`.
* **Tools registrados (11)**: bash_session, code_surgery, gnome_vision, gnome_input, multi_patch, lsp_diagnostics, web_fetch, computer_use, todo_board, skill_forge, mcp_bridge.
* **DB**: `.agent/opencarls.db` (WAL, FTS5) — tablas `episodic_memory`, `hardening_backlog`, `skills_registry`, `todos`, `sessions`, `tool_calls`. Útil para diagnosticar runs: `SELECT title, created_at FROM hardening_backlog ORDER BY id DESC;`.
* **Debug de runs e2e**: el proceso escribe todo a stderr con prefijo `[e2e HH:MM:SS]`; fase actual = última línea `ciclo N [fase]`.

---

## 7. Orden recomendado del relevo

1. `bun run typecheck && bun run smoke && bun run test:diff` (§2.1) → confirmar 0/119/62.
2. Completar §3.7 (`xvfb` en setup + arranque `Xvfb :0`).
3. `bun run e2e` hasta `E2E ✅ ÉXITO` (§2.2). Reintentar ante 504.
4. Gateway remoto completo y TUI en PTY (§3.1, §3.3).
5. MCP con servidor real y `web_fetch` live (§3.2, §3.6).
6. Con claves extra: smoke live de providers + computer_use nativo (§3.4, §3.5).
7. Bugs §4.1/§4.2 si se reproducen; commit+push de todo a `flormariap/opencarls`.
