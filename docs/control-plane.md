# Control plane — design

> **Status: proposed.** Nothing here is built yet. Tracked in the GitHub issue
> that links to this file.

An admin page, served by the app at `/admin`, for running the lifecycle of
events and sessions from a browser instead of from `make` targets and a
terminal: list what is live, stage an event, close / reopen / restart a session,
get its console and Desktop links, export its scores.

## Why

Today every lifecycle step outside a running console goes through this repo:

| Task | How it is done today | What the server already has |
| --- | --- | --- |
| Stage an event | `make stage EVENT=<dir>` runs `app/scripts/stage-event.mjs` against a gitignored `config/events/<dir>` on the operator's laptop | `POST /api/sessions` (admin key), then per-session uploads: `content/trivia`, `content/arcade`, `content/promo`, `content/sendoff`, `assets/*` |
| List sessions | `make sessions` | `GET /api/sessions` (admin key) |
| Close a session | `make close SID=… [FORCE=1]` | `POST /api/sessions/:sid/close[?force=1]` (admin key) |
| Open, start, reopen, restart | Only from that session's console | Host commands over the console's WebSocket (host token) |
| Export scores / event log | `curl` with the host token | `GET /api/sessions/:sid/export.csv`, `events.jsonl` (host token) |
| Service up / down / deploy | `make up`, `make down`, `make deploy` | Terraform, not the app |

That needs a laptop with the repo, AWS credentials, the admin key from SSM, and
the host token that was printed once at staging. A browser page needs only the
admin key.

## Decisions

1. **Inside the app, not a separate service.** A session lives in the memory of
   the one ECS task that runs it (`registry`, `SessionRuntime`). A separate
   control plane would have to call that task for every action anyway, and would
   be another thing to deploy, secure and keep in step. `/admin` is another
   surface of the same server, like `/host` and `/screen`, and it uses the same
   vendored Carbon UI Shell as the console.

2. **Sign-in starts with the admin key.** No user accounts and no identity
   provider in the first version. Details below. A sign-in in front of
   `/admin` at the load balancer (ALB OIDC) can come later without changing
   the page, because the page only ever sees a signed-in cookie.

3. **Lost console links are reissued, not stored.** The host and screen tokens
   are printed once and stored hashed (`hostTokenHash`, `screenTokenHash`), so
   nothing can show them again, and that is deliberate. The admin page offers
   **New links** instead: it mints a fresh host and screen token, replaces the
   hashes, and shows the links once. The old links stop working, which is also
   the fix for a console link that was screen-shared by mistake.

4. **Infrastructure stays in Terraform.** The page is served by the service, so
   it cannot start the service, and a deploy is better as a reviewable plan. The
   page shows the running version and `/healthz` read-only, and nothing more.

## Sign-in with the admin key

The admin key is the existing SSM `SecureString` (`admin_key_parameter_name`).
It already guards `POST /api/sessions`, `GET /api/sessions` and `close`.

- **`/admin` serves a sign-in form** when there is no valid session cookie. One
  field: the key.
- **`POST /api/admin/login`** checks it the way `adminOk` does today:
  `tokenMatches` against the hashed key, never `!==` on the raw string. An unset
  key refuses everything.
- **Failures are rate limited per IP**, the way `HELLO_FAIL_LIMIT` limits failed
  joins: about five a minute, then `429`.
- **On success the server sets a cookie, not the key.** It is an opaque random
  token, its hash kept in memory with an expiry (8 hours, matching an event day),
  and it is `HttpOnly; Secure; SameSite=Strict; Path=/`. The key is never stored
  in the browser, in `localStorage` or anywhere else.
- **State-changing admin requests also need same-origin.** Every `POST` checks the
  `Origin` header against the service's own host, on top of `SameSite=Strict`.
- **`POST /api/admin/logout`** drops the cookie's session.
- **A restart signs everyone out.** Sessions are in memory, like the runtimes.
  That is acceptable for one operator and a deploy once a day. Persisting them
  is not worth a table.
- **The existing `Authorization: Bearer <admin key>` header keeps working** on the
  existing endpoints, so `make sessions`, `make close` and `stage-event.mjs` are
  unchanged.

Rotating the key is unchanged: set the SSM parameter and redeploy. Every cookie
dies with the restart.

## Phase 1 — Sessions

A table of every session the task knows about, from `GET /api/sessions`: title,
sid, phase, segment, participants, open sockets, age. Then per-session actions:

| Action | Endpoint | Notes |
| --- | --- | --- |
| Close | existing `POST /api/sessions/:sid/close` | Refused with people connected unless confirmed, as `FORCE=1` |
| Reopen | **new** `POST /api/sessions/:sid/reopen` | Applies the engine's `reopen` event, which the console already sends |
| Restart | **new** `POST /api/sessions/:sid/restart` | `restartSession`. Behind the same danger confirm the console uses |
| New links | **new** `POST /api/sessions/:sid/links` | Mints host + screen tokens, replaces the hashes, returns the links once. Disconnects open console and Desktop sockets, which then fail their next hello with `bad_token` |
| Export | existing `export.csv`, `events.jsonl` | Accept the admin cookie as well as the host token |
| Open console / Desktop | — | Only straight after New links or staging, while the page still holds the token |

All new endpoints are admin-only and go through the same session checks as the
console's commands: a closed session is frozen except for its exits, exactly as
the reducer already enforces.

## Phase 2 — Staging from the page

Move what `stage-event.mjs` does into the server, so staging is one upload:

- Upload an event folder as a `.zip` with the same layout as `config/events/<dir>`
  (`session.json`, the trivia CSV, `arcade-content.json`, the promo card,
  `sendoff/`). Size-capped, unpacked in memory, never to disk.
- The server validates it with the parsers it already has (the question-bank
  parser, `arcade-content` validation, the send-off checks). It shows the same
  summary staging prints today (*28 questions loaded · arcade recruitment 7,
  unseal 13, glassBridge 6, gganbu 8 · promo card · send-off 3 messages*) and
  any problem before anything is created.
- **Stage** creates the session and applies the content through the existing
  per-session handlers. The console's pre-flight then runs as it does now.
- The links are shown once, with a copy button and the warning the script prints
  ("never screen-share the console").

`make stage` stays, and becomes a thin client of the same endpoint.

## Phase 3 — Event library

Events stop being folders on a laptop:

- A new **event** record in DynamoDB holds an event's content and settings,
  separate from the sessions run from it. One event, many sessions: a dry run in
  the morning, the real one at two.
- Content is edited in the page: questions (with the existing CSV import and
  export), arcade content, the running order and round settings the console's
  setup already has, the promo card, send-off messages and photos (into the
  existing assets store).
- **Run** clones the event into a new session: the phase 2 path, with the event
  as the input.

This is the phase that removes the repo from running an event. It is also the
largest, and it is worth doing only once phases 1–2 have been used at a real
event.

## Out of scope

- Multiple operators, roles, audit by user. One shared key until there is a
  second operator who needs to be told apart.
- Anything the console does during a session. The control plane gets a session
  to the console and back. It does not drive a round.
- Infrastructure changes, beyond the read-only version and health line.

## Risks

- **The admin key becomes a browser-typed secret.** It is mitigated by the
  `HttpOnly` cookie, the failure rate limit, and same-origin checks, and it is
  why OIDC at the ALB is the natural next step.
- **New links disconnects a live console.** It sits behind a confirm that says so,
  and is disabled while a round is running unless confirmed twice.
- **One task, in-memory sessions.** This is unchanged by this design, but the
  page makes it more visible: a deploy mid-event signs the operator out and
  reconnects every phone, as it does today.
