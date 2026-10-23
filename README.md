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
npm run db:down     # stop Postgres
```

Set `DATABASE_URL` to use a different database. The default is `postgres://postgres:postgres@localhost:5433/automations`.

Each test file creates and migrates its own schema, so tests do not need `npm run migrate` and files run in parallel. To run a subset:

```sh
npx vitest run test/planner.test.ts   # one file
npx vitest run -t "partial test name" # tests matching a name
npm run test:watch                    # watch mode
```

There is no server entrypoint. The webhook endpoint is out of scope (see ARCHITECTURE.md, open items), so the engine is exercised through the tests and the demo, which drive the dispatcher, worker, and scheduler directly. The demo uses its own `demo` schema, recreated on each run.
