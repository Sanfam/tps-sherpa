/**
 * The responder's paid checks before `shadow` (design §4, §10): synthetic
 * intros through extraction and matching, and images through the vision
 * reading. Prints what came back; writes nothing, posts nothing.
 *
 *   node src/sherpa/intro-check.ts [--image <https url>]...
 *
 * Run where the Catalog and the model keys are: in the deployed container
 * (`railway ssh -s bot`, then `cd /app/apps/bot`). Every intro is synthetic,
 * and every image must be one with no real person in it (§10). About a dozen
 * cheap calls, well under 5¢. The daily cap does not apply.
 */
import { WATCHED_CHANNEL } from "../llm/boundary.ts";
import { VOCABULARY_PATH, loadCatalog, loadRoleManifest, openBoundary, readIfPresent } from "../llm/session.ts";
import { parseVocabulary } from "../llm/vocabulary.ts";
import { findPlaces } from "./find.ts";
import { memberRoleIds } from "./interactions.ts";
import { novelty } from "./responder-decide.ts";
import { matchQuery } from "./responder.ts";

/** A synthetic member: no real member has this id. */
const MEMBER = "100000000000000000";

const INTROS: Array<{ label: string; text: string; expect: string }> = [
  {
    label: "interests",
    text: "Hi all! Dad of two from Ohio. Into flight sims (DCS mostly), woodworking in the garage, and I just got a 3D printer.",
    expect: "signal; matches flight sims, woodworking, 3D printing",
  },
  {
    label: "greeting only (Zifei)",
    text: "Hey everyone 👋 glad to be here",
    expect: "no signal: the question path, no match call",
  },
  {
    label: "child detail",
    text: "New here. My toddler keeps me busy but I love camping and the occasional board game night.",
    expect: "signal; life_stage toddler; matches camping, board games",
  },
  {
    label: "long tail (HammerFoe)",
    text: "Long-time lurker finally saying hi. I restore old hand planes, homebrew beer, and run a Friday D&D campaign.",
    expect: "signal; matches beyond the obvious, as in the golden set",
  },
];

const images = process.argv.flatMap((a, i, all) => (a === "--image" && all[i + 1] ? [all[i + 1]!] : []));

const catalog = loadCatalog();
const vocabulary = parseVocabulary(readIfPresent(VOCABULARY_PATH));
const { boundary, monitored } = openBoundary(catalog, {}, 60_000);
const roles = memberRoleIds(loadRoleManifest());
const byId = new Map(catalog.map((e) => [e.id, e]));

for (const intro of INTROS) {
  console.log(`\n=== ${intro.label}\nexpect: ${intro.expect}`);
  const extraction = await boundary.extractIntroduction({
    memberId: MEMBER,
    sources: [{ authorId: MEMBER, authorIsBot: false, content: intro.text, origin: WATCHED_CHANNEL }],
    memberNames: [],
    vocabulary,
  });
  console.log("extraction:", JSON.stringify(extraction));
  if (extraction.signal !== "some") continue;
  const found = await findPlaces({
    query: matchQuery(extraction, vocabulary),
    invokerId: MEMBER,
    catalog,
    monitored,
    roles,
    denied: new Set(),
    vocabulary,
    ask: boundary.ask,
    origin: { derivedFromIntroduction: MEMBER },
  });
  const ids = found.matches.map((e) => e.id);
  console.log("matches:", found.matches.map((e) => e.name).join(" | ") || "(none)");
  // The ConnorDavidSmith / xEMPTYCANx shape: humans already named every match, so novelty leaves none.
  const left = novelty(ids, ids.map((id) => `try <#${id}>`));
  console.log(`welcome-only when humans named them all: ${left.length === 0 ? "yes" : `no (${left.length} left)`}`);
}

for (const url of images) {
  console.log(`\n=== image ${url}\nexpect: a reading (kind, meaning) and nothing else`);
  const response = await fetch(url);
  const type = (response.headers.get("content-type") ?? "").split(";")[0]!.trim();
  if (!response.ok || !["image/jpeg", "image/png", "image/webp"].includes(type)) {
    console.log(`skipped: ${response.status} ${type || "no type"} (needs a JPEG, PNG or WebP)`);
    continue;
  }
  const dataUrl = `data:${type};base64,${Buffer.from(await response.arrayBuffer()).toString("base64")}`;
  const reading = await boundary.readImage({
    memberId: MEMBER,
    image: { authorId: MEMBER, origin: WATCHED_CHANNEL, dataUrl },
  });
  console.log("reading:", JSON.stringify(reading));
}

console.log(`\n${byId.size} Catalog entries; ${roles.length} Member role id(s).`);
