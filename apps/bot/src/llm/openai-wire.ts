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
  /**
   * Routing preference, passed through verbatim. Vendor-specific and omitted
   * entirely when unset, so the wire stays the plain chat-completions shape
   * for anything that is not a router.
   *
   * Measured 2026-09-04, same prompt and the same **pinned** model, five
   * calls: 11s, 47s, 58s, 106s, 205s — a 20x spread tracking which provider
   * the router picked, with output from 48 to 5,710 tokens. Pinning a model
   * does not pin who serves it, and on the heavy prompts here that difference
   * decides whether a run finishes at all.
   */
  provider?: unknown;
}

/**
 * Three minutes, not one. The vocabulary bootstrap hands the strong model a
 * hundred-odd catalog entries and asks for twenty tags; that took longer than
 * 60s and aborted mid-derivation. Long enough for the heaviest job here,
 * short enough that a model which never answers still fails rather than hangs.
 */
const DEFAULT_TIMEOUT_MS = 180_000;

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
        ...(config.provider === undefined ? {} : { provider: config.provider }),
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
  // Raw JSON rather than a parsed set of knobs: this is one vendor's routing
  // object passed straight through, and inventing our own vocabulary for it
  // would mean maintaining a translation for a field we do not own.
  let provider: unknown;
  if (env["LLM_PROVIDER"])
    try {
      provider = JSON.parse(env["LLM_PROVIDER"]);
    } catch {
      throw new Error(`LLM_PROVIDER must be JSON. Got: ${env["LLM_PROVIDER"]}`);
    }

  return {
    wire: {
      baseUrl: env["LLM_BASE_URL"] ?? "https://openrouter.ai/api/v1",
      apiKey,
      ...(env["LLM_TIMEOUT_MS"] ? { timeoutMs: Number(env["LLM_TIMEOUT_MS"]) } : {}),
      ...(provider === undefined ? {} : { provider }),
    },
    models: models as Record<ModelRole, string>,
  };
};
