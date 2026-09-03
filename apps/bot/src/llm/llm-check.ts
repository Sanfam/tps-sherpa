/**
 * One real call per configured model, end to end through the boundary.
 *
 *   node --env-file=.env src/llm/llm-check.ts
 *
 * The wire is a thin adapter and is not unit-tested — this is how it gets
 * exercised, the same way `record-fixtures.ts` exercises the Discord one. It
 * also answers the question the config cannot: whether the model actually
 * returns JSON when asked, which is the whole containment posture.
 */
import { createBoundary, type ModelRole } from "./boundary.ts";
import { openAiWire, wireFromEnv } from "./openai-wire.ts";

const subject = {
  id: "1",
  type: "post" as const,
  name: "Helldivers squad",
  url: "https://discord.com/channels/1/1",
  parent_id: null,
  description_status: "present" as const,
  topic: null,
  applied_tags: [],
  region: [],
  last_message_id: null,
  last_activity_at: null,
  summary_generated: null,
  summary_override: null,
};

const { wire, models } = wireFromEnv();
const boundary = createBoundary({
  chat: openAiWire(wire),
  models,
  catalog: [subject],
  names: { channels: new Map(), roles: new Map() },
  warn: (m) => console.warn(m),
});

console.log(`Base URL: ${wire.baseUrl}`);

for (const role of ["strong", "cheap"] as ModelRole[]) {
  const started = Date.now();
  try {
    const answer = await boundary.ask({
      role,
      system:
        'Summarise the thread in at most 12 words. Reply with JSON: {"summary": string}.',
      subject,
      // A member mention and a bare snowflake, so the run proves redaction
      // happened rather than merely that a model replied.
      context: "Nightly co-op runs on hard difficulty.",
      sources: [
        {
          authorId: "1",
          authorIsBot: false,
          content: "<@732682426853359667> and 732682426853359667 are usually on after 9",
        },
      ],
      parse: (value) => {
        const summary = (value as { summary?: unknown }).summary;
        if (typeof summary !== "string") throw new Error(`No summary in ${JSON.stringify(value)}`);
        return summary;
      },
    });
    console.log(`✓ ${role} (${models[role]}) ${Date.now() - started}ms: ${answer}`);
  } catch (error) {
    console.error(`✗ ${role} (${models[role]}): ${(error as Error).message}`);
    process.exitCode = 1;
  }
}
