# ADR-0004: Bounded model text in replies to @mentions

**Status:** Accepted, 2026-10-20, from the owner's decisions of 2026-10-18
(`docs/proposals/mention-replies.md`, *Owner decisions*).
**Covers:** themed replies to @mentions (#49).
**Departs from:** the anti-goal "model prose emitted directly to Discord or the
site" (`ASTRO-ARCHITECTURE.md`), for this one path.

## Context

Everything Sherpa posts to members today comes from a template. The model
answers with keys, slugs and enums, and code renders the text. That is the
prompt-injection containment: no input can make the bot say anything.

The owner asked for Sherpa to answer an @mention in its own voice, a kindly
gamer dad, with a reply that fits the conversation. A template cannot do that.
The model has to write words that members see.

## Decision

**One new boundary function, `replyToMention`, may return text that reaches
members.** It is a separate function in `boundary.ts`, as `extractIntroduction`
is, not an option on `ask()`. No other path's output is posted as text.

### The reply

- The model answers `{"intent": "chat" | "help", "line": string}`.
- `help` posts the fixed help text, and `line` is dropped.
- `chat` posts `line`, then code may append one fixed sign-off line, picked
  for the asker's role (below).

### What `line` may be

The boundary's usual validation applies: no Discord identifier, no mass mention
and no member name, keys included. On top of that, `line` is **refused**, never
repaired, if it:

- is longer than **500 characters** (code points);
- holds a URL, a domain with a path, or `discord.gg`;
- holds any `<`, `>` or `@`, which rules out every Discord mention, emoji and
  timestamp markup;
- holds `||` or `](`, Discord markdown that hides text or masks a link;
- holds more than one line break.

A refused or failed answer posts the persona's fixed fallback line instead.
Every reply is sent with `allowed_mentions: { parse: [], replied_user: true }`,
so nothing in it can ping anyone but the asker.

Places are never in `line`. The model is not shown the Catalog, so it cannot
point anyone anywhere; `/find` and the introductions responder still name
places from templates.

### Where it answers

Every Channel, Thread and Post the bot is in (D49-2). The owner thereby
authorised Sherpa's first reply in each. Refused in code, with silence:

- a **monitored** Channel, or a Thread or Post under one. `#introductions` is
  monitored, and mentions there stay with the responder's invited path;
- a **withheld** Channel, or one under it, and any place whose history the bot
  cannot read;
- the **User Monitoring** Forum, whose Posts hold ADR-0003 `moderation` output,
  which that ADR confines to Staff tools.

A place outside the Catalog (an excluded Channel, the Staff category, a new
Thread) is resolved through Discord: its parent is read, and the checks above
are made against that.

### What reaches the model

- The asker's message, and the **10 messages before it** in the same place
  (D49-4). One REST read, never stored.
- Bots are dropped, except Sherpa's own posts. Authors with processing off are
  dropped. An asker with processing off gets the fixed opt-out text, and no
  call is made.
- Speakers are labelled "the asker", "member A", "member B" and "Sherpa", and
  a mention of Sherpa reads as "Sherpa". Every author's username, global name
  and server nickname (looked up per author, since a message read over REST
  carries none) and every mentioned user's names are redacted on the way out
  and refused on the way back, with the member-name cache. Sherpa's own names
  are not: refusing "Sherpa" would refuse every reply that says it.
- Only this guild: a mention in any other guild the bot is in is ignored.
- **No role reaches the model** (D49-6). Role flavour is a fixed sign-off line
  in the persona file, chosen by code from the asker's roles.

### How it is bounded

- A **Staff switch**, `/sherpa mentions mode off | shadow | live`, `off` until
  set. **Shadow comes first**: replies go to `#bot-tests` with a jump link, and
  members see nothing.
- **15 seconds per member** between replies (D49-5). There is no exchange cap.
- A **daily cap** of 100 calls (`SHERPA_MENTION_DAILY_CAP`), separate from the
  responder's, as the runaway guard.
- No follow-ups without a mention (D49-3). Replying to one of Sherpa's posts is
  a mention.

## What remains possible

A name the redaction never heard of: a member called by a name that is none of
their username, global name or nickname. And tone. A crafted message in the context can make Sherpa say something rude,
false or embarrassing, in up to 500 characters, with no link, no ping and no
name. Shadow mode is where that is measured, and the switch turns it off.

## Open, for the owner before the switch leaves `off`

- **Child data.** A dad's question or the context may name a child's age, and
  the reply could repeat it in public. The prompt forbids repeating anything
  about anyone's children; nothing in code refuses it. Child data is a stop
  condition, so the owner decides whether the prompt rule is enough.
- **The privacy-policy line**, worded by the owner.
- **Staff places.** `#ambassador-chamber` (Staff talk about new members, and
  the alerts) and `#bot-tests` (the responder's shadow posts) are answered
  today. Whether to refuse them as the User Monitoring Forum is refused.

## Consequences

- The persona file (`content/config/persona.json`) is reviewed like the
  vocabulary: its voice and fixed lines are what members read.
- The privacy policy gains a line for what a mention sends, worded by the owner
  before the switch leaves `off`.
- Any later path that wants model text in Discord needs its own ADR. This one
  does not generalise.
