# Blotato Take Home

We want to let customers create automations that begin when someone
comments on one of their social media posts.

For example:

When someone comments **"pricing"** on any Instagram post:

1. Reply to the comment with **"Sent you a DM!"**
2. Send the user a DM asking for their email address.
3. Wait for the user to respond.
4. Once an email address is received, send them another DM containing a link.

Design the backend system that would support this automation.

You are free to decide how general or extensible the automation system
should be, as long as you explain and justify your decisions.

This feature already exists in my product. I am not evaluating whether
your solution matches my implementation; I am evaluating your
reasoning and engineering decisions.

You can assume the system already supports receiving comments and
messages, replying to comments, and sending messages to social media
platforms.

Describe the architecture, data model, and execution model, as well as
any important reliability or concurrency considerations.

In addition, include a short write-up describing which parts of your
solution you developed yourself and where you used AI.

---

## Running the project

The design and its rationale are in [ARCHITECTURE.md](ARCHITECTURE.md). This section covers running the code.

Requirements: Node 20+ and Docker.

```sh
npm install
npm run db:up       # start Postgres 16 on localhost:5433 and wait until healthy
npm run migrate     # apply migrations/*.sql
npm run typecheck
npm test            # requires the database from db:up
npm run demo        # seed the pricing automation and play a full conversation
npm start           # run the engine (dispatcher, workers, scheduler) until Ctrl+C
npm run seed        # in a second terminal: create the pricing automation if needed, then comment as "ana"
npm run seed -- dm ana "ana@example.com"   # reply to the engine's DM
npm run db:down     # stop Postgres
```

Set `DATABASE_URL` to use a different database. The default is `postgres://postgres:postgres@localhost:5433/automations`.

Each test file creates and migrates its own schema, so tests do not need `npm run migrate` and files run in parallel. To run a subset:

```sh
npx vitest run test/planner.test.ts   # one file
npx vitest run -t "partial test name" # tests matching a name
npm run test:watch                    # watch mode
```

`npm start` runs the engine against the database from `db:up`, with a placeholder platform client that logs each send. Events enter through `ingestEvent`, which `npm run seed` calls in place of the platform's webhooks; the webhook endpoint is out of scope (see ARCHITECTURE.md, open items). The tests and the demo drive the dispatcher, worker, and scheduler directly with a fake clock. The demo uses its own `demo` schema, recreated on each run.

## AI usage

I built this with Claude Code (Claude Opus) as the main implementer, and used OpenAI Codex as an independent reviewer. Claude generated most of the code and much of the prose in `ARCHITECTURE.md`. The decisions, the scope and the verification process were mine.

**What I decided**

- The initial spec Claude worked from, and every design question where the brief was open. For example:
  - one active run per contact, enforced in the database, with later triggers recorded as `skipped`
  - leased workers instead of row locks held across platform calls
  - after too many invalid replies, the run ends as `completed` with a `gave_up` outcome, not as `failed`
- The architecture: functional core / imperative shell. I compared it with full DDD and with plain transaction scripts, and chose it so business rules stay unit-testable and no SQL lives in orchestration code.
- Tuning and scope:
  - the retry policy: 10 attempts, 2 s base, 5 min cap. I corrected Claude's first proposal, whose numbers never actually reached the cap.
  - dead-lettering after 5 failures
  - dropping a per-account rate limiter I had originally specified
  - keeping the webhook endpoint out of scope
- How to resolve each review finding. For example:
  - reconcile a private reply the platform reports as "already used", instead of failing the run
  - accept a valid answer that arrives at the moment the conversation gives up

**How I worked with the AI**

- Small chunks. I reviewed and approved every chunk myself; Claude never committed without me reviewing the diff and the design rationale.
- Claude had to ask before any significant design choice.
- Unprimed adversarial reviews after major chunks: a fresh reviewer got only the diff and the brief, with none of our rationale. Three rounds of this, plus a Codex review, found real bugs, including two that Claude introduced while fixing earlier findings.
- Failure-mode tests on top of design-derived tests: crashed workers, timed-out sends that may still have been delivered, duplicate and late events, concurrent dispatchers.
- Mutation checks: break the guard a test protects and confirm the test fails. This exposed two tests that could never fail, and both were rewritten.

**What Claude generated**

Nearly all of the TypeScript and SQL, the tests, and first drafts of the design doc, which I then reviewed and edited.
