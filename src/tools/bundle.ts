/**
 * OpenCarls — Bundle central de herramientas (Fases 1–3).
 * `registerAllTools()` alimenta el registry que consume el agente, la TUI y
 * el gateway. Aditivo: Fase 1 intacta, Fase 2/3 se añaden encima.
 */
import type { AnyToolDefinition } from "../types";
import { registerTools } from "./registry";
import { bashSessionTool } from "./bash_session";
import { codeSurgeryTool } from "./code_surgery";
import { gnomeVisionTool } from "./gnome_vision";
import { gnomeInputTool } from "./gnome_input";
import { computerUseTool } from "./computer_use";
import { multiPatchTool } from "./multi_patch";
import { lspDiagnosticsTool } from "./lsp_diagnostics";
import { webFetchTool } from "./web_fetch";
import { todoBoardTool } from "./todo_board";
import { skillForgeTool } from "./skill_forge";
import { mcpBridgeTool } from "./mcp_bridge";

export const PHASE1_TOOLS: readonly AnyToolDefinition[] = [
  bashSessionTool,
  codeSurgeryTool,
  gnomeVisionTool,
  gnomeInputTool,
];

export const PHASE2_TOOLS: readonly AnyToolDefinition[] = [
  computerUseTool,
  multiPatchTool,
  lspDiagnosticsTool,
  webFetchTool,
  todoBoardTool,
  skillForgeTool,
];

export const PHASE3_TOOLS: readonly AnyToolDefinition[] = [mcpBridgeTool];

export const ALL_TOOLS: readonly AnyToolDefinition[] = [
  ...PHASE1_TOOLS,
  ...PHASE2_TOOLS,
  ...PHASE3_TOOLS,
];

/** Idempotente (el registry avisa si re-registra). */
export function registerAllTools(): void {
  registerTools(ALL_TOOLS);
}
