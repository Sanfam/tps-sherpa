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
| `DISCORD_BOT_TOKEN` | Papa Sherpa reads the guild and (later) posts | ⚠️ local `.env` only — **not yet in Railway** | ⚠️ TODO | Never (rotate on exposure) | ⚠️ TODO |
| `GITHUB_MACHINE_TOKEN` | The bot commits the Catalog and role manifest | ⚠️ local `.env` only — **not yet in Railway** | ⚠️ TODO | **No expiry set** *(verified 2026-09-02)* | ⚠️ TODO |
| Discord application | Owns the bot; invisible until it is lost | Discord developer portal | n/a — account ownership | n/a | ⚠️ TODO |
| Railway project | Hosting | n/a | n/a | n/a | ⚠️ TODO |
| Cloudflare account | DNS, proxy, R2 | n/a | n/a | n/a | ⚠️ TODO |

## The GitHub token: what actually works here

**Classic PAT with the `repo` scope, on the `tps-papabot` machine user.**
Verified 2026-09-02: authenticates as `tps-papabot`, `push: true` on this repo.

Two approaches were tried first and failed, both for reasons worth recording:

- **A fine-grained PAT cannot reach this repo at all.** Fine-grained tokens
  only see repositories owned by their own account. `tps-papabot` owns nothing
  and is merely a collaborator, so the repo is not selectable — the token
  listed zero repositories despite valid write access. This is an artifact of
  the repo living on a personal account; an org-owned repo (#12) would not
  have it.
- **`public_repo` is not enough.** This repo is private, and GitHub answers
  with `404 Not Found` rather than `403`, so it reads as "the repo does not
  exist" rather than "you lack the scope". The full `repo` scope is required.

`repo` sounds broad, but `tps-papabot` is a collaborator on exactly one
repository, so that is the real blast radius.

**A deploy key remains the lower-maintenance option**: scoped to one repo by
construction, no account, and no expiry to lapse. Commit attribution survives
either way, because the bot sets author and committer itself. Worth revisiting
if credential rotation becomes a chore.

## Expiry is a scheduled outage

The current token has **no expiry set**, which removes that particular trap and
introduces the opposite one: a credential that lives forever until somebody
remembers to rotate it. Neither is free.

Either way, a failed push must be an **alarm**, not a log line (see #10). When
this credential stops working the sync does not crash loudly — it stops
committing, and the Catalog goes quietly stale until somebody wonders why.
Silence is the failure mode to design against.

## When a credential is rotated

Update Railway, update the password manager, update the row above. All three,
or the register becomes fiction — which is worse than no register, because
people trust it.
