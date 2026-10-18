import { afterEach, describe, expect, it, vi } from "vitest";
import { openAiWire } from "./openai-wire.ts";

const wire = openAiWire({ baseUrl: "https://llm.test", apiKey: "k", models: { strong: "s", cheap: "c" } } as never);
const ask = { model: "m", system: "s", user: "u" };

afterEach(() => vi.unstubAllGlobals());

describe("openAiWire errors", () => {
  // These are retried and logged. A provider body can quote the prompt back,
  // and the prompt can be member conversation.
  it("reports a failed call by status alone, never the provider's message", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ error: { message: "Rejected prompt: Dave said secret raid plans" } }), { status: 400 }),
    );

    const error = await wire.complete(ask).catch((e: Error) => e);

    expect(String(error)).toMatch(/400/);
    expect(String(error)).not.toMatch(/Dave|raid/);
  });

  it("reports a body that is not JSON without echoing it", async () => {
    vi.stubGlobal("fetch", async () => new Response("Dave said secret raid plans", { status: 200 }));

    const error = await wire.complete(ask).catch((e: Error) => e);

    expect(String(error)).toMatch(/not JSON/);
    expect(String(error)).not.toMatch(/Dave|raid/);
  });

  it("reports a missing answer without echoing the body", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ "Dave said": "raid" }), { status: 200 }));

    const error = await wire.complete(ask).catch((e: Error) => e);

    expect(String(error)).toMatch(/no message content/);
    expect(String(error)).not.toMatch(/Dave|raid/);
  });
});

describe("openAiWire request body", () => {
  const routed = openAiWire({ baseUrl: "https://llm.test", apiKey: "k", provider: { data_collection: "deny", zdr: true } });
  const sent = () => {
    const bodies: string[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      bodies.push(String(init.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }), { status: 200 });
    });
    return bodies;
  };

  it("leaves a text call byte for byte as it was before images", async () => {
    const bodies = sent();

    await routed.complete(ask);

    expect(bodies).toEqual([
      '{"model":"m","provider":{"data_collection":"deny","zdr":true},' +
        '"messages":[{"role":"system","content":"s"},{"role":"user","content":"u"}],' +
        '"response_format":{"type":"json_object"}}',
    ]);
  });

  it("sends an image as OpenAI multipart content, under the same routing", async () => {
    const bodies = sent();

    await routed.complete({ ...ask, image: "data:image/jpeg;base64,AAAA" });

    expect(JSON.parse(bodies[0]!)).toEqual({
      model: "m",
      provider: { data_collection: "deny", zdr: true },
      messages: [
        { role: "system", content: "s" },
        {
          role: "user",
          content: [
            { type: "text", text: "u" },
            { type: "image_url", image_url: { url: "data:image/jpeg;base64,AAAA" } },
          ],
        },
      ],
      response_format: { type: "json_object" },
      max_tokens: 2500,
    });
  });
});
