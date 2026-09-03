/**
 * The wire: OpenAI's chat-completions shape over `fetch`.
 *
 * No SDK. Every candidate here — DeepSeek, Kimi, OpenRouter, a local llama.cpp
 * — speaks this one endpoint, so the adapter is thirty lines and switching
 * providers is an environment variable. An SDK would buy retries and types in
 * exchange for pinning us to one vendor's release cadence.
 *
 * This is a thin adapter, like the Discord one: exercised by `llm-check.ts`
 * against the real API rather than unit-tested against a mock of `fetch`.
 */
import type { ChatPort, ModelRole } from "./boundary.ts";

export interface WireConfig {
  baseUrl: string;
  apiKey: string;
  /** A model that never answers is a hung sync, not a slow one. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;

export const openAiWire = (config: WireConfig): ChatPort => ({
  complete: async ({ model, system, user }) => {
    const response = await fetch(`${config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        // Structured output is the prompt-injection containment, not a style
        // preference: the app renders from a template, so no input can make
        // the bot say anything.
        response_format: { type: "json_object" },
      }),
      signal: AbortSignal.timeout(config.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });

    if (!response.ok)
      throw new Error(
        `${model} returned ${response.status}: ${(await response.text()).slice(0, 300)}`,
      );

    const body = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== "string")
      throw new Error(`${model} returned no message content: ${JSON.stringify(body).slice(0, 300)}`);
    return content;
  },
});

/**
 * Config, not code. The model is the variable most likely to change — which
 * one is strong and which is cheap is an experiment, not a decision — so it
 * never appears in a source file.
 *
 * `OPENROUTER_API_KEY` is honoured because OpenRouter fronts both DeepSeek and
 * Kimi behind one key and one base URL, which is what is available today.
 */
export const wireFromEnv = (
  env: Record<string, string | undefined> = process.env,
): { wire: WireConfig; models: Record<ModelRole, string> } => {
  const apiKey = env["LLM_API_KEY"] ?? env["OPENROUTER_API_KEY"];
  if (!apiKey)
    throw new Error("LLM_API_KEY (or OPENROUTER_API_KEY) must be set to call a model.");
  const models = {
    strong: env["LLM_MODEL_STRONG"],
    cheap: env["LLM_MODEL_CHEAP"],
  };
  for (const [role, name] of Object.entries(models))
    if (!name) throw new Error(`LLM_MODEL_${role.toUpperCase()} must be set.`);
  return {
    wire: {
      baseUrl: env["LLM_BASE_URL"] ?? "https://openrouter.ai/api/v1",
      apiKey,
      ...(env["LLM_TIMEOUT_MS"] ? { timeoutMs: Number(env["LLM_TIMEOUT_MS"]) } : {}),
    },
    models: models as Record<ModelRole, string>,
  };
};
