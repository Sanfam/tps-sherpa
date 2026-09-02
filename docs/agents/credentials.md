# Credential register

**No secret values in this file. Ever.** This records what exists, what it is
for, where to find it, and when it dies — so that someone who is not the person
who created it can take over.

A credential only one person can reach is the failure this project exists to
fix, wearing a different hat.

## The rule

Every credential gets three homes:

1. **Runtime** — the deployment environment variable the app reads.
2. **Durable** — a shared password manager entry that **at least two people**
   can open. Not a laptop, not a note, not only Railway.
3. **Logged** — a row in the table below.

## Register

| Credential | Purpose | Runtime location | Durable copy | Expires | Owners |
|---|---|---|---|---|---|
| `DISCORD_BOT_TOKEN` | Papa Sherpa reads the guild and (later) posts | Railway service var | ⚠️ TODO | Never (rotate on exposure) | ⚠️ TODO |
| GitHub machine-user PAT | The bot commits the Catalog and role manifest | Railway service var | ⚠️ TODO | ⚠️ TODO — **record the date** | ⚠️ TODO |
| Discord application | Owns the bot; invisible until it is lost | Discord developer portal | n/a — account ownership | n/a | ⚠️ TODO |
| Railway project | Hosting | n/a | n/a | n/a | ⚠️ TODO |
| Cloudflare account | DNS, proxy, R2 | n/a | n/a | n/a | ⚠️ TODO |

## Scope the GitHub token narrowly

Fine-grained PAT, **this repository only**, `contents: write` and nothing else.
It exists to push `content/` — it does not need issues, actions, packages or
any other repo.

## Expiry is a scheduled outage

Fine-grained PATs cap at roughly a year. When one lapses the sync does not
crash loudly — it just stops committing, and the Catalog quietly goes stale
until somebody wonders why.

So: put the expiry date in the table above, and make a failed push an **alarm**
rather than a log line (see #10). Silence is the failure mode to design against.

## When a credential is rotated

Update Railway, update the password manager, update the row above. All three,
or the register becomes fiction — which is worse than no register, because
people trust it.
