/**
 * OpenCarls — Tipos del enrutador multi-proveedor (agnóstico y universal).
 */

export type MessageRole = "system" | "user" | "assistant" | "tool";

/** Tool call acumulada (argumentos como string JSON en crudo). */
export interface ToolCallRequest {
  id: string;
  name: string;
  arguments: string;
}

export interface ChatMessage {
  role: MessageRole;
  content: string;
  /** Razonamiento acumulado (para persistir contexto en la memoria). */
  reasoning?: string;
  tool_calls?: ToolCallRequest[];
  /** role=tool: id de la tool call respondida. */
  tool_call_id?: string;
  /** role=tool/assistant: nombre de la herramienta. */
  name?: string;
  /** Anthropic: bloque thinking+signature requerido para continuar turnos. */
  anthropic_thinking?: { thinking: string; signature: string };
  /** Imágenes adjuntas (data URLs) — visión dual en critique/critiques. */
  images?: string[];
}

/** Esquema de herramienta enviado al modelo (JSON Schema). */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export type StreamEvent =
  | { type: "reasoning_delta"; text: string }
  | { type: "text_delta"; text: string }
  | { type: "tool_call_start"; id: string; name: string }
  | { type: "tool_call_delta"; id: string; args_delta: string }
  | { type: "tool_call_end"; id: string }
  | { type: "usage"; input_tokens: number; output_tokens: number }
  | { type: "done" }
  | { type: "error"; error: string; retryable: boolean };

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  temperature?: number;
  max_tokens?: number;
  signal?: AbortSignal;
  /** Passthrough por proveedor (thinking, computer display, etc.). */
  extra?: Record<string, unknown>;
}

export interface ChatUsage {
  input_tokens: number;
  output_tokens: number;
}

export interface ChatResult {
  content: string;
  reasoning: string;
  tool_calls: ToolCallRequest[];
  usage?: ChatUsage;
  /** Thinking nativo (Anthropic) para reenviarlo en el siguiente turno. */
  anthropic_thinking?: { thinking: string; signature: string };
}

export type ProviderKind = "openai-completions" | "anthropic" | "openai-responses";

export interface ProviderDef {
  id: string;
  label: string;
  kind: ProviderKind;
  base_url: string;
  /** Variable de entorno de la API key ('' = local, sin key). */
  api_key_env: string;
  default_headers?: Record<string, string>;
  default_model?: string;
  /**
   * Timeout total por request. NVIDIA: 600_000 ms (10 min) — su API es
   * gratuita/ilimitada pero de alta latencia (arranque + generación).
   */
  timeout_ms: number;
  /** Watchdog de silencio dentro del stream (NO corta silencios largos). */
  idle_ms: number;
  retry: { max: number; base_delay_ms: number };
  /** Algunos servidores rechazan stream_options.include_usage. */
  no_stream_options?: boolean;
  local?: boolean;
}

export interface ProviderRequestOptions {
  provider?: string;
  model?: string;
  signal?: AbortSignal;
}
