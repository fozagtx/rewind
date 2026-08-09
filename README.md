# Rewind

Undo the last twenty minutes of your infrastructure.

## The problem

Zerops keeps your last 10 application versions and will roll any of them back on demand.

It keeps zero versions of your **infrastructure** state: the scaling, the environment variables, the public access you changed around them.

That gap matters now, because ZCP hands a coding agent `zerops_scale`, `zerops_env`, `zerops_manage`, and `zerops_subdomain` with no confirmation prompt. Per the [ZCP MCP operations reference](https://docs.zerops.io/zcp/reference/mcp-operations), only `zerops_delete` and destructive `zerops_import` are gated. One agent session can move a dozen infrastructure fields across several services in under thirty seconds, and nothing rolls that back.

Rewind is the missing undo button.

## What it does

Rewind captures your project configuration on a schedule, compares any two captures, works out which changes it can actually reverse, and puts them back.

```
COULD NOT UNDO, 1 change
Service `worker` was deleted.
  Configuration restored from snapshot. The data it held is gone.
  Deleting a service destroys its volume, and no export contains it.
```

That red panel is the point of the whole tool. A kill switch that stops most of a bad change is worse than one that stops none, because it makes you think you are safe. So Rewind is built to refuse to overclaim:

* Unknown fields default to **CANNOT_UNDO**. Rewind never claims to reverse a field that no known tool can write.
* Secrets are never stored, so a changed secret is reported as irreversible instead of being quietly restored from a value the tool should not have kept.
* A deleted service gets its configuration rebuilt, and the data loss is still reported, because restoring a config does not restore rows.
* A run reports success only when nothing was left un-reversed.

## Running it

These commands run the CLI from inside the project folder. Nothing is published to npm.

```bash
git clone https://github.com/fozagtx/rewind
cd rewind
npm install

zcli login <your-token>            # Rewind reuses the token zcli stores
export ZEROPS_PROJECT_ID=<your project id>

npm run rewind -- doctor           # check the Zerops API is reachable
npm run rewind -- snapshot         # capture project state now
npm run rewind -- diff --to 20m    # show what changed
npm run rewind -- --to 20m --dry-run
npm run rewind -- --to 20m         # reverse it
```

Rewind talks to the Zerops REST API directly and reuses the token `zcli login` already stores, so there is no second credential to manage. Set `ZEROPS_TOKEN` to override it.

Run `doctor` first. It exercises every read path against your own project, so you are checking reality rather than assumptions.

## Proven against a live project

Verified on 2026-08-09 against a real Zerops project, not a mock:

```
1. snapshot                          captured baseline
2. scaled cpuMode DEDICATED via API  drift, the way an agent causes it
3. snapshot                          captured drifted state
4. diff --to 10m
     rewind  cpuMode  DEDICATED -> SHARED   REVERSED
5. --to 10m --dry-run                1 step planned, nothing executed
6. --to 10m                          scale rewind  OK
7. Rewind complete. Everything in that window was reversed.
8. independent API check             cpuMode restored to DEDICATED
```

Step 4 is also where a real bug surfaced. Zerops nests scale fields under `verticalAutoscaling`, so before this was flattened a routine scale change was classified `CANNOT_UNDO`. That is the one verdict the tool must never get wrong, and there are now regression tests covering both nesting shapes.

## How it works

```
capture  ->  snapshot        immutable, sha256 hashed
compare  ->  changeset       service, field, before, after
judge    ->  verdict         REVERSIBLE
                             REVERSIBLE_WITH_RESTART
                             CANNOT_UNDO plus a plain reason
restore  ->  plan            recreate, scale, env, subdomain, restart
                             then a result plus everything it could not fix
```

Scaling changes for one service collapse into a single call. Environment changes trigger exactly one restart per service, ordered last.

## Why this belongs on Zerops

Zerops is not just where Rewind runs. Zerops is what Rewind is about.

On a plain server with docker compose there is no project export to capture, so there is nothing to snapshot. The state is a compose file in git, and git already does diff and revert. There is no ZCP, so there is no unprompted mutation surface for an agent to drift. The mechanism has nothing to point at.

The hosting underneath is ordinary and swappable, and this README will not pretend otherwise.

## Verified against the docs and the API

Checked against live Zerops documentation and a live project on 2026-08-09:

* application rollback keeps the 10 most recent versions, infrastructure state has no equivalent
* `zerops_scale` cannot change HA or NON_HA, which is fixed at service creation
* `corePackage` LIGHT to SERIOUS is one way and partially destructive
* only `zerops_delete` and destructive `zerops_import` carry confirmation gates

Every REST path Rewind uses was probed against a real project. A GET against a write path returns 405 when the route exists and 404 when it does not, which confirmed each one without mutating anything:

```
GET  /project/{id}/export                        200
GET  /project/{id}/service-stack                 200
GET  /service-stack/{id}                         200
GET  /service-stack/{id}/env                     200
PUT  /service-stack/{id}/autoscaling             exists
POST /service-stack/{id}/restart                 exists
POST /service-stack/{id}/enable-subdomain-access exists
POST /process/search                             exists
```

Still unverified: request body shapes for `deleteEnv` and `importServices`. Scale and subdomain were exercised for real. The rest mirror the field names the read endpoints return, which is the best available evidence.

## Tests

```bash
npm test          # 44 tests
npm run typecheck
```

Covers secret redaction, numeric comparison, deterministic ordering, every classification rule, scale call collapsing, step ordering, partial failure handling, both autoscaling nesting shapes, and the rule that a run with anything left un-reversed can never report success.
