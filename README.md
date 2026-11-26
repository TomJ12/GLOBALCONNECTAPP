# Global Connect — client app and server

A mobile app for Global Connect business customers (multi-currency balances, account
details, payments with approval, spot and forward conversion, rates and rate alerts) and
the Global Connect server it signs in to.

**Nothing here is connected to a real provider. All data is sample data and the
provider APIs are in-memory mocks. The server keeps its own data (accounts, sessions,
requests, the audit log) in a SQLite database; see "Database".** The server also serves an **ops console** for
Global Connect staff under `/ops` (see "Ops console").

**The server is strict by default and, as it stands, only runs in development mode.**
Mock providers, sample data, printed activation codes, the console "outbox" that stands
in for email, and a generated encryption key exist only with `APP_ENV=development`, which
`npm run demo` and `npm run server` set. Without it the server refuses to start on
mocks or without a real mailer. It can now send real email (SMTP; see "Email"), but
this repository still has no live provider transport, so it still cannot start outside
development. `NODE_ENV` decides nothing. Fees,
delivery times and regulatory wording are bracketed placeholders.

- App: Expo SDK 58, React Native 0.88, TypeScript strict, expo-router; iOS, Android, web
- TanStack Query for server state, zustand for session and developer settings
- big.js for all money and rate arithmetic (amounts are decimal strings, never floats)
- zod validation of every backend response
- Server (`server/`): Node 22.13 or newer, Fastify, TypeScript strict, node:crypto (scrypt,
  HMAC, AES-256-GCM) and Node's built-in SQLite (`node:sqlite`); no native modules to compile

The app has two backends, chosen at build time in `src/api/index.ts`:

| `EXPO_PUBLIC_API_URL` | Backend | Sign-in |
|---|---|---|
| unset | in-app demo, no server | any email and password, code `000000` (checks nothing real) |
| set | the Global Connect server | password + authenticator app, step-up on money actions |

## Run it

```bash
npm install        # also installs server/ (postinstall)
```

### Demo with the server: one command

```bash
npm run demo
```

This builds the web app with `EXPO_PUBLIC_API_URL=/` and starts the server in
development mode (`APP_ENV=development`), which serves the web app **and** the API on
one port (3001). Open `http://localhost:3001` (client app) or
`http://localhost:3001/ops` (ops console). Because the page and the API share an origin
there are no cross-origin requests.

**GitHub Codespaces:** run the same command. The script reads `CODESPACE_NAME` and prints
the forwarded address (`https://<codespace>-3001.app.github.dev`); open it from the Ports
tab. The port can stay private. Activation links use that address, the ops cookie is
`Secure` there, and one hop of `X-Forwarded-For` is believed (`TRUST_PROXY=1`).
(Not run in a Codespace by us: see "Not production-ready and not verified".)

At start-up, in development mode only, the server prints an activation code and link
for each **sample** account that is not activated yet: the three sample clients and
three demo staff for the ops console (`ops.admin@globalconnect.example` and
`ops.admin2@globalconnect.example`, ops admins, and `ops.second@globalconnect.example`,
an ops user). Three, because sensitive ops actions need a second person, and staff
management and company mappings need a second ops **admin**.

**A restart does not replace codes.** A code printed on an earlier start is printed
again, marked "still valid", for its 72 hours; a link emailed from the ops console
since then is left alone (the start-up output says so instead of printing a new code);
accounts created in the ops console are never touched at start-up. A new code is made
for a sample account only when it has no live one.

| User | Company | Held at |
|---|---|---|
| `amira@northfield.example` | Northfield Trading Ltd | provider A (forwards) |
| `ben@castlebrook.example` | Castlebrook Imports Ltd | provider B (no forwards) |
| `dana@adviser.example` | both | chooses a company after signing in |

All three are admins of their companies, and **both companies need one approval for a
payment** (see "Approvals"): a payment Amira creates is held until Dana approves it, and
the other way round. To see a payment go through you therefore need **two activated
people in the same company**, for example Amira and Dana for Northfield.

To try it:

1. Open the app, press **Activate a new account** and type the code printed for a user
   (or open the printed activation link; the code is the part after `#`).
2. Choose a password: at least 12 characters, not a common one.
3. **Add the account to an authenticator app.** On your phone open Google Authenticator,
   Microsoft Authenticator, 1Password, Authy or any other TOTP app, choose *add account* /
   *scan a QR code* and scan the code on screen. If you cannot scan, choose *enter a setup
   key*, type account name `Global Connect`, the key shown under the QR code, type
   *time-based*. The app then shows a 6-digit code that changes every 30 seconds.
4. Type the current 6-digit code to confirm, then save the recovery codes and tick
   "I have saved these codes".
5. Sign in with the email, the password and a **new** code (a code works once, so wait
   for the next one if you just used it to activate).
6. Send a payment: after the review step the app asks for a fresh 6-digit code.
7. In the ops console (`/ops`): activate a demo staff account from its printed link the
   same way and sign in with password and code. After that the console never asks for a
   code again: press a button (say **Revoke all sessions** on a client's page), read the
   confirmation page that says what will happen, and press **Confirm**. Things that
   need a second person become a request under **Approvals**, which another staff
   member opens and confirms; for staff changes, a new or re-pointed company, a
   change to a company's payment-approval rule and a client authenticator reset that
   second person is also asked for their password.

8. **A forgotten password.** Sign out, press **Forgot your password?**, type the email.
   The reset email is printed in the server's terminal (`DEVELOPMENT OUTBOX`); open its
   link. The page asks for a new password **and** a code from the authenticator app:
   the link alone changes nothing (try it with a wrong code).
9. **Your rates.** Open **Rates**: each pair shows "Sell GBP" and "Buy GBP", labelled
   "Your rate · Indicative". They move every 20 seconds or so (the mock rates wander;
   pull down to refresh). Tap one to open Convert for that trade; the held quote is at
   the same rate, apart from movement in between.
10. **A margin change with its worked example.** In the ops console open a company,
    **FX margin**, change the default (say from 50 to 80) and press **Change FX
    margin**. The confirmation shows what it does to a real trade ("selling GBP 10,000
    for USD: the client rate changes from ... to ..."). Confirm; it becomes a request.
    Sign in as a second ops **admin**, open it under **Approvals**, confirm with the
    password. Refresh Rates in the app: the client's rates have moved. **Revenue** (ops
    admins) lists a conversion booked afterwards with the provider rate, the client
    rate and what was earned.
11. **A rate alert firing.** On Rates press **New alert**, choose "Sell GBP" and set the
    target a little above the rate shown (two or three points in the fourth decimal
    place). The server checks alerts every 60 seconds (`ALERT_CHECK_SECONDS`; set it to
    10 for a demo: `ALERT_CHECK_SECONDS=10 npm run demo`). When the wandering rate
    reaches the target, the bell on Home shows 1, the list says what was reached and
    that it is indicative, an email is printed in the terminal, and the alert shows
    "Reached ...; turn on to be told again". It does not fire a second time.
12. **An approver being notified.** As Amira create a payment. Dana (the other person in
    Northfield) gets "A payment is waiting for your approval" in the bell and an email
    in the terminal: amount, payee name, who created it, when it expires; no bank
    details. Dana rejects it with a reason: Amira is told who rejected it and why.
    Approve another: Amira is told it was sent for processing.

**Email in the demo is printed, not sent.** Whenever the server sends an email (an
activation link, a password reset, a security notice, a notification) the whole message
is printed in the terminal the server runs in, marked `DEVELOPMENT OUTBOX`, unless an
SMTP server is configured (see "Email"). That is the only place a link appears: it is
never shown in the ops console and never returned over HTTP.

**Demo data is kept between runs.** `npm run demo` keeps everything in a SQLite
database, `.demo-data/globalconnect.sqlite` (git-ignored), and says so when it starts:
accounts you activate, sessions, lockouts, pending requests and the audit log all
survive a restart. Wipe it with `npm run demo:reset`, which only ever deletes the demo
database in `.demo-data` (if `DATABASE_PATH` or `DATA_FILE` points anywhere else it
refuses and deletes nothing). Authenticator keys in it are
encrypted with a development key that is generated once and kept in a file beside the
database (`globalconnect.sqlite.dev-key`); that only happens with
`APP_ENV=development`. The activation codes the server itself printed for the sample
accounts are also kept, readable, in a development-only table so the same code can be
printed again after a restart; outside development nothing is ever written there.
**If you ran an earlier version**, `npm run demo` finds the old
`.demo-data/accounts.json`, stops at once, before building anything, and tells you to
run `npm run demo:reset` (the old file is not converted). Without `DATABASE_PATH` (for
example `npm run server`) the database is in memory: a restart forgets everything and
prints new codes.

**Who can reach it.** In development the server shows sample accounts and prints their
activation codes, so it listens **on this machine only** (`127.0.0.1`) unless told
otherwise. That is also what a GitHub Codespace needs: its port forwarding connects
from inside the codespace. A development server on any other address (`HOST=0.0.0.0`,
for a phone on your network or a container) must be behind the demo gate
(`DEMO_ACCESS_PASSWORD`), which is how the Docker image and Fly run it; or you must say
so in so many words with `DEV_OPEN_ON_NETWORK=1`, and the server then prints a warning
at every start. Outside development the address is the operator's choice, as before.

**Node.js 22.13 or newer is required** (`node --version`). `npm run demo` and the server
check and say so plainly. The repository has a `.devcontainer` that asks GitHub
Codespaces for a Node 22 image; a codespace created before it was added needs
"Rebuild container", or `nvm install 22 && nvm use 22`. Node prints one
`ExperimentalWarning: SQLite is an experimental feature` line at start-up; see
"Database".

**Showing the demo without your laptop.** [docs/DEPLOY-DEMO.md](docs/DEPLOY-DEMO.md)
is a step-by-step guide to putting this same demo on Fly.io in London behind a demo
password (`Dockerfile`, `fly.toml`). It is still a demo on mock providers with sample
data. On Fly, or on any address that is not this machine or a Codespace, the server
refuses to start in development mode unless `DEMO_ACCESS_PASSWORD` and real values for
`SERVER_SECRET`, `ADMIN_TOKEN` and `DATA_ENCRYPTION_KEY` are set; with the password set,
everything except `/healthz` sits behind a gate page ("Global Connect demo: sample data
only"). `npm run demo` on a laptop or in a Codespace is unchanged.

**Operator commands.** Three commands talk to the running server; they stand in for
tooling an operator with access to the machine would have:

```bash
npm run invite -- amira@northfield.example          # email a new activation link to a client
npm run create-ops-admin -- jo@example.com "Jo Smith"   # see "Ops console"
npm run break-glass -- unlock-staff jo@example.com "why"   # see "Break-glass"
```

They need `ADMIN_TOKEN` in `server/.env` (generate one with `openssl rand -base64 32`;
the server refuses placeholders and short or repetitive values) and they reach the
server on a **separate listener bound to 127.0.0.1 only** (`ADMIN_PORT`, default 3002).
The public port has no `/admin` route. No command prints a link: the link is
emailed (in development: printed in the server's terminal).

**Running in GitHub Codespaces: if something does not work**

- Use only the links printed by the **latest** start, and open them in a normal browser
  tab. The editor's built-in preview shows pages inside a frame, and both the ops
  console and the client app refuse to be framed.
- After pulling a new version, `npm run demo` upgrades the demo database it finds (and
  makes the `.demo-data` folder private to you, which the server now insists on). To
  start from fresh sample accounts instead run `npm run demo:reset` first; activation
  links from before the reset no longer work.
- If the activation code field is empty after opening a link, type the code printed
  next to the link (it is also the part of the link after `#code=`).
- An "email" from the ops console is not sent anywhere: look in the terminal where
  `npm run demo` is running for `DEVELOPMENT OUTBOX`.

### Developing with live reload (two terminals)

```bash
npm run server                                         # API on :3001 (development mode)
EXPO_PUBLIC_API_URL=http://localhost:3001 npm run web  # app on :8081
```

`npm run server` loads `server/.env.development` (one line: `APP_ENV=development`) and
then `server/.env` if there is one. `npm --prefix server start` does not, and is strict.

The server's CORS allows only the origins in `CORS_ORIGINS` (default
`http://localhost:8081`). In Codespaces set `CORS_ORIGINS` and `APP_URL` to the forwarded
8081 address, `EXPO_PUBLIC_API_URL` to the forwarded 3001 address, and make port 3001
public (a private forwarded port answers cross-origin requests with a login redirect).
`npm run demo` avoids all of this.

### In-app demo, no server

```bash
npm run web        # browser
npm run ios        # iOS simulator (macOS) or Expo Go
npm run android    # Android emulator or Expo Go
```

With `EXPO_PUBLIC_API_URL` unset the app runs entirely on an in-app mock. Sign in with
any email and any password, code `000000`. The activation screens can be walked through
with activation code `SAMPLE-ACTIVATION`. **This sign-in checks nothing**; it exists so
the screens can be shown offline.

### Checks

```bash
npx tsc --noEmit         # typecheck
npx expo lint            # ESLint
npx jest                 # unit and screen tests
npx expo export -p web   # static web build in dist/

cd server
npm run typecheck
npm test                 # node:test, 242 tests (about five minutes)
```

Serve the web build with any static server that falls back to `index.html`, for example
`npx serve -s dist`.

## Driving the in-app mock (for testing)

Applies only when `EXPO_PUBLIC_API_URL` is unset.

Three ways, all changing the same settings, read on every mock request:

1. **Developer panel**: Home → avatar → *Profile and settings*. It sits behind the
   session like every other screen, so it is not reachable signed out. If a forced error
   has signed you out, reload (controls reset to their defaults) or use `__GC_DEV__`.
2. **Environment variables** at start/build time (see `.env.example`):

   | Variable | Meaning | Default |
   |---|---|---|
   | `EXPO_PUBLIC_MOCK_LATENCY_MS` | delay on every request | 350 |
   | `EXPO_PUBLIC_MOCK_FAILURE_RATE` | 0–1 chance of a network error or 500 | 0 |
   | `EXPO_PUBLIC_MOCK_FORCE_ERROR` | `none`, `network`, `unauthorized` (401), `rate_limited` (429), `server` (500), `malformed` (broken JSON), `wrong_shape` (valid JSON, wrong fields), `lost_response`, `applied_late`, `forbidden` (403) (see below) | none |
   | `EXPO_PUBLIC_MOCK_FAIL_WRITES_ONLY` | `1` = forced errors hit only requests that change something; reads (and outcome checks) keep working | 0 |
   | `EXPO_PUBLIC_MOCK_QUOTE_TTL_S` | how long a quote is held | 30 |
   | `EXPO_PUBLIC_MOCK_OFFLINE` | `1` starts offline | 0 |
   | `EXPO_PUBLIC_EXPOSE_DEV_GLOBALS` | `1` exposes `globalThis.__GC_DEV__` in a production build | 0 |

3. **`globalThis.__GC_DEV__`** (dev builds, or with the variable above):
   `setControls({ forcedError: 'rate_limited' })`, `getControls()`, `resetControls()`,
   `resetSampleData()`.

`lost_response` is the important one for money: the mock **applies** the request and then
drops the connection, so the app sees a network error for something that happened. The
other modes fail before the request is processed, so they cannot exercise idempotency.
`applied_late` models a request that lands after the app gave up: a write fails at once
and is applied `lateApplyMs` (default 3 s) later; reads are unaffected. Turn on "Fail only
requests that change something" to keep outcome checks working while writes fail.

Mock state lasts for the JS session: a conversion moves balances, an approved payment
leaves the pending list and appears in activity. Reloading the page resets it.

## Architecture

```
src/                app (Expo)
  app/              expo-router routes only (thin files that export a screen)
  screens/          one component per screen (SignInScreen, ActivateScreen, ...)
  components/       UI kit, QrCode, Overlays (confirm dialog, authenticator-code dialog, toast)
  hooks/            queries.ts (all server state), useHeldQuote, useOutcomeCheck, useSingleFlight
  api/              SHARED WITH THE SERVER (imported by server/, never copied)
    types.ts        provider-NEUTRAL domain types
    provider.ts     ProviderClient: account data and money actions
    auth.ts         AuthClient: sign-in, activation, step-up
    schemas.ts      zod schemas of the neutral shapes (app validates responses, server validates requests)
    canonical.ts    canonical JSON, so "the same payload" hashes the same on both sides
    errors.ts       ProviderError: the only error type that leaves the API layer
    index.ts        THE one factory that picks the backend
    adapters/
      globalConnectApi.ts   ProviderClient + AuthClient over HTTP to the server
      demoBackend.ts        in-app demo: the client below + a stand-in sign-in
      currencycloud/        provider A: raw.ts (wire schemas), mapping.ts, client.ts,
                            transport.ts, mockServer.ts
  lib/              money, quote expiry, validation, confirmAction, inactivity, online
  state/            session, confirm dialog, step-up dialog, toast, devSettings
  config/           disclosures.ts (all placeholder wording), app.ts, env.ts
server/
  src/
    config.ts       environment -> settings; strict unless APP_ENV=development
    startup.ts      builds stores, providers and mailer; refuses unsafe combinations
    mailer.ts       Mailer interface; the development console outbox
    money.ts        amount check at the API boundary
    crypto.ts       scrypt passwords and recovery codes, TOTP (RFC 6238), base32, tokens
    auth/service.ts invitations, activation, login, sessions, step-up (clients)
    auth/lockout.ts progressive lockout, shared by client and staff sign-in
    payments/held.ts payments held for approval: create, approve, reject, cancel, expire,
                    send once and settle (see "Approvals")
    ops/            the ops console: auth.ts (staff accounts, sessions, password re-check),
                    console.ts (every /ops route and page, approvals), html.ts, static/
    store/          types.ts (repository interfaces incl. OpsStore, AuditLog and the atomic
                    operations), seed.ts (sample people, development only),
                    sqlite/ (the only place with SQL: db.ts, migrations.ts, tables.ts,
                    directory.ts, audit.ts, keys.ts)
    cli/db.ts       audit:verify, audit:checkpoint, audit:reseal, db:backup, db:rotate-key
    providers/
      adapter.ts          ProviderAdapter (= the app's ProviderClient + capabilities), registry
      currencycloud.ts    provider A: reuses src/api/adapters/currencycloud
      currencycloudMock.ts  MOCK platform: one instance, several accounts, scope enforced
      equals/             provider B: raw.ts, mockServer.ts, adapter.ts
    http/app.ts     the REST API, and the loopback-only operator listener
    cli/            invite.ts (npm run invite -- <email>), create-ops-admin.ts
  test/             node:test
scripts/demo.mjs    npm run demo
metro.config.js     leaves the in-app demo (and provider A's code) out of server builds
```

```
app ──HTTPS──> Global Connect server ──> directory: user -> company -> provider + account id
 (never sees      │  sign-in, 2FA, sessions, step-up        │
  a provider)     └──> ProviderAdapter for that company ────┴──> provider A API | provider B API
```

Rules the code follows:

- Screens never import an adapter or call the provider client. Every call goes through
  TanStack Query, in `src/hooks/queries.ts` or `src/hooks/useHeldQuote.ts` (quotes are
  fetched with `queryClient.fetchQuery`). That is what makes the next rule true.
- A 401 from any request made through those hooks ends the session, because the query
  and mutation caches share one error handler. A 403 does not: it is shown as "you do not
  have permission". Sign-out clears the query cache.
- Every response is parsed with zod in `client.ts`. Broken JSON or a wrong shape becomes
  `ProviderError('malformed_response')`, never a crash. A quote is also checked against
  what was asked for (currencies, fixed side, amount), and a booked conversion is compared
  with the quote the customer confirmed; a difference is shown as a warning.
- Raw provider error text is never shown. `ProviderError.userMessage` is our own wording.
- Requests time out after 20 seconds (`DEFAULT_REQUEST_TIMEOUT_MS`).
- Queries retry once for retryable errors. **Mutations never retry and are never queued
  offline.**

### Money-moving actions

Send payment, approve, reject, cancel and convert all follow the same rules:

1. **Single flight.** The button goes through `useSingleFlight` (a ref lock, so a second
   tap in the same frame is ignored).
2. **Explicit confirmation.** `confirmAction()` in `src/lib/confirmAction.ts` shows a
   confirm step that states the amount, payee and masked account. Nothing is sent before
   the customer presses the confirm button.
3. **Idempotency.** Creating a payment and booking a conversion send an idempotency key.
   The payment key is bound to payee + amount + currency + reference (what the server
   does with it is under "Approvals": "The payment key, on the server"). The conversion key
   is bound to the conversion *intent* (currencies, side, amount, type, date), not to the
   quote, so a re-quote of the same conversion reuses it.
   Approve, reject and cancel send **no** key. They are safe to repeat because a payment
   that is no longer waiting for approval cannot be approved, rejected or cancelled
   again, and the server sends an approved payment to the provider under one key of its
   own (see "Approvals").
4. **Recorded before sending.** For payments and conversions the idempotency key (with a
   signature of what is being sent, nothing else) is written to device storage *before*
   the request goes out (`src/lib/pendingOutcome.ts`) and removed only on a definite
   answer. If the app is closed or the screen left mid-request, the next visit finds the
   record, blocks a new attempt and reconciles first. The record is per user.
5. **Reconciliation over a processing window.** If the outcome is unknown (no response,
   timeout, 5xx, unreadable response) the form stays blocked and the app keeps asking the
   backend about the key (`findPaymentByIdempotencyKey`,
   `findConversionByIdempotencyKey`, or a re-read of the pending list for approve/reject)
   every `intervalMs` for `windowMs` (`outcomeCheckTiming` in `src/config/app.ts`,
   currently 5 s and 90 s: **placeholder values to confirm with the provider**). One
   early "not found" proves nothing, because the request may still be on its way. The
   form is released only by a "not found" that comes after the window, and the wording
   then says no record was found and to check before retrying; it never says no money
   moved. While checking, the screen says the outcome is being checked.
6. **Checked against what was confirmed.** Approve and reject re-read the payment
   immediately before the confirm step and stop if the amount, payee, bank details or
   status changed since the screen loaded. A created payment and a booked conversion are
   compared with what was sent; a difference is shown as a warning.
7. **Honest outcome.** The result screen follows the status the backend returned. It
   does not say "sent" for a payment that is waiting for approval, failed or of unknown
   status, and it says when further approvals are still needed.

**Second factor.** `confirmAction()` is still the single gate. After the review step it
asks for a 6-digit authenticator code for every action the session lists in
`stepUpActions` (see "Step-up" below). Single flight, idempotency keys, the pre-send
record and the outcome check are unchanged: the code is asked for before anything is
recorded or sent, and the idempotency key is chosen before the dialog so the code can be
bound to it. Adding a payee now goes through `confirmAction()` too. Whether this meets
the provider's and the regulator's definition of strong customer authentication has not
been assessed.

## Accounts, sign-in and step-up (server)

### Accounts are invite-only

There is no sign-up endpoint. Operations add the person to the directory (users,
companies, memberships with a role: `creator`, `approver` or `admin`) from the ops
console, where a second staff member has to approve it, and an activation link is
emailed to the address on file (the seed file provides the sample people):

1. `POST /v1/activation/start {activationCode}` → email, name, password policy.
2. `POST /v1/activation/password {activationCode, password}` → policy check (12+
   characters, not on a short common-password list), scrypt hash held with the
   invitation, a new TOTP key returned as `otpauth://` URI and base32 text.
3. `POST /v1/activation/confirm {activationCode, code}` → needs a correct code from the
   authenticator; only then are password and key written to the user, the invitation is
   deleted and 10 one-time recovery codes are returned.

Activation codes are random (100 bits), stored hashed, expire after 72 hours and are
replaced by a newer invitation. Unknown, expired, used, replaced and disabled-account
codes get the same answer. The link is `<app>/activate#code=…`: the code is in the
fragment, which a browser does not send to a server, and the app removes it from the
address bar once read. A step that was already in progress on an old link when a new one
was issued cannot complete or bring the old invitation back (the write is conditional on
the invitation still being the same one).

- **Passwords**: scrypt, N=2^17, r=8, p=1 (about 128 MiB per hash). A hash made with a
  lower cost is replaced at the next successful sign-in. Hashing is rationed in three
  separate pools so that the cheapest work to abuse cannot crowd out real people:
  *client* (2 at once, 32 waiting) for real, usable client accounts, whose attempts the
  lockout bounds; *staff* (1 at once, 16 waiting), which client traffic cannot touch;
  and *decoy* (1 at once, 2 waiting) for sign-in attempts on emails with no usable
  account. When the decoy pool is busy such an attempt is answered after a wait of about
  one hash instead of a hash, and is never refused. **The trade-off:** the answer is
  identical either way, and off-peak the timing is too (a real hash). During a flood,
  though, the wait follows the recent average while a real account's hash may be
  queued behind others, so someone who floods *and* times responses could tell known
  emails from unknown ones. That was chosen over letting anyone starve real sign-ins
  with made-up emails. A full client or staff queue answers 429.
- **Recovery codes**: 100 random bits each, stored salted and scrypt-hashed.

### Login

1. `POST /v1/auth/login {email, password}` → `{challengeId}`. Unknown email, wrong
   password, not-yet-activated account and disabled account return the same body and
   status and each cost one scrypt verification (a dummy hash is checked when there is
   no account).
2. `POST /v1/auth/login/verify {challengeId, code, method: totp|recovery}` → an opaque
   session token (256 random bits; only its SHA-256 is stored), the user, their
   companies and, if there is exactly one company, the session. Otherwise
   `POST /v1/session/company {companyId}` selects one (only a company the person
   belongs to; anything else is `not_found`).

- **TOTP**: RFC 6238, SHA-1, 30 s, 6 digits (tested against the RFC vectors). The current
  step ±1 is accepted. The newest accepted step is stored per user and any code at or
  before it is refused, so a code cannot be replayed, including across login and
  step-up. Because the next step is accepted early, a client whose clock runs ahead
  burns it: the refusal (`code_reused`) carries the seconds until the authenticator
  shows its next code, and a reused code does **not** count toward a lockout.
- **Lockout**: each attempt is counted *before* the credential is checked, in one atomic
  store operation, so simultaneous requests get exactly the allowed number of checks
  (and of hashes). Counters are kept per **account and source** (an IPv4 address, or a
  whole IPv6 /64): 5 failures from one source against one account lock that source out
  of that account for 1 minute. A lock that has run out starts the count again: the
  next lock needs five **new** failures and is then twice as long, up to 1 hour, so one
  guess per expiry neither renews a lock nor lengthens it. A second counter per account
  across **all** sources locks it at 50 failures, but **not for a network (IPv4 /24,
  IPv6 /64) the account has completed a full sign-in from before** (the last eight are
  kept on the account): the owner, where they usually are, is not locked out by
  strangers elsewhere. Password, sign-in code, step-up code and activation are counted
  separately, so wrong step-up codes in a stolen session cannot lock sign-in. Whether
  the account exists plays no part; success clears the counts. A challenge is spent
  after 5 wrong codes or 5 minutes. A live lock is never evicted to make room for other
  counters. Limits of this: an attacker on the owner's own network still locks that
  network out for a while; an owner signing in from somewhere new during an attack is
  locked out with everyone else; "has signed in from here before" is a network address,
  not a device, so it is only as good as the address. Ops can unlock a client; a staff
  member is unlocked by a second ops admin's approval or by break-glass.
- **Rate limits**: each source (an IPv4 address or an IPv6 /64) gets 30 requests a
  minute on the sign-in, activation and step-up routes and the ops console's sign-in
  pages and actions, and each IPv4 /24 gets 90 between its addresses. A signed-in
  client gets 60 state-changing requests a minute, counted per person and per session
  (sign-out is exempt), which is also what bounds how fast one session can write audit
  entries. "Address" is the connection's address, or, behind a reverse proxy, what
  `TRUST_PROXY` says: the proxies' own addresses or CIDR ranges (preferred) or a number
  of hops, at most 3. `true` is not accepted, so a client cannot pick its own address
  by sending `X-Forwarded-For`. A hop count is only right when the server cannot be
  reached except through that many proxies. When a limiter is tracking its maximum
  number of keys it refuses new ones until a window ends; it never resets anyone's
  count. All of these are per process and in memory: the limiter's windows are the one
  piece of security state that is NOT in the database, so a restart resets them (lockout
  counters, which are in the database, are not reset).
- **Sessions**: 15 minutes idle, 12 hours absolute, revoked by `POST /v1/auth/logout`.
  Membership is re-read on every request. "Last seen" is written at most once a minute
  per session (each write is a flushed commit), so a session can end up to a minute
  *early* after its last request, never late. Reads are limited per session
  (600 a minute). A person's authenticator key is decrypted only where a code is
  actually checked, not whenever the person is loaded.
- **Atomic state changes**: an invitation, a TOTP step, a recovery code, a sign-in
  challenge, a step-up permission and a session are each changed through the store's
  atomic operations (`Table.mutate`, `Table.take`, `Directory.updateUser`), never
  read-then-write. In the SQLite store each is one transaction that takes the write
  lock before it reads (`BEGIN IMMEDIATE`) or a single `DELETE ... RETURNING`. A test
  runs them from three processes at once against one file; that shows the store's
  transactions hold under real contention (the maintenance commands do open the
  database beside a running server). It is **not** a claim that several servers can
  share a database: exactly one server process may, and it takes a lock to make sure
  (see "Database").
- **A change and its audit entry are one transaction** wherever both are in the
  database: a held payment's creation and every decision on it, an approval request's
  decision and its completion, a company's edit. If the entry cannot be written the
  change is not made. Where a provider or the mail is involved that cannot be so, and
  the order is: record the intent, act, record the outcome.
- **Logging**: method, path and status only. Query strings, bodies and headers are never
  logged. Activation codes travel in the link's fragment, not the path or query. (A
  search typed into the ops console is a query string: it reaches the server but not
  the log.)

### Forgotten password, and your own security settings

**Email alone is never enough.** A password can be reset by its owner, but only with
**both** the emailed link **and** a second factor:

1. "Forgot your password?" on the sign-in screen: enter an email address. The answer is
   always the same, after the same work as a sign-in attempt, and it is given before
   anything else is done, so it says nothing about whether the address has an account.
2. If the account exists, is activated and is enabled, a link is emailed to it:
   single-use, valid 30 minutes, with its code in the URL fragment (as for activation,
   so it is in no request log). A new link kills the old one. At most 3 links an hour
   per account; each source is limited like any sign-in route.
3. The page the link opens asks for a **current code from the authenticator app, or an
   unused recovery code**, and the new password (same policy as activation). Wrong
   codes count toward the same lock as wrong sign-in codes, and five of them withdraw
   the link.
4. On success: **only the password changes**. The authenticator and the recovery codes
   are never touched by a reset. Every session is ended, the owner is emailed a notice,
   and it is audited (`client.password_reset`).

**Lost the authenticator AND the recovery codes: there is no self-service path.** The
app says so and tells the person to contact Global Connect (the wording of how is a
placeholder, `disclosures.contactSupport`). Staff then use the two-person authenticator
reset, which now waits out a delay (see "Resetting an authenticator").

**Signed in**, under Settings, "Security": change the password (current password **and**
a code; every other session is signed out), make new recovery codes (a code; the old
ones stop working; shown once), and see and end your own sessions. A session is shown
as a kind of device ("Chrome on Windows", worked out from what the browser or app said
about itself when it signed in and stored only as that family) and times rounded to
the quarter hour: no network address, no token, no exact time.

**Staff** have the same password reset on the console's sign-in page (`/ops/forgot`):
link plus authenticator or recovery code, only the password changes. A lost
authenticator is not self-service for staff either.

**Security notices by email.** Password changed or reset, recovery codes regenerated,
a session ended from the security settings, a sign-in from a network the account has
not been used from before, the account locked, the account disabled or re-enabled, an
authenticator reset approved, cancelled or completed. A notice tells; it never asks:
**no link, no code**. One person gets at most one notice of each kind per window (an
hour for "locked" and "new network", which an attacker hammering sign-in could
otherwise multiply; five minutes for the rest), on top of the outbox's own limit per
address. They cannot be switched off. "New network" means a /24 (IPv4) or /64 (IPv6)
the account has not completed a sign-in from before, out of the last eight remembered:
it is only as good as the address.

**In the in-app demo** (no server) none of this exists: there are no accounts to
recover, and the screens say so.

### Step-up on money actions

Creating a payment, approving, rejecting, cancelling and adding a payee need a fresh code. Booking a
conversion between the client's own balances does not, unless `STEP_UP_CONVERSIONS=1`.

1. `POST /v1/step-up {action, payload, code}` → a one-time token valid for 2 minutes,
   stored hashed with the user, the session, the action and SHA-256 of the canonical
   JSON of the payload.
2. The action request carries it in `X-Step-Up-Token`. The server recomputes the hash
   from what was actually sent (body plus idempotency key, or the payment id) and
   refuses a missing (`step_up_required`), expired, reused, other-session, other-action
   or other-payload token (`step_up_invalid`). A token is destroyed the first time it is
   presented, whether or not it fits.

In the app, `confirmAction()` shows the review, then the code dialog; wrong, reused and
locked-out codes keep the dialog open with a plain message, and the API client attaches
the token only to the request whose payload matches exactly.

With `STEP_UP_CONVERSIONS=1` the code has to be typed while the quote is still held
(30 s on provider A's mock, 12 s on provider B's), which is tight. That is why it is off.

### Approvals

Payment approvals are enforced **by the Global Connect server**, the same way for every
provider. The provider's own approval feature is not used for payments created through
the server.

**The rule.** Each company has `approvalsRequired`: 0, 1 or 2. A new company gets 1, and
so do the two demo companies. It is changed in the ops console (company page, "Payment
approvals") as a request that an **ops admin** must approve; the change is audited.
**A stricter rule applies at once**, to payments already waiting as well as to new ones:
a waiting payment needs the larger of the rule it was created under and the rule in
force when it is approved. **A looser rule applies only to payments created from then
on**: lowering the rule (or switching it off) never releases a payment that is waiting.
The request and its confirmation page say which of the two it is.

**Creating.** A `creator` or `admin` creates a payment with a fresh code, as before.
With a rule of 0 it goes to the provider at once, exactly as it always did. With 1 or 2
the server **holds** it as "waiting for approval" and sends nothing to the provider.
**No money is reserved**: the balance is not touched and is only checked when the
payment is about to be sent, so a held payment can later fail for lack of funds. The
payee's details as shown to people are copied into the held payment at that moment,
together with a **digest** of the payee: a SHA-256 hash of everything the
provider holds about them, taken over the provider's raw record (every routing code of
every kind, account number, IBAN, BIC, holder, bank, country, currency, payment types,
addresses, and any field this code has never heard of), leaving out only the provider's
own created/updated timestamps. Spacing and empty values are normalised; letter case
and digits are not.

**Approving.** An `approver` or `admin` approves with a fresh code. **The creator can
never approve their own payment**, whatever their role. With 2 required, two different
people must approve, neither of them the creator. Each approval is recorded with who and
when. **Every** approval, not only the one that turns out to be the last, checks:

- the payment is still waiting and has not expired;
- the payee still exists at the provider and the digest of the provider's record is
  **the same** as the one taken at creation; if not, the approval is refused and the
  payment is closed as "payee changed" for good (create it again). This is a comparison
  of digests of the provider's record, not a judgement about which fields matter: a
  change the provider makes to a payee for its own reasons (a new status, a counter, a
  nested timestamp it starts returning) also blocks the payment, on purpose. Two things
  keep that manageable. The audit entry for the refusal (`system.payment.blocked`)
  **names the fields that differ** (names only, never values; staff see it in the
  console, the client app does not), so a false refusal can be told from a changed
  destination. And the fields left out of the digest are an **explicit list per
  provider adapter** (`PAYEE_DIGEST_IGNORED` in each adapter: only the created/updated
  timestamps), which an operator can extend by name with
  `PAYEE_DIGEST_IGNORE_CURRENCYCLOUD` / `PAYEE_DIGEST_IGNORE_EQUALS` (comma-separated;
  `a.b` for a field inside another). Leaving a field out is a decision about where
  money may go: nothing is ignored by default beyond those timestamps;
- the creator is still an enabled member of the company with a role that allows
  creating, and the approver one with a role that allows approving;
- **every earlier approver** is still enabled, still a member and still allowed to
  approve. An earlier approval whose giver no longer is, is dropped: it stops counting,
  the payment needs another approval, and the audit log records which approval was
  dropped and why (`system.payment.approval_dropped`);
- the provider reports the balance. Not enough money refuses the approval that would
  have sent the payment, and only that one.

The payment, its company, the creator, the approver and every earlier approver are read
and the new state is written **in one database transaction**, together with the audit
entries for it. The payee and the balance are the provider's, so they are checked
immediately before that transaction, by the same request: a payment only ever moves to
`sending` through a request that itself ran both checks, and the transaction refuses if
the payee digest or the company's provider account is no longer the one that
request checked. (Two approvals arriving together therefore each run the checks; the
window that remains is a change at the provider in the instant between a request's check
and its commit, which no server-side check can close.)

**Sending exactly once.** In that transaction the payment moves to `sending` and gets an
idempotency key derived from the held payment's id. The provider is then asked to make
the payment with that key. If the answer is lost, the server crashes, or the request is
retried, the payment stays `sending` and is **settled by that key before anything else
can happen to it**: the server looks the key up at the provider; if the payment is
there, it is marked sent; if not, the provider is asked again **with the same key**.
The server never asks under a second key, and it settles against the provider account
that was recorded on the payment when it moved to `sending`, not whatever the company
points at later (and a company cannot be re-pointed while one of its payments is
`sending`). Whether that makes "exactly once" true is **the provider's** doing, not
the server's: it holds only if the provider honours the idempotency key for as long as
a send can stay unsettled, and finds a payment by that key. Both mocks do; it has to be
confirmed with each real provider, and until it is, "sent once" is a claim about the
mocks. This runs at start-up (before the server takes requests; every unsettled send,
since no other process can be in the middle of one) and once a minute. When someone
tries to act on a payment that is `sending`, the server only **looks it up** under its
key; it asks the provider again only when the last attempt is more than 30 seconds old
and none is under way in this process, so a decision never fires a second request
beside the first.

**Every attempt is written down before it is made**, with its outcome afterwards
(`attempts` on the payment; the last 20). A plain refusal by the provider (not enough
money, details not accepted) is **final only when it answers the first and only
attempt**: then the payment is failed and not retried. Once any attempt has gone
unanswered (lost, timed out, or cut off by a crash), that attempt may still reach the
provider, so a later refusal proves nothing and the payment is **not** called failed.
It stays `sending`, the creator and the approvers see "Outcome being checked: do not
create it again", and from then on the server only looks it up by key, never asks
again. If the provider turns out to have it, it is marked sent. Only after
`PAYMENT_RECONCILE_HOURS` (default 72) of looking without finding it is it marked
failed, with a note saying so. While it is being checked the company cannot be
re-pointed. Limits: a request that reaches the provider later than the window would
still be missed, and a provider that cannot find a payment by key defeats all of it.

When the provider's answer comes back, its amount, currency and payee are compared with
what was approved. A difference does not undo anything (the payment has been made), but
it is flagged: an audit entry `system.payment.send_mismatch`, and the app shows the
payment as "Sent, but not as approved: contact support" instead of as an ordinary sent
payment.

**The payment key, on the server.** The app sends an idempotency key with each new
payment. On the server it means: *this key, from this person, with this request, is one
payment*. The server stores a hash of the request (payee, amount, currency, reference,
reason) and who made it. The same key from the same person with the same request
returns the original payment and creates nothing. The same key with anything different,
or from another member of the company, is refused as a validation error that says
nothing about the payment the key belongs to. That holds for held payments and for
payments sent straight to the provider alike: a direct send is **recorded on the server
by its key, creator and request hash before the provider is asked**, and one key can
never be both a direct send and a held payment (one database transaction decides). So
a rule changed between two attempts cannot turn one request into two payments, even
while the first attempt is still unanswered: if a direct send's outcome is not known
and the company now has a rule, the retry is answered "outcome not known yet" (a
timeout, which the app reconciles by key) until the provider shows the payment; it is
neither held as a second payment nor sent past the rule. A direct send the provider
plainly refused, with nothing unanswered before it, made nothing, and under a rule its
key is spent. Limits: payments sent directly by an earlier version of this server left
no such record; for those the provider is still asked by key and the request compared
with what it returns (amount, currency, payee, reference), and who made them is not
known. Amounts have one spelling: a leading zero ("01.50") is refused.

**Reject, cancel, expire.** An `approver` or `admin` can reject (optionally with a
reason, through the API; the app does not ask for one). The creator, or a company
`admin`, can cancel while it is still waiting. Both need a fresh code and both are
final. A held payment **cannot be edited**; cancel it and create another. A payment that
has not been fully approved **48 hours after it was created** expires and is not sent;
that is the product owner's decision, set by `PAYMENT_APPROVAL_HOURS` (default 48). The
expiry is enforced when someone tries to approve and by a sweep once a minute, and the
expiry time is shown to the creator and the approvers.

**No silent deadlock.** If the only person who can approve is the creator, the payment
would wait and expire. The create response lists who can approve (`held.approvers`); the
app tells the creator "nobody else on this account can approve payments yet" when the
list is empty (or shorter than the number needed), and the ops console warns on the
company page, in the company list and on a rule-change request when a company does not
have enough active approvers for its rule. Only activated, enabled people count.

**What people see.** The creator sees "Waiting for approval", who can approve, when it
expires, and can cancel; they are not offered Approve. An approver sees who created it,
the payee's bank details masked, and the approvals so far. Payments that were already
pending at the provider (the seeded sample on provider A) remain in the list and can be
approved or rejected there as before; the API marks them `external` and the app says
they are not held by Global Connect. For those the server applies the same role rule
(approver or admin, with a fresh code) and records who approved or rejected, marked
`external` in the audit log. It does **not** apply its own creator-cannot-approve rule,
approver re-validation, payee digest or expiry to them: it never held them and
does not know who created them; whatever the provider's own approval rules are is all
that applies.

**API.** `POST /v1/payments` (held → `status: "awaiting_approval"` and a `held` object),
`GET /v1/approvals`, `POST /v1/payments/:id/approve|reject|cancel` (each with a
step-up token bound to the payment id), `GET /v1/payments/by-key/:key` (finds the held
payment, or the provider's payment once it has been sent). `capabilities.paymentApprovals`
is true for every company with a rule of 1 or 2.

**Limits to know about.** The mocks keep their data in memory, so after a server restart
a payee you added in the demo no longer exists at the "provider", and a held payment to
it is (correctly) blocked as "payee changed" when someone approves it; use the seeded
payees on provider A to see a held payment survive a restart and go through. Listing
who can approve reads every membership; fine at this size. Approvers are told about a
waiting payment in the app and by email (see "Rate alerts and notifications"); there is
no push notification.

### Client rates and Global Connect's margin

A client only ever sees **their own rate**: what they get after Global Connect's
margin. **What is and is not disclosed, precisely:** no API response or error message
has a field or wording that names the provider's rate, a mid-market rate, the margin or
what Global Connect earns. But a client is shown a rate for selling **and** a rate for
buying, and from any two-way price anyone can estimate a midpoint and a spread; that is
not hidden and cannot be while both directions are shown. **The margin is not a
secret from a client who looks for it:** two held quotes for the same pair, one each
way, are given at full precision and together give the provider's rate and the margin
**exactly** (sell 1.295190 and buy 1.304810 are 37 basis points around 1.300000). That
is inherent in quoting both ways and is not hidden. All the server does is not hand it
over unasked on the rate page: indicative rates are given only to the precision the
app displays (five significant figures), each rounded against the client by itself.
The code is `server/src/rates/margin.ts`
(the arithmetic) and `server/src/rates/service.ts` (everything a client is told about a
rate, a quote or a conversion passes through it).

**How the client's rate is worked out.** A rate is "how many units of the quote
currency one unit of the base currency is worth". With a margin of *m* basis points
(1 bp = 0.01%):

| The client... | Client rate | So they... |
| --- | --- | --- |
| **sells** the base currency | provider rate x (1 - m) | receive fewer units of the quote currency |
| **buys** the base currency | provider rate x (1 + m) | pay more units of the quote currency |

The margin works against the client in both directions. All arithmetic is decimal
(big.js), never floating point.

**Rounding never favours the client by accident**, and it is the same for the
indicative rate, the held quote and the booked conversion because all three come from
the same two functions:

- a client rate is kept to **7 significant figures** (1.293500, 195.0325, 0.005102563),
  rounded **down** when the client sells the base currency and **up** when they buy it.
  Significant figures, not a fixed number of decimal places, so that rounding moves a
  rate by less than one part in a million whatever its size (at six fixed places a rate
  of 0.005 could lose 2 bp to rounding alone: a hidden margin);
- the margin **really applied after rounding** (of the rate and of the amount) is worked
  out and kept with the revenue record (`effectiveBps`), next to the configured one;
- the amount on the side the client typed stays exactly what they typed; the other
  amount is worked out at the client rate and rounded **down** to the currency's minor
  unit if the client receives it, **up** if they pay it;
- whatever the arithmetic says, the client's amounts are never better than the
  provider's own quote (they are clamped to it);
- an amount so small that the client would receive nothing is refused, not taken.

A conversion is booked on exactly the amounts of the held quote; the server keeps its
own record of those amounts and answers from that record, so what the client is shown
for a conversion is the same when it is booked, when it is looked up again and in the
list of forward contracts.

**Which margin applies** to a trade, in this order: for a forward contract, the
company's forward margin if one is set; otherwise an override for that currency pair
and direction; otherwise the tier for the amount (larger amounts, smaller margin);
otherwise the company's default. A company with no configuration of its own uses
`DEFAULT_MARGIN_BPS`. An override is written for a pair and a direction (`GBPUSD
sell 40`: 40 bp when the client sells GBP for USD) and also covers the same trade
spelled the other way round (buying the first currency of `USDGBP`): inside the server
every pair has ONE orientation (the market's usual order), whatever a provider's
adapter calls the base. **Tier amounts are in ONE currency per company** (`tierCurrency`,
default GBP, set with the margin and shown in the console): the size of a trade is
converted to it at the provider's rate before a tier is chosen, so 60,000 yen is not
priced as 60,000 pounds, on either provider and in either direction. If the size
cannot be converted (the provider has no rate for it), no tier applies, which is never
to the client's advantage. The indicative rate is for no particular amount, so no tier
applies to it: a tier can only make a held quote better than the indicative rate,
never worse. A forward with its own margin can be
priced differently from the indicative (spot) rate.

**What the app receives.** `GET /v1/rates/:base/:quote` returns `rate` (the client's
rate when they sell the base currency), `buyRate` (when they buy it), `indicative:
true` and `asOf`. **Indicative rates are at the app's display precision** (five
significant figures: 1.2934, 195.03, 0.76535), each rounded against the client, and if
the two roundings together moved the figures by less than a quarter of a display step
the sell figure is shown one step lower: an indicative rate is never better than a
quote, and the spread between the two figures is never the margin to six places. The
app shows them exactly as given. The rate history is the client's indicative sell rate
at each point. A quote and a conversion carry the client's rate **in full** (for that
amount and direction) and amounts and the "held until" time. Nothing else. The Rates screen shows both directions for each pair ("Sell GBP" / "Buy GBP"),
labelled "Your rate · Indicative"; each opens Convert set up for that trade, and
Convert gets its held quote from the same code, so the two agree apart from market
movement. The Home total is a valuation, not an offer: other currencies are valued at
the rate the client would sell them at, and it says "estimated at your current sell
rates". (A two-way price lets anyone estimate the midpoint between the two; that is
true of any buy/sell price and is not hidden. Two held quotes, one each way, give the
client's two rates in full, and from those the provider's rate and the margin exactly.)

**A quote is checked by this server when it is booked**, not left to the provider: it
must be the quote this server gave **this person** in **this company**, not past its
"held until" time, **not used by any other booking**, and priced by the margin
configuration **still in force** (a quote taken before a margin change cannot be booked
after it: the app is told the quote has expired and gets a new one). One idempotency
key is one booking of one quote: the same key and quote again is answered from the
conversion that was made (looked up by its key, never booked twice); the same key
with a different quote is refused. Errors name the neutral API's fields only: a
provider's parameter names are translated or dropped, and the response scan fails on
any that get through.

**Tests scan every client response.** The server test harness checks every reply the
client API gives, in every test, for a field or wording that speaks of a mid rate, a
margin, a markup, a spread, basis points, wholesale or partner figures, provider
amounts or revenue, or a provider's parameter name in an error
(`forbiddenInClientResponse` in `server/test/helpers.ts`), and fails the test that
caused it. It also fails if one reply's **indicative** sell and buy rate have a spread
that is exactly a margin in force, to six places (`marginReadableFrom`). **Neither scan
shows the margin is secret, and it is not** (above): they show that no field names it
and that the rate page does not print it; a test states that two opposite held quotes
give it exactly.

**Where the margin is applied: a setting per provider.**

| `MARGIN_APPLIED_BY_CURRENCYCLOUD` / `MARGIN_APPLIED_BY_EQUALS` | Meaning |
| --- | --- |
| `server` (default; what both mocks use) | This server works out the client's rate as above and sends the client's side of the trade to the provider when it books. |
| `provider` | The provider already returns the client's rate, with Global Connect's markup configured on the provider's side. The server adds **nothing** on top (that would charge the client twice), passes the provider's figures through, and does not know the revenue. A company's margin configuration is stored but not used. |

These names are server configuration; no client sees them.

**A wrong setting fails safe.** Provider A's quotes say whether they carry a partner
markup (its client figures differ from its own). That is checked against the setting
on **every quote**: `provider` with no markup there (the client would be shown and
given the wholesale rate) and `server` with a markup there (the client would be charged
twice) both **refuse to quote**, with the reason in the server log. With `provider`,
an indicative rate is passed on only after one real quote has shown the markup is
there (checked again every ten minutes). Provider B's quotes do not say, so
`MARGIN_APPLIED_BY_EQUALS=provider` is **refused at start-up**: the server could not
tell a marked-up rate from the wholesale one.

**Changing a company's margin (ops console).** Any staff member can see a company's
margin on its page. Changing it is a request that a **second staff member who is an ops
admin** approves, typing their password again; the confirmation and the request show a
**worked example** at the provider's rate at that moment ("selling GBP 10,000 for USD:
the client rate changes from 1.293500 to 1.294800, so they receive USD 12948.00 instead
of USD 12935.00", the same for buying, for the largest tier, for a forward and for up
to three overridden pairs). A negative margin is never accepted; one above 300 bp (3%)
only when the request ticks "allow a margin this high", and the approver is warned;
above 2000 bp never. The change is written to the audit log with the old and the new
configuration and both people. It applies to quotes given from then on; a quote a
client is already holding from before the change **cannot be booked** (the app is told
it has expired and asks for a new one, at the new margin), and the approver is told so
on the confirmation page.

**Revenue (ops admins only).** When a conversion is booked the server records, before
it asks the provider, the provider's rate and amounts, the client's rate and amounts,
the margin applied and the resulting revenue: the difference between the two, in the
currency it arises in (the side the client did not fix). It is not converted into one
currency. `/ops/revenue` lists conversions with these figures, with totals by company
and month, filters for company and dates, and a CSV download (cells a spreadsheet
would run as a formula are written as text; each download is in the audit log). Only
ops admins can open it; no client API serves any of it. A booking whose answer from the
provider was lost stays on the list as "not confirmed by the provider" until the
conversion is found again by its key. A conversion the provider booked without the
client's terms is **not counted** in the totals and is listed by itself.

**What is not settled, and must be before real use:**

- *How the margin is collected from a real provider is not verified.* With `server`,
  provider A's adapter sends the client's side of the trade as `client_buy_amount` and
  `client_sell_amount` when it books. We believe those parameters exist but have not
  confirmed them, or how the difference reaches Global Connect, against the provider.
  Provider B's public API has no such thing: the adapter sends an **invented**
  `clientAmounts` field that only the mock understands. Either may turn out to need
  `provider` instead.
- If a provider books a conversion **without** the client's terms it was sent, the
  client is shown **what was really booked** (that is what moved on their account),
  flagged as differing from the quote, with wording from a placeholder
  (`disclosures.conversionDiffers`) telling them to get in touch, and is notified in the
  app and by email. The revenue row is **left out of the totals** and listed
  separately on the Revenue page with what was quoted and what was booked; it is
  audited (`system.conversion.mismatch`) and logged. In that case the client sees the
  provider's own rate for that trade: that is what happened to their money. Nothing
  puts it right automatically.
- Held quotes are kept in the database, so a restart of this server does not lose
  them. (The **mock** providers keep their own quotes in memory, so in the demo a quote
  taken before a restart is refused by the mock afterwards and the app asks for a new
  rate; a real provider would still know it.)
- The default margin in development (50 bp) is a **sample**, not Global Connect's
  pricing. Outside development `DEFAULT_MARGIN_BPS` has no default and the server will
  not start without it.
- **The mock rates move.** In `npm run demo` both mock providers move their sample
  rates as a deterministic random walk, seeded per pair: every 20 seconds a rate moves
  by one basis point or stays, wandering around the sample rate (never more than
  1.28% from it). It is the same on every machine and after a restart, and it is not
  market data. `MOCK_MOVING_RATES=0` turns it off. The in-app demo (no server) keeps
  fixed sample rates and has no margin: it shows one rate for both directions.

### Rate alerts and notifications

**Rate alerts are kept and checked by the server** (`server/src/alerts/service.ts`).
An alert says "tell me when I can **sell** (or **buy**) the first currency of this pair
at this rate **or better**". It belongs to one person in one company and is checked
against **that company's client rate** (the provider's rate with the company's margin):
the same indicative rate the person sees on the Rates screen, never the provider's own
rate. Selling fires when the client's sell rate is at or above the target; buying when
their buy rate is at or below it.

- Checked every `ALERT_CHECK_SECONDS` (default 60). One rate is fetched per provider
  and pair for each check, however many companies and alerts want it; the margin is
  then applied per company.
- **An alert fires once.** It is then shown as reached and stays off until its owner
  turns it on again in the app. It cannot fire twice across a crash or a restart: the
  notification is made first, under a key of the alert and its current arming (a
  notification with a key that exists is not made again), and only then is the alert
  marked as fired. A crash in between repeats the first step, which does nothing.
- At most `ALERTS_PER_USER` (default 20) per person. A pair the company's provider has
  no rate for is refused. Only the owner can see, pause, re-arm or delete an alert.
- What it says: the pair, the direction, the client's rate that was reached and when,
  that the rate is **indicative** and not held, and that converting means getting a
  rate in the app. It promises nothing.
- If a person is disabled or leaves the company, their alert is kept but not checked.
  An alert is marked as fired **only when its notification exists**: if the notification
  was held back (the hourly limit below) or could not be made, the alert stays on and
  is tried again at the next check.
- The app keeps its `AlertsStore` interface. Against the server it uses a
  server-backed implementation (the app's "at or above" is selling, "at or below" is
  buying); the in-app demo keeps alerts on the device, where nothing checks them.

**Notifications** (`server/src/notify/notifier.ts`) have two channels:

| Channel | What it is |
| --- | --- |
| In the app | A list kept on the server, opened from the bell on Home, with an unread count. Tap one to mark it read, or mark all. Always on. |
| Email | Through the mail queue (see "Email"): written to the outbox first and retried. One event is QUEUED once; delivery is at least once (in one failure case, described under "Email", the same message can arrive twice). Can be turned off per kind. |

**Push is not built.** `PushChannel` in `notifier.ts` is the interface a push sender
would implement (it is given the person and the words); nothing implements it, no
device token is stored and the app does not ask for notification permission. Building
it needs Expo push (or APNs and FCM) credentials, a table of device tokens with their
own consent and sign-out handling, and a decision about what may appear on a lock
screen.

**Who is told what:**

| Event | Who | Says |
| --- | --- | --- |
| A rate alert is reached | its owner | pair, direction, the rate reached, indicative |
| A payment is waiting for approval | every active approver or administrator of the company except its creator and anyone who already approved | amount, currency, payee **name**, who created it, when it expires |
| A waiting payment is about to expire (`PAYMENT_EXPIRY_WARNING_HOURS` before, default 6) | the same people, and its creator | the same |
| Approved (being sent) / sent for processing | its creator | amount and payee name |
| Rejected | its creator | who rejected it, and the reason they gave |
| Cancelled by someone else / expired / stopped because the payee changed | its creator | that it was not sent |
| Needs attention: not sent; outcome being checked ("do not create it again"); sent but not as approved | its creator | what is known |

No notification contains bank details. A payment sent straight to the provider (a
company with no approval rule) makes no notification: its creator sees the result at
once.

**How they are produced.** The payment code is not hooked. After every payment action,
and once a minute, the server looks at the held payments as they are and works out
which notifications are due (`server/src/notify/payments.ts`); each is made under a key
of the payment, the event and the person, **once**, so looking again after a restart,
or twice at once, sends nothing twice. A payment that closed more than 24 hours ago is
not news.

**Preferences.** Each person chooses, in the app, whether rate alerts, payments to
approve and news of their own payments are **also emailed**. The in-app list is always
on. **Security notices cannot be turned off** and are not part of these choices (the
API refuses a request that tries). A change is in the audit log.

**Limits.** One person is sent at most `NOTIFICATIONS_PER_USER_PER_HOUR` (default 60);
beyond that an event is held back and recorded once in the audit log (a payment still
waiting is notified later, when the scan next looks). The mail queue has its own limits
per address and overall.

**The reason for a rejection.** An approver may type a reason (optional, at most 200
characters, no control characters or line breaks; the server refuses them). The creator
sees it in the notification and on the payment. It is another person's free text and is
treated as such everywhere. One function (`plainText` in `server/src/validate.ts`) is
applied to every piece of typed text that goes into a notification, an email or the
payment's own "rejected by" line: it is put on one line and anything a mail client or
an app would turn into a link is **visibly broken**, not silently removed
(`https://pay.example` becomes `https[:]//pay[.]example`, `www.pay.example` becomes
`www[.]pay[.]example`, `a@pay.example` becomes `a[@]pay[.]example`), repeated until
nothing changes so that nesting one scheme inside another cannot put a working link
back together. It is escaped in the HTML part of an email and shown in the app as
plain text with link detection off. The audit log stores what was typed as data, and
the ops console escapes everything it prints. The notification's email is written to
the outbox **before** the notification is recorded as made, so nothing that goes
wrong afterwards can lose it; an email that cannot be written out at all is recorded
as failed, audited and shown on the Mail page, never swallowed.

**The audit log** records alert create / pause / re-arm / delete / fired (pair,
direction, target, rate), each notification (who, which kind, whether email was queued:
never what it said) and preference changes. The body of a notification is stored
encrypted and is deleted after 30 days once read (60 if unread).

**Ops console.** A client user's page shows their notification state: how many are
kept and unread, their email choices and how many alerts are on, fired or paused. Not
what any of them says, and there is no console action that reads, sends or changes
them.

### Provider routing and isolation

- The session holds a company id. Every data route resolves the adapter from **that**
  company's directory entry (`ProviderRegistry.forCompany`). No route reads a company,
  account or provider id from the request; a test passes them and shows they do nothing.
- Each adapter instance is built for one company and puts that company's scope on
  **every** call it makes: `on_behalf_of` (the company's contact id) for provider A,
  `accountId` for provider B. A company without that scope gets no adapter and no call
  is made (fails closed).
- The server does not rely on the provider refusing somebody else's id. Before it pays
  a payee, or approves or rejects a payment, it checks that the id is among the session
  company's own records, read through that company's scope; a conversion can only use a
  quote this server issued to that company.
- The mocks are one instance per provider holding several accounts, and refuse a call
  without a known scope. The isolation tests run them in a mode where, given an id, they
  act on it whichever account it belongs to, so those tests prove the server's checks
  and not the mock's separation. **This is still only tested against mocks.** Whether
  the real providers enforce `on_behalf_of` / `accountId` as assumed is unverified.
- Amounts are decimal strings from the request to the provider. At the API boundary an
  amount must be positive and have no more decimal places than its currency; anything
  else is refused, so nothing is rounded. Provider B's documented wire format is a JSON
  number: the string is converted at the last moment and only if the number says exactly
  the same thing.
- `capabilities` (`forwardContracts`, `paymentApprovals`) are returned in the session.
  `forwardContracts` comes from the adapter. `paymentApprovals` is true for every
  company whose approval rule is 1 or 2, whatever its provider can do, because the
  server holds those payments itself (see "Approvals"). The app hides the Forward
  option, the forward list and the approvals list when unsupported, and the server
  refuses them as well.
- Responses contain only neutral shapes. Errors are `{error: {kind, reason?, fields?}}`
  with the app's existing kinds; upstream error text is never forwarded and a provider
  refusing the server's credentials is reported as `server`, not as the customer's
  session ending. A test scans every response for provider names and account ids.
- Provider credentials come from environment variables only (`server/.env.example`).
- Idempotency keys travel in `Idempotency-Key` and are passed to the provider.

### In the app

- Sign-in screen: email and password, then the 6-digit code (or "Use a recovery code"),
  then a company picker when there are several. Activation: `/activate`; opened from the
  link (`/activate#code=…`) it reads the code from the fragment and removes it from the
  address bar.
- The session token lives in memory inside the API client. Nothing that can start a
  session is stored on the device; closing the app or reloading the page signs you out.
- Sign-out revokes the session on the server, clears cached data and deletes that user's
  saved rate alerts. The one thing that can remain on the device is the pending record of
  a money movement whose outcome is still unknown (key and signature, per user).
- After 2 minutes in the background (`INACTIVITY_LOCK_MS`) the app signs out. There is no
  device unlock of any kind.

## Ops console

A staff-only, desktop web console served by the server itself at `/ops`: plain
server-rendered HTML, one stylesheet, one small script for copy buttons (the pages work
without it), no framework, no CDN, no third-party request.
It shares nothing with the client app: separate routes, a separate account table
(`stores.ops`), separate invitations, sessions and lockout counters, and a separate
cookie.

### What stops one staff member acting alone

1. **No activation link or code is ever shown to staff.** Links are sent by the `Mailer`
   to the email address on file; the console shows only `activation email sent to
   a…@domain` and the expiry. (In development the "email" is printed in the server's
   terminal; outside development the server will not start without a real mailer.)
2. **Four-eyes approval.** These actions only create a *request*: reset a client's
   authenticator; create a client user; attach a client to a company or change their
   role; issue or re-issue an activation link; **re-enable** a disabled client (it gives
   back their old password and authenticator); create, **rename**, re-point or
   **reactivate** a company; and all staff management (invite, role change, disable,
   re-enable, unlock, re-issue a staff link, reset a staff authenticator). A
   **different**, active staff member must approve the request before anything changes. The requester cannot approve their own
   request, and nor can the staff member a request is about. **Staff management and
   creating or re-pointing a company can be approved only by an ops admin**: an ops user
   cannot wave through who is staff or where a company's money is. The approver is shown
   how many of this requester's requests they have approved in the last 30 days, and is
   warned when it is nearly always them. Requests expire after 24 hours and can be
   cancelled (by the requester) or rejected (by anyone else). Request, approval,
   rejection, cancellation and expiry are audited, and the entry for the change itself
   names both people. `FOUR_EYES=off` is accepted only with `APP_ENV=development`.
3. **Company-to-account mapping.** Only an ops admin can create a company or change
   which provider account it points at, and only with approval. The account id (and for
   provider A the contact id) must be one the provider confirms exists, and no two
   companies, active or deactivated, can point at the same account. Re-pointing a
   company ends the sessions of everyone attached to it, and the approval request says
   how many people that is. No two companies can have the same name, however it is
   capitalised or spaced. Every request names a company with its id, and with its
   previous name if it was renamed in the last 30 days, so a fresh name cannot mislead
   an approver.
4. **Who can become staff.** A staff account can only be created for an address at a
   domain in `STAFF_EMAIL_DOMAINS` (the demo uses `globalconnect.example`), checked when
   it is asked for and again when it is approved, and only with a second ops admin's
   approval. Each new member of staff is written to the audit log as `ops.staff.new`,
   highlighted, with who asked and who approved.
5. **Whose client it is.** A request to create a client, or attach one to a company,
   shows the person's email domain beside the domains of the people already in that
   company and flags a mismatch.

**The staff-invite risk, and what limits it now.** Before this round an ops admin could
ask for a staff account at an address they controlled and have an ops user approve it;
the pair of accounts then passed everything else between themselves. Now that needs a
second ops *admin* to approve, an address at an allowed staff domain, and it leaves a
highlighted entry. What remains: two ops admins acting together can do anything the
console can do; an ops admin who controls a mailbox at the staff domain and has one
co-operating (or careless) ops admin can still create a second identity; a staff member
who can read a client's mailbox, or has access to the server or its storage, is outside
all of this. Staff SSO and a review of approvals after the fact are the real answers and
are not built.

Take effect at once, after their confirmation page and with an audit entry, because they only take
access away or change nothing a client can use: unlock a client, revoke sessions,
disable a client, remove a client from a company, deactivate a company.

### Break-glass

With exactly two staff, neither can disable or reset the other through the console (a
request about you is not yours to approve), and a lost authenticator or a compromised
account cannot wait for a second ops admin who may not exist. For that there is an
operator command, run on the server's own machine:

```bash
npm run break-glass -- disable-staff jo@example.com "Laptop stolen, reported by phone"
npm run break-glass -- reset-staff   jo@example.com "Lost phone and codes, identity checked in person"
npm run break-glass -- unlock-staff  jo@example.com "Locked out by guessing, verified by phone"
```

It acts on **one staff account** without a second person: disable (sessions end), reset
(password, authenticator and recovery codes removed, sessions ended, a new activation
link emailed to that person, never printed) or unlock. It needs `ADMIN_TOKEN`, reaches
the server only on its loopback listener, requires a reason of at least 10 characters,
and is written to the audit log as `ops.break_glass.*`, highlighted, with the reason.
It cannot touch client accounts. Whoever has the admin token and a shell on the server
can use it: that is the trust it rests on.

### Create the first staff

- **Demo / development:** the server creates `ops.admin@globalconnect.example` and
  `ops.admin2@globalconnect.example` (ops admins) and `ops.second@globalconnect.example`
  (ops) and prints their activation links beside the client codes. Activate at least
  the two admins to try staff management and company changes; any two for the rest. Open each link, choose a password, scan the QR code with an
  authenticator app, confirm with a code and save the recovery codes. This happens only
  with `APP_ENV=development`.
- **Otherwise:** set `ADMIN_TOKEN`, start the server, then on the same machine

  ```bash
  npm run create-ops-admin -- jo@example.com "Jo Smith"
  ```

  It emails that person an activation link valid for 72 hours (and prints only the
  masked address). The address must be at a domain in `STAFF_EMAIL_DOMAINS`. It works
  while **fewer than two active ops admins** exist, because staff management needs one
  ops admin to ask and another to approve; run it twice, for two different people.
  After that it refuses and staff are invited from **Ops staff** in the console. If the
  number of active ops admins later falls below two (break-glass, for instance) it
  works again.

Staff activation links carry the code after `#` (`/ops/activate#code=…`); the script
copies it into the form. Without JavaScript, type the code.

### Open it

- `npm run demo`, then `http://localhost:3001/ops`.
- `npm run server`: `http://localhost:3001/ops`.
- **GitHub Codespaces:** `npm run demo` and open the forwarded port 3001 address with
  `/ops` on the end (`https://<codespace>-3001.app.github.dev/ops`). The port can stay
  private. (Not run in a Codespace by us.)

Sign-in is email + password, then a code (or a recovery code). The session is a cookie:
HttpOnly, SameSite=Strict, and over https `__Host-gc_ops_session` with `Secure` and
`Path=/` (so a sibling subdomain cannot plant it), with HSTS on `/ops` responses. On
plain http, which is allowed only in development, it is `gc_ops_session` with
`Path=/ops`. Outside development `OPS_URL` must be https. The session ends after
**10 minutes** idle or 8 hours. Every form carries a CSRF field bound to that session;
before sign-in the field is bound to a cookie value the server signed (HMAC with
`SERVER_SECRET`, valid for 30 minutes), so nothing is stored per visitor and a flood of
requests for the sign-in page cannot push out a real visitor's; that page is rate
limited like the rest. Requests a browser marks as coming from another site are refused. `/ops`
responses carry a CSP without inline script or style, `frame-ancestors 'none'` and
`no-store`. Lockout and uniform errors work as for clients.

### What ops can do

**The authenticator code is asked for when staff sign in (and when they activate), and
nowhere else in the console.** That is the product owner's decision: a code for every
role change, email and revocation was too much. Instead, every change goes through a
**confirmation page**:

- Pressing a button in the console changes nothing. The server answers with a page that
  says in words exactly what will happen and to whom: the person's name and email, the
  company's name and id, the old and the new value, how many sessions will end, that an
  email will go to a masked address, and whether it takes effect at once or only makes a
  request. It has **Confirm** and **Cancel**. It is plain HTML and needs no script.
- **Confirm** carries a token the server signed (HMAC with `SERVER_SECRET`) for this
  staff session, this action, this address, exactly these form fields and exactly the
  words that were shown. It is good for five minutes and works **once** (a used token is
  remembered in the database). So a confirming request cannot be replayed, altered,
  pointed at another action, taken from another session or made up by another site; and
  if what would happen has changed since the page was shown (someone else changed the
  role in between, say), the page is shown again instead. This is on top of the CSRF
  field, and the content security policy is unchanged.
- **High-impact changes are marked** (red border, "High-impact change", a red Confirm
  button) and state the consequence: disabling a client, removing them from a company,
  deactivating a company, resetting an authenticator, creating or re-pointing a
  company, changing a company's payment-approval rule, and every staff change, both when they are asked for and when they are
  approved.
- **The staff member's password (not a code) is asked for again** on the confirmation
  page for the few highest-impact approvals: approving **any staff-management request**,
  approving a **company creation or re-point**, approving a **change to a company's
  payment-approval rule** (in either direction; the page says what it means, for
  example that with 0 payments will be sent without a second person), and approving a
  **client authenticator reset**. (With `FOUR_EYES=off` in development, where one person carries these out, it
  is asked of that person.) Wrong passwords are counted and lock like sign-in, and are
  audited as `ops.password_check`.
- A client authenticator reset and a staff one still need the free-text
  identity-verification note, and break-glass still needs its reason.

What the per-action code used to protect against was an **unattended, signed-in staff
browser**. What stands there now: the session ends after **10 minutes** without a
request (checked by the server on every request, including a Confirm) or 8 hours;
everything that gives access needs a second person; and the highest-impact approvals
need the password. Someone at an unattended console within those ten minutes can still
do the single-person actions (unlock, revoke sessions, disable, remove from a company,
deactivate a company), all of which take access away, and can make requests.

Clients are not affected: they still type a fresh 6-digit code for payments, approvals,
rejections, cancellations and adding a payee.

"Approval" below means a second staff member, as described above.

- **Companies:** list, search, view; rename, deactivate / reactivate; create and
  re-point (ops admin, approval); **change how many approvals a payment needs** (0, 1
  or 2; approval by an ops admin; see "Approvals"). The company page and the company
  list warn when a company does not have enough approvers for its rule. The provider is chosen as "Provider A / Provider B"
  with its name beside it; provider names appear only here, never in anything the
  client app receives (tested). With the mock providers the accounts that exist are
  `sample-account-0001…0003` (contacts `sample-contact-0001…0003`) on A and
  `S00001…S00003` on B; the first of each is taken by a sample company.
- **Client users:** list, search, view; create attached to one to three companies with
  a role, attach to further companies, change roles (approval); remove from a company.
- **Activation link** (approval): emailed to the client's address on file; the earlier
  link stops working.
- **Unlock** a locked-out client. **Revoke all sessions.** **Disable / re-enable** (a
  disabled client cannot sign in or activate, gets the same answer as a wrong password,
  and loses every session and any unused invitation immediately).
- **Status:** activated or not, last sign-in, locked or not, number of active sessions.
- **Reset authenticator** (approval; see the warning below).
- **Approvals:** the requests waiting, each with what it will do, who asked, its
  consequences and its expiry; approve, reject or cancel.
- **Ops admins only:** list staff; invite, change role, disable / re-enable, re-issue a
  staff activation link, reset a staff authenticator (all with approval). An admin
  cannot demote, disable or reset themselves, and the last active ops admin cannot be
  removed.
- **FX margin:** see a company's margin; change it by request, approved by an ops admin
  with their password, with a worked example (see "Client rates and Global Connect's
  margin").
- **Revenue (ops admins only):** conversions booked since margins were introduced, with
  the provider's and the client's rate and amounts, the margin and the revenue; totals
  by company and month; CSV.
- **Notification state** of a client user: counts and email choices, never contents.
- **Mail:** the state of the email outbox, never the content of a message.
- **Audit log:** view and filter by actor, target, action and date.

### What ops cannot do

- See or set anyone's password, authenticator key or recovery codes (a reset removes
  them; the person chooses new ones). There is no route for it.
- See balances, transactions, payees or payments; create, approve or cancel a payment or
  a conversion. **One exception, by the product owner's decision:** ops **admins** see
  the conversions on the Revenue page (currencies, amounts, both rates), because that
  is what revenue is counted from. The only calls the console makes to a provider are
  "does this account exist" when a company is mapped and "what is the rate for this
  pair now" for the worked example of a margin change.
- Read, send or change a person's notifications or rate alerts.
- Sign in as a client. A staff session is refused by the client API and a client
  session is refused by `/ops` (tested in both directions), and no console page ever
  contains an activation link or code. A test plays a lone staff member trying every
  path (reset, issue a link, create a client with their own email, attach a client to
  another company, approve their own requests) and checks that nothing takes effect,
  no email leaves, and nothing they were shown activates anything. **What remains:** a
  staff member can still *ask* for a client user to be created with an email address
  they control and attached to a client's company; it is the approver who has to notice.
- Change or delete an audit entry.

### Resetting an authenticator: verify identity first

A reset removes the person's authenticator, recovery codes **and password**, ends every
session and emails a new activation link to the address on file. **Whoever controls
that mailbox then controls the account.** It is the classic way to take an account
over: by talking staff into it. Before asking for a reset, verify the person's identity
by a route that does not depend on the request itself (call back on a number already on
file, not one given in the email asking for the reset). The form will not submit without
a description of how identity was verified; that text is shown to the approver and
stored in the audit log with both staff members' names. The console cannot check that
the verification really happened. So, for a **client**, an approved reset **waits**:

1. A **warning** is queued for the client at once, by email and in the app's
   notification list: a reset has been approved, the earliest it can take effect, and
   that signing in now cancels it.
2. **Nothing changes** for `AUTHENTICATOR_RESET_DELAY_HOURS` (default 24; at least 1
   outside development; the confirmation page tells staff how long), **counted from
   the moment the mail server accepted the warning**, not from the approval. While the
   warning is still queued or deferred nothing is due; if the mail server refuses it
   for good it is queued afresh and the reset goes on waiting. The console shows, on
   the person's page and under Approvals, whether the warning has been delivered. The
   client's current password, authenticator and recovery codes go on working.
3. If the client **signs in successfully** during the delay (password and code), the
   reset is cancelled automatically and that is audited
   (`system.client.reset_authenticator.cancelled`, by "signed in"): whoever has the
   credentials evidently did not lose them. Wrong guesses cancel nothing.
4. **Any ops admin can cancel it** during the delay (one is enough: cancelling is the
   safe direction), from the Approvals page or the person's page; confirmed and audited.
5. Only when the delay has passed are the credentials cleared and the activation link
   emailed, with a second notice. A check runs every minute and at start-up; a restart
   in the middle finishes the reset at the next run and does not lose or repeat it
   (a link from before the restart is replaced by the new one).

Limits: the delay protects a client who reads their email or signs in within it; it
does nothing for one who does neither. Someone who controls the mailbox still gets the
account after the delay if nobody notices. A member of **staff** who loses their
authenticator is reset by a second ops admin's approval or break-glass, at once, as
before.

### Audit log

`AuditLog` (`server/src/store/types.ts`) has `append` and `query` and nothing that
changes or removes an entry.

Recorded, each with time, actor, target, action, outcome and source address:

- for clients and staff: activation, sign-in success and failure, lockout, sign-out,
  and sessions revoked by ops; for clients also step-up; for staff a failed password
  check on a confirmation (`ops.password_check`);
- for clients: company selection and **every money action** (create payment, approve,
  reject, cancel, add payee, book conversion), success and failure, with amount,
  currency, payee id and a hash of the idempotency key;
- for held payments also what the server itself did: `client.payment.send` (the last
  approval was recorded and the provider is being asked), `system.payment.send_outcome`
  (`sent`, `failed` or `unknown`), `system.payment.expire`, `system.payment.blocked`
  (the payee changed), each with the payment id, amount, currency and payee id; and
  `ops.company.approvals` for a change of a company's rule, with the old and new value
  and both staff members;
- every ops action that was confirmed, success and failure, with its target when one
  was identified, marked `confirmed: yes` (and `passwordChecked: yes` where the password
  was asked for); approval requests and decisions with both people. Showing a
  confirmation page is not an action and is not logged; there is no staff step-up entry
  any more;
- the operator commands (`invite`, `create-ops-admin`, `break-glass`);
- a new member of staff (`ops.staff.new`) and every break-glass use, both highlighted on
  the audit page.

Not recorded: requests refused before that point (no session, wrong CSRF field, rate
limit), page views, expired sessions, attempts with an unknown activation code, and a
client choosing the company that is already chosen (it changes nothing).

It never contains a password, key, code or token (a test plants them and searches it).

Failures by someone who has not been identified (a wrong password for any email,
including a real one) go to a **separate stream**: the last 5,000 only, at most 20 a
minute per source address, the typed email cut to 80 characters, held in memory and not
written to the database (so they do not survive a restart). They can neither push
anything out of the main log nor fill it. So a password-guessing run against an account
is visible there only in part; the lockout it causes is in the same stream.

**Append-only.** The log is a database table. The code has no statement that changes an
entry, and database triggers reject every `UPDATE` and `DELETE` on it.

**Tamper-evident.** Each entry stores a keyed hash (HMAC-SHA-256) over the entry before
it and its own content; the key is derived from `DATA_ENCRYPTION_KEY`, which is not in
the database. Entries are numbered from 1 without a gap. The **end of the log** (the
last entry's number and hash, how many entries there are, and how far the archive
reaches) is kept in one row that is itself signed with a key derived from
`DATA_ENCRYPTION_KEY`.

**Who may sign the end of the log.** Only three things ever do: the creation of a new,
empty database; a server adding an entry to a log whose end it has just verified; and
the key holder, explicitly (below). In particular the server **never signs an existing
log because the database "needs upgrading"**: the version table is an ordinary table
that anyone with the file can edit. What the database is (its schema version, and
whether it was ever used in development) is kept in a second signed record, required
on every database that is not brand new, and it must agree with the version table. So
deleting rows, columns, markers or version numbers to make a cut log look like an old
database waiting to be upgraded gets a refusal, not a signature.

`npm run audit:verify` (read-only; it changes nothing in the database) checks:

- the whole chain, live and archived as one log, naming the first entry that was
  changed, removed, inserted or reordered;
- that the log ends where the signed record says. Cutting entries off the end is found
  even if the record of the end is edited, copied from the entry that is now last, left
  unsigned or deleted;
- that entries are where the server put them: an entry moved into (or out of) the
  archive by anyone else no longer matches the signed archive boundary;
- that **nothing has been added to the database** that could hide or drop entries: the
  audit tables, the marker tables and their indexes must be exactly as this code
  creates them, and the database must contain the four append-only triggers and no
  other trigger and no view at all, wherever attached.

The server runs the cheap part of this (everything but the walk along the chain) at
every start and refuses to start if it fails. And every entry is written fail-closed:
the server first verifies the signed end, then checks that the database really stored
exactly one new entry, next in sequence, and moved the end by one; if any of that is
not so, the entry is not written, the transaction is rolled back, and **the action that
was to be recorded is refused** (a trigger that makes an insert quietly do nothing is
caught this way even between two runs of `audit:verify`).

**What this does and does not detect, precisely.** Someone who can write the database
file but does **not** have the key cannot, without it being found at the next start or
the next `audit:verify`: change, insert, reorder or remove an entry; cut entries off the
end; hide entries in the archive; add a trigger, view or index that suppresses entries;
or get the server to sign a shortened log. They **can** still do two things that the
database alone cannot show:

- **replace the whole database with an older copy of itself** (or delete it, so that a
  new empty one is created). An older copy is a valid log. Only a **checkpoint kept
  somewhere else** catches this:

  ```bash
  npm run audit:checkpoint -- /somewhere/else/audit-2026-11-16.checkpoint   # refuses to overwrite
  npm run audit:verify -- --checkpoint /somewhere/else/audit-2026-11-16.checkpoint
  ```

  The checkpoint is a small signed file (entry number, hash, count, time; no entry
  content). Verifying with it fails if the log no longer contains what it contained
  then. Everything written after the newest checkpoint you hold can still be rolled
  back unnoticed. Taking checkpoints is manual: nothing schedules it or ships it off the
  machine, and a checkpoint left beside the database protects nothing;
- **stop the server recording at all** (by breaking the database so that it refuses to
  start, or to write). That is loud, not silent.

Someone who **has the key** can rewrite the chain, the record of its end, the state
record and a checkpoint. Write-once storage for entries is not built.

**When the end of the log is not signed.** A database written by the first version of
this server (schema 3) has a log whose end was never signed, and a key rotation done
beside a running server with the previous version could leave the end unsigned. The
server refuses to start on such a log, says how many entries it holds and what its end
is, and will not sign it. The **key holder** can accept the log as it stands, once:

```bash
npm run audit:reseal        # server stopped; needs DATA_ENCRYPTION_KEY
```

It checks every entry that is there (altered entries are never accepted, only an
unsigned end), signs the end, and writes an entry `system.audit.resealed` saying how
many entries were accepted, which the console highlights. Where no command can be run
(a container that will not start), set `AUDIT_ACCEPT_LOG_END` to the end label from the
refusal message for **one** start: it matches only that exact log, and the server will
not start a second time while it is still set. Be clear about what acceptance means: if
entries had been cut off the end before you accepted it, they are gone and the log now
verifies; compare with your latest checkpoint or backup first if you have one. A
database from the previous version of this server (schema 4), whose end was signed,
needs none of this: its signed end is carried over as it is. A local demo can simply be
reset (`npm run demo:reset`).

After a key rotation, keep the old key in `DATA_ENCRYPTION_KEY_PREVIOUS` for as long as
entries written under it must verify.

**When the log grows.** Nothing is dropped. When the live table passes 100,000 entries
the older half is **moved**, in one transaction, to an archive table
(`audit_archive`) in the same database, and a line on the server's error output says so.
The two tables are one log: the ops console searches and shows both, and says how many
entries there are and how many of them are archived. One signed-in client can write at
most 60 entries a minute (see "Rate limits"). Retention and shipping off the machine are
still to do.

### Email

**How it is sent.** Over SMTP, to any email service, through `nodemailer` (pure
JavaScript; nothing to compile). Set in `server/.env`:

| Setting | Meaning |
|---|---|
| `SMTP_HOST` | The mail server. Without it there is no mail server: in development every email is printed in the server console (the "outbox"), which is how the demo works; outside development the server will not start. |
| `SMTP_PORT` | Default 587. |
| `SMTP_TLS` | `starttls` (default: the connection must be upgraded before anything is said) or `tls` (TLS from the first byte; default on port 465). **TLS is required.** `off` is accepted only in development and only for a mail server on this machine (a local mail catcher, the tests). |
| `SMTP_USERNAME`, `SMTP_PASSWORD` | If the service needs them. |
| `MAIL_FROM` | The address email is sent from. A plain address. Required with `SMTP_HOST`. |
| `MAIL_REPLY_TO` | Optional. |

With `SMTP_HOST` set the server sends real email in development too. Outside
development SMTP counts as the real mailer the server insists on; it then still refuses
to start on mock providers, as before.

**What is sent.** Every word of every email is in one file,
`server/src/mail/templates.ts`, to be read and approved in one place. Each message is
plain text plus the same lines as simple HTML: no images, no tracking, nothing loaded
from anywhere, no read receipts. Subject lines carry the brand and nothing about the
person, the money or the secret. A link can only point at this server's own `APP_URL`
or `OPS_URL` (anything else is refused before sending), and only the activation and
password-reset emails carry a link at all: a notice never contains a link that does
something. The footer is a bracketed **placeholder** (`MAIL_FOOTER`) until compliance
supplies the company details and regulatory wording an email must carry.

**The outbox.** A request that causes an email only **writes** it to the database
(table `mail_outbox`); it is sent from there, so a slow or broken mail server neither
blocks nor fails the request. A message that cannot be sent is tried again after 1
minute, 5, 15, 60 and 180 minutes (6 attempts), then marked failed, audited
(`system.mail.failed`) and shown on the ops console's **Mail** page. One logical message
has one key and is queued once however often the code that wants it sent runs. Each
attempt is claimed in a transaction before it is made, so two passes never send the
same message at once. The body, which may hold a single-use link, is stored encrypted
and erased once the message is sent, has failed for good or was held back. Sent
messages are kept as counts (no content) for 30 days.

**Limits, by class of email.** Nobody can use this server to flood an address, and no
class of email can use up another's allowance. Each class is counted by itself, per
address and overall, over the last hour of what was actually sent (from the outbox, so
a restart does not reset it):

| Class | To one address, per hour | Overall, per hour |
| --- | --- | --- |
| Security notices | 12 | `MAIL_GLOBAL_PER_HOUR` (default 1,000) |
| Activation and reset links | 6 | 1,000 |
| Payment notifications | `MAIL_PER_RECIPIENT_PER_HOUR` (default 20) | 1,000 |
| Rate alerts | half of that (10) | 500 |
| Digest ("more is waiting in the app") | 1 | 1,000 |

So a burst of ordinary notifications **cannot hold back** a security notice, a
password-reset link or an activation link. A message over its allowance is **never
dropped**: it is **deferred** (`system.mail.deferred`), stays in the outbox with its
content and is sent when the allowance frees. The one exception: an ordinary
notification beyond one address's allowance is folded into a single digest email for
that hour, which says more is waiting in the app (every notification is in the app's
list anyway).

**Callers are told what became of a message** (sent, queued, deferred, not sent) and
say so: the ops console, the approval page, the operator commands and the audit log
report "sent" only when the mail server has accepted the message, and otherwise that
it is queued or deferred. A forgotten-password request always gets the same answer;
its link is delivered when its allowance frees.

**What the Mail page shows.** How many are waiting, sent, failed or held back, and for
each that did not go: when, the recipient **masked**, the kind of message, the number of
attempts and a short error code. Never a subject, a body, a link or a whole address,
and nothing is logged about a message either.

**Limits of this, plainly.** SMTP cannot say "delivered exactly once". If the process
dies, or the connection drops, between the mail server accepting a message and that
being recorded, the message is sent again at the next attempt (with the same
Message-ID, the same content): **a message can arrive twice in that one case; it is not
lost.** "Sent" means the mail server accepted it, not that it reached the inbox: bounces
are not read. A failed message is not retried by hand from the console; issue the link
again. Not run against a real email service yet.

### Still not production-ready (ops console)

- **Email delivery:** see "Email". SMTP sending is built and tested against a fake mail
  server in the tests; it has **not** been run against a real email service, and SPF,
  DKIM and DMARC for the sending domain, bounce handling and unsubscribe rules are the
  operator's to set up and are not built.
- **The database is one SQLite file on the server's disk** (see "Database"): exactly
  one server process, no replication.
- **A request that was approved but interrupted** (a crash, the mail or the provider
  failing half-way) is neither shown as approved nor silently retried. It is listed on
  the Approvals page under "Approved, but not finished" and counted in the server's log
  at start-up; the approver or an ops admin (never the requester) finishes it, which
  repeats only what is missing (creating a company, a client or a staff member a second
  time creates nothing; an activation email is sent again with a new link, which cancels
  the earlier one), or closes it, which undoes nothing and says so. Finishing and
  closing take exactly the checks of approving (not the requester, not the person the
  request is about, an ops admin where approval needs one, and the requester must still
  be allowed to make the request). A request whose approval is still running is not
  "interrupted" and cannot be run or closed beside it. One left unfinished for more than
  24 hours can only be closed. Nothing finishes such a request automatically.
- **Who can reach `/ops`:** it is on the same port as the client API, open to anyone who
  can reach the server. It needs **IP allow-listing or a VPN, and staff SSO**.
- **Four-eyes is as described above and no more:** two ops admins acting together can do
  anything; the pair-history line warns an approver but stops nobody; there is no review
  of approvals after the fact.
- **Break-glass and bootstrap rest on `ADMIN_TOKEN`**, one shared secret reachable only
  from the server's own machine. Anyone with both can disable or reset any staff member
  and, when fewer than two ops admins are active, create one.
- **Penetration testing:** two independent reviews found the issues fixed so far; the
  latest fixes have tests (each confirmed to fail with its fix reverted) but have not
  been re-reviewed or attacked.
- **Rate limits, lockouts and hash pools are per process and in memory.**

## Replacing the placeholders

### A real provider adapter

- **Provider A**: write a `Transport` (`src/api/adapters/currencycloud/transport.ts`)
  that calls the provider over HTTPS (`params` as a query string for GET and form data
  for POST, the token in `X-Auth-Token`; resolve for any HTTP status, reject only when no
  response arrives) and pass it to `createRuntime(config, { transports: { currencycloud } })`
  in `server/src/index.ts`. The client already sends `on_behalf_of` with the company's
  contact id on every call; **whether every endpoint used accepts and enforces it has
  not been checked against the real API**, nor has `GET /v2/accounts/{id}` as the way to
  confirm an account exists. The rate-history endpoint is not part of the provider API.
- **Provider B**: write an `EqualsTransport` (`server/src/providers/equals/raw.ts`) and
  pass it as `transports.equals` to `createRuntime`. Then go through `raw.ts` and
  replace every shape marked INVENTED with the documented one.
- **A mailer**: set `SMTP_HOST` and `MAIL_FROM` (see "Email"), or implement `Mailer`
  (`server/src/mailer.ts`) and pass it to `createRuntime(config, { mailer })`. Until both
  transports and a mailer are supplied the server refuses to start outside development
  mode.
- **Another provider**: implement `ProviderAdapter`, add its key to `ProviderKey` and a
  factory to the registry in `server/src/index.ts`.

### Database

The server keeps its data in **SQLite**, through Node's built-in `node:sqlite` module:
nothing to install or compile. That module is still marked experimental by Node (hence
the one-line warning at start-up) and needs **Node.js 22.13 or newer**; the server
checks before loading anything and says so.

| Setting | Meaning |
|---|---|
| `DATABASE_PATH` | The database file. **Required** outside development. In development, unset = an in-memory database. |
| `DATA_ENCRYPTION_KEY` | 32 random bytes in base64 (`openssl rand -base64 32`). **Required** outside development; refused if short or not random. Never stored in the database. |
| `DATA_ENCRYPTION_KEY_PREVIOUS` | Older keys, comma-separated, still accepted for reading. |

**What is in it:** client and staff accounts, companies and memberships, invitations,
sign-in challenges, sessions, step-up permissions, lockout counters and known sources,
approval requests, idempotency mappings, the audit log. **What is not:** rate-limit
windows, the issued-quote map, the hash-pool accounting and the stream of anonymous
sign-in failures; those are in the server process and a restart clears them.

**How it is opened:** write-ahead logging (`journal_mode=WAL`), `synchronous=FULL`
(every commit is flushed before it is acknowledged; set for the whole connection, so it
covers the audit log and everything else), foreign keys on, a 5-second busy timeout.

**Migrations** are numbered and forward-only (`server/src/store/sqlite/migrations.ts`).
At start-up each one not yet applied runs in its own transaction and is recorded in
`schema_version`. A database with a higher version than the code knows is refused: the
server will not open a file written by a newer version of itself. Before any migration
runs on a database that already exists, its key marker and signed state record are
checked (see "Audit log": nothing is upgraded on the word of the version table alone).
Migration 4 makes two rules the database's own: **one provider account, one company**
and **one company per name** (compared ignoring case, spacing and width) are unique
indexes, so two approvals arriving together cannot create two companies on one account;
the loser is refused with a plain message and its request goes back to waiting. If a
database from before that already holds two companies on one account, or with one name,
the upgrade stops before changing anything and **names the companies**. Migration 5
(this version) adds the signed state record, signs the archive boundary together with
the end of the audit log, and adds the table in which payments sent straight to the
provider are recorded by key. **Upgrading:** a database from the previous version
(schema 4) upgrades by itself at the next server start. One from the first version
(schema 3) does too if its audit log is empty; if it has entries, the server refuses
and says what to do (`npm run audit:reseal`, or for a demo `npm run demo:reset`).

**Transactions.** Every read-then-write of security state (setting a password on an
invitation, counting an attempt, burning an authenticator step, using a recovery code,
deciding a request) is one transaction that takes the write lock first; one-time things
(an invitation, a step-up permission, a session being revoked, a sign-in challenge) are
taken with a single `DELETE ... RETURNING`.

**Encryption at rest.** Authenticator (TOTP) keys, including the pending one of a
half-finished activation, are stored encrypted with AES-256-GCM under
`DATA_ENCRYPTION_KEY`. Each ciphertext is bound to its row (copied to another row it
does not decrypt) and names the key that made it. Passwords, recovery codes, tokens and
activation codes are stored only as hashes, as before. Everything else (names, emails,
the audit log) is not encrypted: the file needs disk encryption and access control like
any database. The wrong key is refused at start-up, before anything is changed.

**Rotating the key.** The server must be **stopped**. This is the only safe order, and
the command refuses to run while a server holds the database:

```bash
# 1. Stop the server.
# 2. In server/.env: the NEW key in DATA_ENCRYPTION_KEY, the old one in DATA_ENCRYPTION_KEY_PREVIOUS
npm run db:rotate-key        # re-encrypts every stored authenticator key, and re-signs the key marker,
                             # the state record and the end of the audit log, with the new key
# 3. Start the server (with the new key, and the old one still in DATA_ENCRYPTION_KEY_PREVIOUS
#    for as long as audit entries written under it must pass audit:verify).
```

Why not beside a running server: it would leave that server holding only the old key
while its authenticator keys and the signature on the end of its audit log had moved to
the new one. (If that ever happens the running server now fails closed: it cannot verify
the end of the log, so it writes no entry and refuses whatever was to be recorded, until
it is restarted with the new key. It no longer overwrites the end with an unsigned one.)
The rotation is **one transaction**: if any stored secret cannot be decrypted it stops,
names the table and row, and nothing is changed.

**One server process.** The server keeps some state in its own memory (rate limits, the
quotes it issued, which payments it is sending) and assumes nobody else is sending its
payments, so it must be the only server on its database. At start-up it takes an
exclusive operating-system lock on `<database>.lock`, beside the database file **as
resolved** (a symlink to the database, or a path through a symlinked folder, leads to
the same lock), and a second server refuses to start. The lock is released if the
process dies. The two commands that write (`db:rotate-key`, `audit:reseal`) take the
same lock, so they refuse to run beside a server; the read-only ones (`audit:verify`,
`audit:checkpoint`, `db:backup`) do not, and can. **Limits of this lock:** it is a lock
on a file beside the database, not on the database itself (Node offers no file lock
without native code, and locking the database itself would shut out the read-only
commands). So the running server also checks every 2 seconds that its lock file is
still the one on disk, and **stops** if it has been deleted or replaced; for up to those
2 seconds a second server could have started. It does not protect against the same
database reached through a hard link or a second mount in another folder, nor against
someone who deliberately defeats it; it is there to stop an accident.

**File permissions.** The database holds password hashes, encrypted keys and the audit
log. The server sets its umask to 077 at start-up, creates the database, its `-wal` and
`-shm` files, the lock, the development key file and its folder for the owner only
(`600`/`700`), and **refuses to start** (and the commands refuse to run) if any of
those files, or the folder, grants **anything at all** to group or others, naming the
`chmod` that puts it right. A path that is a symlink is checked where it really leads
as well as where it is. `npm run demo` tightens its own `.demo-data` folder; the
container's entry script does the same for the volume. Not checked: the folders above
it, ACLs, and who else can become the server's user. Not applicable on Windows, where
the check is skipped.

**A database that has been used in development stays a development database.** The first
start in `APP_ENV=development` marks the database (it then holds sample accounts and, in
`dev_seed_codes`, their activation codes in readable form). The mark is part of the
signed state record, so it cannot be removed by deleting a row. A strict start
**refuses** such a database rather than purging it, and refuses any database made
before schema 5 (nothing but development could run then): start a real deployment with
a new file. A database that has lost the marker saying which encryption key wrote it,
or its signed state record, is refused too, whatever key is offered (restore from a
backup).

**Backups.** Do not copy the file while the server is running: with write-ahead logging
a plain copy can be inconsistent. Use

```bash
npm run db:backup -- /path/to/backup.sqlite     # refuses to overwrite an existing file
```

which takes a consistent snapshot with SQLite's `VACUUM INTO` while the server keeps
running. The command opens the database read-only, and the backup file is created for
the owner only (`600`) before anything is written to it; the folder you put it in is
yours to protect. A database left by an older version is not upgraded by a read-only
command: start the server once first. The backup holds everything the database does; the
encryption key is not in it and must be kept separately (and must be kept: without it
the authenticator keys in the backup cannot be read and the audit chain cannot be
verified). A backup is also exactly what "an older copy of the database" means for the
audit log: take an `audit:checkpoint` when you take one. Scheduling, off-site copies
and restore drills are not built.

**Moving to PostgreSQL later.** All SQL is in `server/src/store/sqlite/`; services see
only the interfaces in `server/src/store/types.ts` (`Directory`, `OpsDirectory`,
`Table`, `AuditLog`), which carry no SQLite types. What is SQLite-specific and would be
rewritten: `db.ts` (the synchronous connection, the PRAGMAs, `BEGIN IMMEDIATE` as the
locking strategy, `VACUUM INTO` for backup); `migrations.ts` (`STRICT` tables,
`AUTOINCREMENT`, `RAISE(ABORT)` triggers, `json_extract` expression indexes);
`tables.ts` (small tables stored as one JSON document per key, with `json_extract` in
lookups). In PostgreSQL the transactions would become `SELECT ... FOR UPDATE` or
conditional `UPDATE`s, the documents `jsonb`, and the interfaces (already
`Promise`-returning) would not change. More than one server process would need more
than a different database: the in-memory rate limits and the issued-quote map
(`http/app.ts`, capped at 20,000 quotes) would have to move to shared storage, and the
start-up settling of unfinished sends assumes there is no other server.

## How closely the mocks follow the real APIs

### Provider A (Currencycloud-shaped)

Checked on 2026-11-10 against the public OpenAPI spec
(`github.com/currencycloud/currencycloud-swagger`, `src/reference.yaml`) and the public
developer guides. Verified from the spec: endpoint paths, request parameter names,
response field names and the `pagination` object for
`/v2/balances/find`, `/v2/funding_accounts/find`, `/v2/transactions/find`,
`/v2/rates/find`, `/v2/quotes/create` (held-rate quote), `/v2/conversions/create`,
`/v2/conversions/find`, `/v2/beneficiaries/find`, `/v2/beneficiaries/create`,
`/v2/payments/create`, `/v2/payments/find`, `/v2/payments/authorise`,
`/v2/payments/{id}/delete`, `/v2/accounts/current`, `/v2/contacts/{id}`,
`/v2/authenticate/close_session`, and the error body (`error_code`, `error_messages`).
`mapping.test.ts` runs the spec's own example payloads through the mapping.

Nothing was tested against a live or sandbox API. Known approximations:

| Area | Status |
|---|---|
| Sign-in | The client logs in with `login_id` + `api_key` at `/v2/authenticate/api`, as the provider documents. The customer's own sign-in is the Global Connect server. |
| Rate history for sparklines (`/v2/rates/history`) | **Not part of the provider API.** Invented endpoint, synthetic points. Needs a market-data source. |
| Error codes `quote_expired` and `insufficient_funds` | Invented by the mock. The public spec does not list the real codes. |
| Reconciliation by key | `unique_request_id` is a documented filter on `/v2/payments/find` and `/v2/conversions/find`. Whether a real conversion booked with `quote_id` replays on a repeated `unique_request_id` is unconfirmed. |
| Payee lookups | Lists label payments with `GET /v2/beneficiaries/{id}` for the ids on the page (cached 5 minutes); approvals always read the payee fresh. "Read everything" loops stop at 50 pages of 100 and report `truncated` instead of failing; the payee picker says so. Balances, forwards and pending approvals beyond 5,000 rows are cut off without a notice. |
| Multi-step approval | The mock decrements `authorisation_steps_required`; it does not track who approved, so the same user is offered the next step. |
| Spot vs forward | The API has no flag. A conversion dated more than 5 days after creation is treated as a forward. |
| Forward drawdown | Derived as buy amount − `unallocated_funds`. Unconfirmed. |
| Approval chain | Derived from `creator_contact_id` and `authorisation_steps_required`. |
| Reject payment | Mapped to delete payment; the provider has no reject endpoint. |
| `/v2/rates/detailed` | In the brief but not used. Held-rate quotes cover the convert flow. |
| Insufficient funds on conversion | The mock refuses. The real API books and waits for funds. |
| Payment `reason` | Required by the provider; the app sends the reference until the product decides what to ask. |
| Mock pricing | Sample mid rate, no spread, bid = offer. |
| `bank_name` on funding accounts | Deliberately not mapped, because it would show the provider's name. |

### Provider B (Equals-shaped)

Modelled on the public Equals Money documentation (`docs.equalsmoney.com`), read on
2026-11-11 through page summaries, not the raw OpenAPI file. **Partly real, partly
invented**, and marked line by line in `server/src/providers/equals/raw.ts`:

| Taken from the public docs | Invented by this mock (pages not read) |
|---|---|
| `GET /v2/budgets?accountId=&include=balance` with `limit/offset/count/rows` and the `balance[]` fields | the inner fields of `settlementDetails` |
| `POST /v2/orders/quote` request and response (`quoteRequestId`, `orderId`, `settlement`, `quote`), 12-second validity | listing recipients (`GET /v2/recipients`) |
| `POST /v2/orders/trade` `{orderId, quoteRequestId}` | single-currency payment orders, listing and looking up orders |
| `POST /v2/recipients/validate`, then `/v2/recipients/{id}/confirm` → `AUTHORISED` | account activity, indicative rates, the error body |
| `Authorization: ApiKey …`, amounts as JSON numbers, `YYYYMMDD` dates | idempotency (the docs read did not mention any; the mock treats a repeated order id / client reference as the same order) |

Nothing was tested against a live or sandbox API. Provider B's capabilities here (no
forwards) are a choice made for the demo, not a statement about the real product. No rate history is offered, so no trend line is drawn.

## What is placeholder

- **All data**: company "Northfield Trading Ltd", balances, payees, payments, rates,
  the forward contract. Account numbers are obvious fakes (`00-00-00`, `00000000`,
  `GB00SMPL…`). One sample payee uses the standard documentation IBAN `DE89 3704 0044 0532 0130 00`.
- **`src/config/disclosures.ts`**: fee, delivery estimate, settlement time, payment route,
  regulatory footers, rate disclosure, forward terms, alert delivery, how to open an
  account. All bracketed. A test fails if any stops being a bracketed placeholder.
- **Plan name** "Business Standard" (`src/config/app.ts`).
- **Supported currencies, watchlist pairs, payee countries**: short hard-coded lists.
- **Payee rules**: simplified. Real rules come from the provider's
  `beneficiary_required_details`.
- **Rate alerts in the in-app demo (no server)**: stored on the device only; nothing
  watches rates and nothing is sent. With the server they are kept and checked there
  (see "Rate alerts and notifications").
- **Push notifications**: not built. Notifications are a list in the app and email.
- **App icon and splash**: the Expo template images.
- **Developer panel**: shown whenever the mock backend is active. Hide it before release.
- **Sample people and companies**: a seed directory of made-up people and companies,
  loaded into an empty database in development only.
- **Both provider APIs**: in-memory mocks.
- **The in-app demo sign-in**: accepts anything; code `000000`.

### The web app's response headers

When the server serves the client web app (the demo), every response carries
`X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` and a content security policy:
scripts, connections, fonts and images from the same origin only (plus `data:`/`blob:`
images), `object-src 'none'`, `frame-ancestors 'none'`, and inline **styles** allowed
because the web build injects its style sheet at run time. The policy was checked
against the built files (no inline scripts in `index.html`; route bundles are loaded
with `<script src>` from the same origin; the one `new Function` in the bundle is a
feature probe inside a try/catch) and in tests. **It has not been tried in a browser**,
where a too-strict policy would show as a blank page. If that
happens, the policy is `WEB_APP_CSP` in `server/src/http/app.ts`.

## Compliance guards

`src/test/compliance.test.ts` scans every UI folder (`app`, `components`, `screens`,
`config`, `state`, `hooks`, `lib`, `theme`, `alerts`) and fails if it finds:

- a provider name;
- the words "secure" or "encrypted" in customer-visible lines;
- fee, timing, rate or regulatory claims in customer-visible lines ("instantly",
  "live rates", "real-time", "guaranteed", "FCA", ...). Such wording belongs in
  `src/config/disclosures.ts`, and every value there must stay a bracketed placeholder;
- any leftover device-unlock code, copy or dependency (the feature was removed).

`secureTextEntry` (the platform's name for a password field) is the one allowed use of
that word. The sign-in is not described with any assurance wording in the app; that slot
is the placeholder `disclosures.signInAssurance`.

Also: no analytics and no third-party network calls (Inter is bundled, so there is no
runtime font request), and no secrets in the repo (the `EXPO_PUBLIC_*` variables are
developer switches).

## Not production-ready and not verified

Not built:

- **Email delivery.** There is a `Mailer` interface and a development outbox that prints
  the message in the server's terminal. No implementation sends mail, and the server
  refuses to start outside development mode without one.
- **Live providers.** There is no HTTPS transport for either provider. Outside
  development mode the server refuses to start on the mocks, so today it runs **only**
  with `APP_ENV=development`.
- **Self-service account recovery**: password change and reset, re-enrolling an
  authenticator and regenerating recovery codes by the client. The only recovery is an
  ops reset (see "Ops console"), which replaces everything.
- **Ops console gaps**: see "Still not production-ready (ops console)". The operator
  commands (`invite`, `create-ops-admin`, `break-glass`) are still guarded by one shared
  token, on a loopback-only listener.
- **Audit log storage**: an append-only, hash-chained table in the server's own
  database, archived rather than dropped (see "Audit log"). It is not shipped anywhere
  else, so whoever holds both the file and the key can rewrite it. Reads (who looked at
  which balance) are not audited.
- **Secrets management**: credentials and the data encryption key are plain environment
  variables (in development the key is a file beside the database); there is no KMS or
  HSM. TOTP keys are encrypted in the database and decrypted in memory when checked.
- **Database**: SQLite, one file, one server instance; see "Database". No replication,
  no scheduled backups, and `node:sqlite` is marked experimental by Node.
- **Hosting**: no TLS termination, deployment, monitoring, backups or multi-instance
  support. Rate limits and lockouts are per process. Behind a proxy set `TRUST_PROXY` to
  the proxy's address or range (or a hop count), or every client shares one address for
  rate limiting and lockout.
- **Penetration testing**: none in the formal sense. Two independent reviews (the second
  with probes against a running server) were done and their findings fixed with
  regression tests, each confirmed to fail with its fix reverted; the latest fixes have
  not been re-reviewed. Response *content* is uniform across known and unknown emails.
  Timing was not measured, and during a flood of sign-in attempts it can differ between
  known and unknown emails (see "Passwords"). Someone on the owner's own network can
  still lock that network out of the account for a while, and an owner signing in from a
  new network during an attack is locked out with everyone else (see "Lockout").
- **Dependency advisories.** `npm audit` in `server/` reports none. `npm audit` in the
  repository root reports **31** (30 moderate, 1 low; 22 with `--omit=dev`), all of them
  three packages and whatever depends on them: `glob` (cancellation bypass allows
  filesystem traversal after a timeout), `minimatch` (denial of service from crafted
  patterns) and `deepmerge` (prototype poisoning of returned objects). They arrive
  through Jest (`jest`, `jest-expo`, `babel-jest` and their parts), ESLint
  (`eslint-config-expo`, `@typescript-eslint/*`) and Expo's command-line tooling
  (`@expo/cli` and one other Expo build package, which `expo` depends on, hence the 22). That is
  test, lint and build tooling run on a developer's machine: by npm's dependency tree
  none of it is imported by the server or bundled into the app, but we did not verify
  that independently, and `npm audit fix --force` would change major versions, so
  nothing was changed.
- **Tenant isolation at the real providers**: the server scopes every call and checks
  ids itself, but this has only ever run against the mocks.
- **Provider approval**: no provider has reviewed or approved this flow, the step-up as
  their required customer authentication, or the use of their API in this way.
- The common-password list is about twenty entries.

Not verified by us:

- GitHub Codespaces: `npm run demo` was run locally only. The Codespaces settings (https
  address, `Secure` `__Host-` cookie, one trusted proxy hop) were started locally and the
  response headers checked, but no browser went through a real forwarded port; whether
  the forwarder sends `X-Forwarded-For` as assumed is not known (if it does not, all
  visitors share one rate-limit bucket, which is safe but tight).
- The web app driven in a browser against the server: the server flow was exercised
  with a script over HTTP and the screens with Jest against the in-app demo.
- The ops console in a real browser: it was driven end to end over HTTP by a script
  (forms, cookies, CSRF fields), so its layout, the copy button, the confirmation
  prompts, the `#code=` prefill, the `__Host-` cookie and the CSP as a browser enforces
  them were not seen. The app's reading of `#code=` was tested in Jest, not in a browser.
- A real authenticator app scanning the QR code. The URI is the standard `otpauth://`
  form and the codes match the RFC 6238 test vectors.
- Any physical or simulated iOS or Android device.

## Known limits

- **The processing window is a guess.** `outcomeCheckTiming` (90 s) must be set from what
  the provider says about how late a timed-out request can still be applied. If a request
  lands after the window, the app will have released the form. Retrying the *same*
  payment or conversion in the same visit reuses its key and is safe; a changed amount
  after that could produce two movements.
- **Approve and reject are not recorded before sending**, only payments and conversions.
  They are safe to repeat, and the review screen re-reads the payment before acting.
- **Device clock.** The quote countdown uses the hold length from the server, started
  when the answer arrives on the device, so a wrong device clock does not shift it.
  Network delay still makes the app's countdown end slightly after the server's; the app
  stops 1 second early and the server remains the authority (`quote_expired`).
- **Accessibility** is by construction (roles, labels, capped font scaling, selection
  never by colour alone) and has not been audited with VoiceOver or TalkBack. Known gaps:
  the tab bar marks the active tab by colour and stroke weight only; modal dialogs do
  not trap focus on web; toasts disappear after 2.5 seconds.
- Forward settlement dates skip weekends but not bank holidays.
- Payee rules, currency lists and the watchlist are short hard-coded lists.
