# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repository is

A take-home assignment for Blotato. `README.md` holds the brief: design the backend for comment-triggered automations on social media posts. The reference example:

When someone comments "pricing" on any Instagram post:
1. Reply to the comment with "Sent you a DM!"
2. DM the commenter asking for their email address.
3. Wait for the user to respond.
4. Once an email is received, DM them a link.

The deliverable is the design (architecture, data model, execution model, reliability and concurrency) backed by a working TypeScript + Postgres workflow engine. The reviewer grades reasoning and engineering decisions, not whether the design matches their implementation. The brief also requires a short, honest write-up of which parts the author developed and where AI was used: be clear about what Claude generated versus what the author decided.

`ARCHITECTURE.md` is the design record: numbered decisions, alternatives considered, costs, and open items. Read it before changing behavior, and keep it in sync when a decision changes.

The platform already supports receiving comments and messages, replying to comments, and sending messages. Treat these as existing primitives behind `src/platform/` (a `PlatformClient` port with a mock). Don't design them. The webhook HTTP endpoint and process entrypoint are intentionally not built.

## Commands

Tests run against a real Postgres (docker, host port 5433). `DATABASE_URL` overrides the default `postgres://postgres:postgres@localhost:5433/automations`.

```sh
npm run db:up                         # start Postgres and wait for health
npm run migrate                       # apply migrations/*.sql
npm run typecheck                     # tsc --noEmit
npm test                              # vitest run (needs db:up)
npx vitest run test/planner.test.ts   # one file
npx vitest run -t "partial test name" # one test by name
```

Each test file creates its own schema (`test/helpers.ts`) and migrates it, so files run in parallel and `npm run migrate` is not needed for tests.

## Architecture

Functional core, imperative shell, with strict layering:

- `src/core/`: pure domain logic (types, version validation, trigger matching, run transitions, the conversation state machine for `wait_for_reply`, the run planner, retry policy). No I/O, no imports outside `core/`.
- `src/store/`: one module of plain query functions per table. Every function takes a `Queryable` (pool or transaction) so the caller owns the transaction. No business decisions here, but the concurrency SQL lives here under names stating its guarantee (`claimRunnable`, `applyIfLeaseHeld`, `resumeIfWaiting`).
- `src/app/`: orchestration only (load, ask `core/`, persist, call the platform). No SQL. The three loops are `EventDispatcher` (inbound events to runs and resumes), `Worker` (claims a run with a lease, executes one step), and `ExpiryScheduler` (expires timed-out waits).
- `src/platform/`: platform client port, Instagram DM-window rules (`canSendDm`, pure), mock client.

Cross-cutting mechanics that span several files:

- Postgres is the queue. Webhooks only insert into `inbound_events` (deduped on platform event id). The dispatcher serializes per contact with `pg_try_advisory_xact_lock`; workers claim runs via `UPDATE ... FOR UPDATE SKIP LOCKED` with a `lease_until` that doubles as a fencing token on every later write.
- At most one active (`running` or `waiting`) run per contact, enforced by a partial unique index; extra triggers create `skipped` runs.
- Automation versions are immutable (a DB trigger rejects updates); runs pin their version.
- Outbound sends are at-least-once via `step_executions` rows (`pending` before the platform call, `sent` after), keyed by `(run_id, step_index, effect_key)`.
- Adding a step type means touching both typed tables: definitions in `core/steps.ts` and executors in `app/executors.ts`. They are typed over the step union, so a missing executor fails to compile.
- Time comes from an injected `Clock`. Engine-written timestamps use the app clock, not DB `now()`.

## Testing

- Core logic gets pure unit tests with no database.
- Engine behavior is tested against real Postgres via `test/harness.ts`: a `FakeClock`, `MockPlatformClient`, and explicit `tick()` calls on dispatcher, worker, and scheduler. Advance the fake clock instead of sleeping. Concurrency tests run several ticks in parallel; don't fake concurrency guarantees.
- Beyond design-derived scenarios, write failure-mode tests (late, interrupted, doubled events).

## Notes

- Keep code comments minimal; rationale belongs in `ARCHITECTURE.md`.
- `.envrc` is gitignored (direnv). Never commit it.
