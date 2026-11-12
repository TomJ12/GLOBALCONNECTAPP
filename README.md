# Global Connect — client app and server

A mobile app for Global Connect business customers (multi-currency balances, account
details, payments with approval, spot and forward conversion, rates and rate alerts) and
the Global Connect server it signs in to.

**Nothing here is connected to a real provider or a real database. All data is sample
data, the provider APIs are in-memory mocks and server storage is in memory (or, for
the local demo only, one JSON file).** The server also serves an **ops console** for
Global Connect staff under `/ops` (see "Ops console").

**The server is strict by default and, as it stands, only runs in development mode.**
Mock providers, sample data, printed activation codes, the console "outbox" that stands
in for email, and the JSON file store exist only with `APP_ENV=development`, which
`npm run demo` and `npm run server` set. Without it the server refuses to start on
mocks or without a real mailer, and this repository has neither a live provider
transport nor a real mailer yet. `NODE_ENV` decides nothing. Fees,
delivery times and regulatory wording are bracketed placeholders.

- App: Expo SDK 58, React Native 0.88, TypeScript strict, expo-router; iOS, Android, web
- TanStack Query for server state, zustand for session and developer settings
- big.js for all money and rate arithmetic (amounts are decimal strings, never floats)
- zod validation of every backend response
- Server (`server/`): Node 22, Fastify, TypeScript strict, node:crypto only (scrypt, HMAC)

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
for each account that is not activated yet: the three sample clients and two demo staff
for the ops console (`ops.admin@globalconnect.example`, an ops admin, and
`ops.second@globalconnect.example`, an ops user: two, because sensitive ops actions need
a second person).

| User | Company | Held at |
|---|---|---|
| `amira@northfield.example` | Northfield Trading Ltd | provider A (forwards, approvals) |
| `ben@castlebrook.example` | Castlebrook Imports Ltd | provider B (no forwards, no approvals) |
| `dana@adviser.example` | both | chooses a company after signing in |

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

**There is no email.** Whenever the server "sends an activation email" (from the ops
console or the operator commands below) the whole message, link included, is printed in
the terminal the server runs in, marked `DEVELOPMENT OUTBOX`. That is the only place a
link appears: it is never shown in the ops console and never returned over HTTP.

**Demo accounts are kept between runs.** `npm run demo` sets `DATA_FILE` to
`.demo-data/accounts.json` (git-ignored) and says so when it starts, so accounts you
activate survive a restart. Wipe it with `npm run demo:reset`. That file holds password
hashes, authenticator keys **in plain form**, unused activation records, pending
approval requests and the audit log. It is for a local demonstration only: the server
refuses `DATA_FILE` unless `APP_ENV=development`, checks the file against a schema when
it loads it and refuses one that does not fit. Sessions, lockout counters and the log of
anonymous failures are not kept, so a restart signs everyone out and forgets lockouts,
and a failed sign-in by a stranger never rewrites the file. Without `DATA_FILE` (for
example `npm run server`) everything is in memory and a restart forgets the accounts and
prints new codes.

**Operator commands.** Two commands talk to the running server; they stand in for
tooling an operator with access to the machine would have:

```bash
npm run invite -- amira@northfield.example          # email a new activation link to a client
npm run create-ops-admin -- jo@example.com "Jo Smith"   # see "Ops console"
```

They need `ADMIN_TOKEN` in `server/.env` (generate one with `openssl rand -base64 32`;
the server refuses placeholders and short or repetitive values) and they reach the
server on a **separate listener bound to 127.0.0.1 only** (`ADMIN_PORT`, default 3002).
The public port has no `/admin` route. Neither command prints a link: the link is
emailed (in development: printed in the server's terminal).

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
npm test                 # node:test, 69 tests (about 90 seconds)
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
    ops/            the ops console: auth.ts (staff accounts, sessions, step-up),
                    console.ts (every /ops route and page, approvals), html.ts, static/
    store/          types.ts (repository interfaces incl. OpsStore, AuditLog and the atomic
                    operations), memory.ts, file.ts (local demo only), seed.ts  <- PLACEHOLDER
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

Send payment, approve, reject and convert all follow the same rules:

1. **Single flight.** The button goes through `useSingleFlight` (a ref lock, so a second
   tap in the same frame is ignored).
2. **Explicit confirmation.** `confirmAction()` in `src/lib/confirmAction.ts` shows a
   confirm step that states the amount, payee and masked account. Nothing is sent before
   the customer presses the confirm button.
3. **Idempotency.** Creating a payment and booking a conversion send an idempotency key.
   The payment key is bound to payee + amount + currency + reference. The conversion key
   is bound to the conversion *intent* (currencies, side, amount, type, date), not to the
   quote, so a re-quote of the same conversion reuses it.
   Approve and reject send **no** key: the provider's authorise and delete endpoints do
   not accept one. They are safe to repeat because a payment that is no longer waiting
   for approval cannot be approved or rejected again.
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

- **Passwords**: scrypt, N=2^17, r=8, p=1 (about 128 MiB per hash). At most two hashes
  run at once and 64 wait; beyond that a request gets 429 rather than more memory. A
  hash made with a lower cost is replaced at the next successful sign-in.
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
  store operation, so simultaneous requests get exactly the allowed number of checks.
  Counters are kept per **account and source address**: 5 failures from one address
  against one account lock that address out of that account for 1 minute, doubling with
  each further failure up to 1 hour. Someone else's wrong guesses, from another address,
  do not lock the owner out. A second counter per account across **all** addresses locks
  it for everyone at 50 failures. Password, sign-in code, step-up code and activation
  are counted separately, so wrong step-up codes in a stolen session cannot lock
  sign-in. Whether the account exists plays no part; success clears the counts. A
  challenge is spent after 5 wrong codes or 5 minutes. A live lock is never evicted to
  make room for other counters. Limits of this: an attacker behind the same address as
  the owner (an office, a carrier NAT) still locks them out, and 50 guesses spread over
  50 addresses lock the account for everyone for up to an hour.
- **Rate limit**: on top of that, each address gets 30 requests a minute on the sign-in,
  activation, step-up and ops-action routes. "Address" is the connection's address, or,
  behind a reverse proxy, what `TRUST_PROXY` says: the proxies' own addresses or CIDR
  ranges (preferred) or a number of hops. `true` is not accepted, so a client cannot
  pick its own address by sending `X-Forwarded-For`. A hop count is only right when the
  server cannot be reached except through that many proxies. When the limiter is
  tracking its maximum number of addresses it refuses new ones until a window ends; it
  never resets anyone's count.
- **Sessions**: 15 minutes idle, 12 hours absolute, revoked by `POST /v1/auth/logout`.
  Membership is re-read on every request.
- **Atomic state changes**: an invitation, a TOTP step, a recovery code, a sign-in
  challenge, a step-up permission and a session are each changed through the store's
  atomic operations (`Table.mutate`, `Table.take`, `Directory.updateUser`), never
  read-then-write. The in-memory store makes these trivially atomic; a database must
  implement them as transactions or compare-and-set.
- **Logging**: method, path and status only. Query strings, bodies and headers are never
  logged. Activation codes travel in the link's fragment, not the path or query. (A
  search typed into the ops console is a query string: it reaches the server but not
  the log.)

### Step-up on money actions

Creating a payment, approving, rejecting and adding a payee need a fresh code. Booking a
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
- `capabilities` (`forwardContracts`, `paymentApprovals`) come from the adapter and are
  returned in the session. The app hides the Forward option, the forward list and the
  approvals list when unsupported, and the server refuses them as well.
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
server-rendered HTML, one stylesheet, one small script for copy buttons and
confirmations (the pages work without it), no framework, no CDN, no third-party request.
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
   role; issue or re-issue an activation link; create a company or change its provider,
   account id or contact id; and all staff management (invite, role change, disable,
   re-enable, re-issue a staff link, reset a staff authenticator). A **different**,
   active staff member must approve the request with their own fresh authenticator code
   before anything changes. The requester cannot approve their own request, and nor can
   the staff member a request is about. Requests expire after 24 hours and can be
   cancelled (by the requester) or rejected (by anyone else). Request, approval,
   rejection, cancellation and expiry are audited, and the entry for the change itself
   names both people. `FOUR_EYES=off` is accepted only with `APP_ENV=development`.
3. **Company-to-account mapping.** Only an ops admin can create a company or change
   which provider account it points at, and only with approval. The account id (and for
   provider A the contact id) must be one the provider confirms exists, and no two
   companies, active or deactivated, can point at the same account. Re-pointing a
   company ends the sessions of everyone attached to it, and the approval request says
   how many people that is. Any staff member can rename a company.

What this does not cover: two staff members acting together; a staff member who can
read the client's mailbox; a staff member with access to the server or its storage. The
approver may be an `ops` user approving an ops admin's request: the check is "a second
person", not "a more senior one".

Take effect at once, with a fresh code and an audit entry, because they give nobody
access: unlock, revoke sessions, disable / re-enable a client, remove a client from a
company, deactivate / reactivate a company, rename a company.

### Create the first staff

- **Demo / development:** the server creates `ops.admin@globalconnect.example` (ops
  admin) and `ops.second@globalconnect.example` (ops) and prints their activation links
  beside the client codes. Open each link, choose a password, scan the QR code with an
  authenticator app, confirm with a code and save the recovery codes. This happens only
  with `APP_ENV=development`.
- **Otherwise:** set `ADMIN_TOKEN`, start the server, then on the same machine

  ```bash
  npm run create-ops-admin -- jo@example.com "Jo Smith"
  ```

  It emails that person an activation link valid for 72 hours (and prints only the
  masked address). It works while **fewer than two** active staff exist, because
  approval needs two people; run it twice, for two different people. After that it
  refuses and staff are invited from **Ops staff** in the console.

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
before sign-in the field is bound to a cookie value the server issued and remembers for
30 minutes; requests a browser marks as coming from another site are refused. `/ops`
responses carry a CSP without inline script or style, `frame-ancestors 'none'` and
`no-store`. Lockout and uniform errors work as for clients.

### What ops can do

Every change needs a **fresh authenticator code from the staff member, typed into the
form that makes the change** (step-up). A code works once, so two changes need two codes
(about 30 seconds apart). "Approval" below means a second staff member, as described
above.

- **Companies:** list, search, view; rename, deactivate / reactivate; create and
  re-point (ops admin, approval). The provider is chosen as "Provider A / Provider B"
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
- **Audit log:** view and filter by actor, target, action and date.

### What ops cannot do

- See or set anyone's password, authenticator key or recovery codes (a reset removes
  them; the person chooses new ones). There is no route for it.
- See balances, transactions, payees or payments; create, approve or cancel a payment or
  a conversion. The only call the console makes to a provider is "does this account
  exist" when a company is mapped.
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
that mailbox then controls the account.** Before asking for a reset, verify the person's
identity by a route that does not depend on the request itself (call back on a number
already on file, not one given in the email asking for the reset). The form will not
submit without a description of how identity was verified; that text is shown to the
approver and stored in the audit log with both staff members' names. The console cannot
check that the verification really happened.

### Audit log

`AuditLog` (`server/src/store/types.ts`) has `append`, `query` and `assertCapacity` and
nothing that changes or removes an entry.

Recorded, each with time, actor, target, action, outcome and source address:

- for clients and staff: activation, sign-in success and failure, lockout, step-up,
  sign-out, and sessions revoked by ops;
- for clients: company selection and **every money action** (create payment, approve,
  reject, add payee, book conversion), success and failure, with amount, currency, payee
  id and a hash of the idempotency key;
- every ops action that reached the console with a valid session and CSRF field, success
  and failure, with its target when one was identified; approval requests and decisions
  with both people;
- the operator commands (`invite`, `create-ops-admin`).

Not recorded: requests refused before that point (no session, wrong CSRF field, rate
limit), page views, expired sessions, and attempts with an unknown activation code.

It never contains a password, key, code or token (a test plants them and searches it).

Failures by someone who has not been identified (a wrong password for any email,
including a real one) go to a **separate stream**: the last 5,000 only, at most 20 a
minute per source address, the typed email cut to 80 characters, held in memory and not
written to the demo file. They can neither push anything out of the main log nor fill
it. So a password-guessing run against an account is visible there only in part; the
lockout it causes is in the same stream.

The main log does not drop entries. When it is full (100,000 entries in memory) the
server **refuses every state-changing request**, client and staff alike, until it is
restarted; reads keep working. That is the fail-safe choice and it is also a way to
stop the service, which is why a real deployment needs durable, write-once storage
with shipping and retention instead.

### Still not production-ready (ops console)

- **Email delivery:** there is a `Mailer` interface and no implementation that sends
  mail. The server will not start outside development without one.
- **A real database:** staff accounts, approval requests, the audit log and everything
  else are in memory (or the demo JSON file).
- **Who can reach `/ops`:** it is on the same port as the client API, open to anyone who
  can reach the server. It needs **IP allow-listing or a VPN, and staff SSO**.
- **Four-eyes is as described above and no more:** any second staff member can approve,
  there is no limit on how many requests one pair can pass, and no review of approvals
  after the fact.
- **Break-glass:** once two staff are active the bootstrap command refuses. If the last
  ops admin, or all staff but one, lose access, the only way back is editing storage.
- **Penetration testing:** an independent review found the issues fixed in this round;
  the fixes have tests but have not been re-reviewed or attacked.
- `ADMIN_TOKEN` is still one shared secret, now reachable only from the machine itself.

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
- **A mailer**: implement `Mailer` (`server/src/mailer.ts`) and pass it to
  `createRuntime(config, { mailer })`. Until both transports and a mailer are supplied
  the server refuses to start outside development mode.
- **Another provider**: implement `ProviderAdapter`, add its key to `ProviderKey` and a
  factory to the registry in `server/src/index.ts`.

### A real database

Implement `Directory`, `AuthStore`, `OpsStore`, `AuditLog` and the provider-key table
from `server/src/store/types.ts` and pass them to `buildApp`. (`store/file.ts` is not
that: it is the in-memory store written to a JSON file for the local demo.) The
interfaces include the atomic operations the security logic depends on
(`Table.mutate`, `Table.take`, `Directory.updateUser`, `OpsDirectory.update`): they must
be real transactions or compare-and-set, and attempt counters must be shared between
server instances. Other things the in-memory version gets away with that a database
must do properly: encrypt TOTP keys at rest; expire rows; move the issued-quote map
(`http/app.ts`, in memory and capped at 20,000 quotes, oldest dropped) into it; share
the rate-limit counters between server instances. Provider B's key→order map is already
behind a store table (`stores.providerKeys`), kept per company and outside the adapter,
so a booked conversion is still found by its key after the provider session is renewed.

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
forwards, no payment approvals) are a choice made for the demo, not a statement about
the real product. No rate history is offered, so no trend line is drawn.

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
- **Rate alerts**: stored on the device only. Nothing watches rates and no notification
  is ever sent.
- **App icon and splash**: the Expo template images.
- **Developer panel**: shown whenever the mock backend is active. Hide it before release.
- **Server storage**: in memory (optionally mirrored to a local JSON file for the demo),
  with a seed directory of made-up people and companies.
- **Both provider APIs**: in-memory mocks.
- **The in-app demo sign-in**: accepts anything; code `000000`.

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
- **Maker-checker for payments on the server.** The roles stop a `creator` approving and
  an `approver` creating, but a company `admin` can create a payment and then approve
  it, and the server does not check that the approver is a different person from the
  creator. That is left to the provider's approval rules, which the mock does not have.
  Whether and how to enforce it here is a product decision that has not been made.
- **Self-service account recovery**: password change and reset, re-enrolling an
  authenticator and regenerating recovery codes by the client. The only recovery is an
  ops reset (see "Ops console"), which replaces everything.
- **Ops console gaps**: see "Still not production-ready (ops console)". The operator
  commands (`invite`, `create-ops-admin`) are still guarded by one shared token, on a
  loopback-only listener.
- **Audit log storage**: in memory, bounded, refusing changes when full. See "Audit log".
  Reads (who looked at which balance) are not audited.
- **Secrets management**: credentials are plain environment variables; TOTP keys are
  held unencrypted in memory.
- **Database**: see "A real database". Everything is lost on restart unless the demo
  file store is on.
- **Hosting**: no TLS termination, deployment, monitoring, backups or multi-instance
  support. Rate limits and lockouts are per process. Behind a proxy set `TRUST_PROXY` to
  the proxy's address or range (or a hop count), or every client shares one address for
  rate limiting and lockout.
- **Penetration testing**: none. One independent code review was done and its findings
  fixed with regression tests (each confirmed to fail with its fix reverted); the fixes
  have not been re-reviewed. Response *content* is uniform across known and unknown
  emails and both paths do one scrypt verification, but timing was not measured. Someone
  who shares the owner's address, or who spreads 50 guesses over 50 addresses, can still
  lock an account for a while (see "Lockout").
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
