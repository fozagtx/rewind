# Rewind

Undo the last twenty minutes of infrastructure.

Zerops keeps your **last 10 application versions** and will roll any of them back on demand. It keeps **zero** versions of your *infrastructure* state — the scaling, env vars, and public access you changed around them.

Meanwhile ZCP hands a coding agent `zerops_scale`, `zerops_env`, `zerops_manage`, and `zerops_subdomain` **with no confirmation prompt**. Per Zerops' own [MCP operations reference](https://docs.zerops.io/zcp/reference/mcp-operations), only `zerops_delete` and destructive `zerops_import` are gated. One agent session moves a dozen infra fields across several services in under thirty seconds, and nothing rolls that back.

Rewind snapshots declarative project state, diffs it, replays the reversal — and names exactly what it could not undo.

## The part that matters

```
COULD NOT UNDO — 1 change
Service `worker` was deleted.
  Service was deleted. Configuration can be restored from snapshot.
  Its data is gone and cannot be recovered.
```

Any tool that reports a clean rewind without a panel like that is lying to you. A kill switch that stops *most* of it is worse than one that stops none, because it manufactures false confidence. So:

- **Unknown fields default to `CANNOT_UNDO`.** Rewind never claims to reverse a field no known mutation tool writes.
- **`complete` is true only when residue is empty AND every step succeeded.**
- **Secrets are never stored**, so a changed secret is reported as irreversible rather than silently restored from a value we should not have kept.
- **A created service is never auto-deleted.** Reversing a creation is destructive, so Rewind reports it and leaves the call to you.

## Usage

```bash
export ZEROPS_PROJECT_ID=<your project id>

npm run rewind -- doctor        # verify the MCP tool surface is reachable
npm run rewind -- snapshot      # capture project state now
npm run rewind -- diff --to 20m # show what changed
npm run rewind -- --to 20m --dry-run
npm run rewind -- --to 20m      # reverse it
```

`doctor` dumps the live tool list from `tools/list`. Run it first — it confirms the real server surface rather than an assumed one.

Rewinding is CLI only, deliberately. The deployed service is **read only** — it serves `/health`, `/api/snapshots`, and `/api/changeset`, and contains no route that mutates your infrastructure. A public subdomain plus a route that reverses live state would be a bad trade.

## How it works

```
zerops_export ──▶ snapshot (sha256, immutable artifact)
                      │
                      ├── diff ──▶ changeset (service · field · before → after)
                      │              │
                      │              └── classify ──▶ REVERSIBLE
                      │                               REVERSIBLE_WITH_RESTART
                      │                               CANNOT_UNDO + reason
                      │
                      └── plan ──▶ recreate → scale → env → subdomain → restart
                                     │
                                     └── execute ──▶ ReplayResult + residue
```

Scale fields coalesce into one `zerops_scale` call per service. Env changes emit exactly one restart per service, ordered last for that service.

## Why Zerops

Zerops is not where Rewind runs. Zerops is what Rewind is **about**.

On a VPS with docker-compose there is no `zerops_export`, so there is nothing to snapshot — state is a compose file in git, and git already does diff and revert. There is no ZCP, so there is no ungated mutation surface for an agent to thrash, so there is no drift. Four of five mechanisms lose their referent entirely.

The hosting substrate — Postgres, object storage, cron, a worker — is swappable, and this README will not claim otherwise.

## Status

Verified against live Zerops docs on 2026-08-09:

- app rollback retains the 10 most recent versions; infra state has no equivalent
- `zerops_scale` cannot change `HA`/`NON_HA` — "set at service creation"
- `corePackage` LIGHT→SERIOUS is one-way and partially destructive
- only `zerops_delete` and destructive `zerops_import` carry confirmation gates

**Unverified:** exact argument *names* per MCP tool are not published — only tool names, purposes, and mutation scope. The public REST swagger returned 404, so coding against REST paths would mean inventing them. `src/lib/zerops.ts` targets the documented MCP surface, and `doctor` reads the live schema. Run it against a real project before demoing.
