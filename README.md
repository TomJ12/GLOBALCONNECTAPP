# Global Connect — client app and server

A mobile app for Global Connect business customers (multi-currency balances, account
details, payments with approval, spot and forward conversion, rates and rate alerts) and
the Global Connect server it signs in to.

**Nothing here is connected to a real provider or a real database. All data is sample
data, the provider APIs are in-memory mocks and server storage is in memory.** Fees,
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

This builds the web app with `EXPO_PUBLIC_API_URL=/` and starts the server, which serves
the web app **and** the API on one port (3001). Open `http://localhost:3001`. Because the
page and the API share an origin there are no cross-origin requests.

**GitHub Codespaces:** run the same command. The script reads `CODESPACE_NAME` and prints
the forwarded address (`https://<codespace>-3001.app.github.dev`); open it from the Ports
tab. The port can stay private. Activation links printed by the server use that address.
(Not run in a Codespace by us: see "Not production-ready and not verified".)

The server prints activation codes for the three sample users at start-up, in development
only (never when `NODE_ENV=production`):

| User | Company | Held at |
|---|---|---|
| `amira@northfield.example` | Northfield Trading Ltd | provider A (forwards, approvals) |
| `ben@castlebrook.example` | Castlebrook Imports Ltd | provider B (no forwards, no approvals) |
| `dana@adviser.example` | both | chooses a company after signing in |

To try it:

1. Open the app, press **Activate a new account** and type the code printed for a user
   (or open the printed activation link).
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

Everything is in memory: restarting the server forgets the accounts and prints new codes.

To invite again by hand (stands in for an admin tool and for email delivery), set
`ADMIN_TOKEN` in `server/.env` (see `server/.env.example`), restart the server and run
`npm --prefix server run invite -- amira@northfield.example`.

### Developing with live reload (two terminals)

```bash
npm run server                                         # API on :3001
EXPO_PUBLIC_API_URL=http://localhost:3001 npm run web  # app on :8081
```

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
npm test                 # node:test, 29 tests
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
    config.ts       environment -> settings (provider credentials, CORS, timeouts, flags)
    crypto.ts       scrypt passwords, TOTP (RFC 6238), base32, tokens
    auth/service.ts invitations, activation, login, lockout, sessions, step-up
    store/          types.ts (repository interfaces), memory.ts, seed.ts  <- PLACEHOLDER storage
    providers/
      adapter.ts          ProviderAdapter (= the app's ProviderClient + capabilities), registry
      currencycloud.ts    provider A: reuses src/api/adapters/currencycloud
      equals/             provider B: raw.ts, mockServer.ts, adapter.ts
    http/app.ts     the REST API
    cli/invite.ts   npm run invite -- <email>
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
companies, memberships with a role: `creator`, `approver` or `admin`; the seed file
stands in for an admin tool) and issue an activation code:

1. `POST /v1/activation/start {activationCode}` → email, name, password policy.
2. `POST /v1/activation/password {activationCode, password}` → policy check (12+
   characters, not on a short common-password list), scrypt hash held with the
   invitation, a new TOTP key returned as `otpauth://` URI and base32 text.
3. `POST /v1/activation/confirm {activationCode, code}` → needs a correct code from the
   authenticator; only then are password and key written to the user, the invitation is
   deleted and 10 one-time recovery codes are returned (stored as SHA-256 hashes).

Activation codes are random (100 bits), stored hashed, expire after 72 hours and are
replaced by a newer invitation. Unknown, expired and used codes get the same answer.

### Login

1. `POST /v1/auth/login {email, password}` → `{challengeId}`. Unknown email, wrong
   password and not-yet-activated account return the same body and status and each cost
   one scrypt verification (a dummy hash is checked when there is no account).
2. `POST /v1/auth/login/verify {challengeId, code, method: totp|recovery}` → an opaque
   session token (256 random bits; only its SHA-256 is stored), the user, their
   companies and, if there is exactly one company, the session. Otherwise
   `POST /v1/session/company {companyId}` selects one (only a company the person
   belongs to; anything else is `not_found`).

- **TOTP**: RFC 6238, SHA-1, 30 s, 6 digits (tested against the RFC vectors). The current
  step ±1 is accepted. The newest accepted step is stored per user and any code at or
  before it is refused, so a code cannot be replayed, including across login and step-up.
- **Lockout**: failures are counted per email (password) and per user (codes), whether or
  not the account exists. After 5 failures the check is refused for 1 minute, doubling
  with each further failure up to 1 hour; success clears the count. A challenge is spent
  after 5 wrong codes or 5 minutes. On top of that, each address gets 30 requests a
  minute on the sign-in, activation and step-up routes.
- **Sessions**: 15 minutes idle, 12 hours absolute, revoked by `POST /v1/auth/logout`.
  Membership is re-read on every request.
- **Logging**: method, URL and status only. Bodies and headers are never logged; no
  secret appears in a URL.

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
- Each adapter instance is built for one company and puts that company's provider
  account id on its calls itself.
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
  then a company picker when there are several. Activation: `/activate` (or
  `/activate?code=...` from the link).
- The session token lives in memory inside the API client. Nothing that can start a
  session is stored on the device; closing the app or reloading the page signs you out.
- Sign-out revokes the session on the server, clears cached data and deletes that user's
  saved rate alerts. The one thing that can remain on the device is the pending record of
  a money movement whose outcome is still unknown (key and signature, per user).
- After 2 minutes in the background (`INACTIVITY_LOCK_MS`) the app signs out. There is no
  device unlock of any kind.

## Replacing the placeholders

### A real provider adapter

- **Provider A**: write a `Transport` (`src/api/adapters/currencycloud/transport.ts`)
  that calls the provider over HTTPS (`params` as a query string for GET and form data
  for POST, the token in `X-Auth-Token`; resolve for any HTTP status, reject only when no
  response arrives) and pass it as `transportFor` to `currencycloudFactory` in
  `server/src/index.ts`. The client must also send `on_behalf_of` with the company's
  contact id on every call so one set of API credentials acts for the right client; it
  does not do that yet. The rate-history endpoint is not part of the provider API.
- **Provider B**: write an `EqualsTransport` (`server/src/providers/equals/raw.ts`) and
  pass it as `transportFor` to `equalsFactory`. Then go through `raw.ts` and replace
  every shape marked INVENTED with the documented one.
- **Another provider**: implement `ProviderAdapter`, add its key to `ProviderKey` and a
  factory to the registry in `server/src/index.ts`.

### A real database

Implement `Directory` and `AuthStore` from `server/src/store/types.ts` and pass them to
`buildApp`. Things the in-memory version gets away with that a database must do properly:
encrypt TOTP keys at rest; make "accept this TOTP step" and "spend this step-up token"
atomic (compare-and-set), since two simultaneous requests could both pass today; expire
rows; move the issued-quote map (`http/app.ts`) and provider B's key→order map
(`equals/adapter.ts`) into it; share the rate-limit and lockout counters between server
instances.

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
- **Server storage**: in memory, with a seed directory of made-up people and companies.
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

- **Email delivery** of activation links. Codes are printed to the console in development
  and returned by the `invite` command.
- **Account recovery** when a phone and the recovery codes are both lost; password
  change and reset; re-enrolling an authenticator; regenerating recovery codes. An
  activated account cannot be re-invited.
- **Admin tool**: users, companies, memberships and roles exist only as seed data. The
  `/admin/invites` endpoint guarded by one shared token is a stand-in, not a design.
- **Audit log**: no record of sign-ins, step-ups or money actions is kept.
- **Secrets management**: credentials are plain environment variables; TOTP keys are
  held unencrypted in memory.
- **Database**: see "A real database". Everything is lost on restart.
- **Hosting**: no TLS termination, deployment, monitoring, backups or multi-instance
  support. Rate limits and lockouts are per process. Behind a proxy set `TRUST_PROXY=1`
  or every client shares one address for rate limiting.
- **Penetration testing and security review**: none. The login design follows common
  practice but nobody independent has attacked it. Response *content* is uniform across
  known and unknown emails and both paths do one scrypt verification, but timing was not
  measured. Lockout by email lets someone who knows an address lock its owner out.
- **Provider approval**: no provider has reviewed or approved this flow, the step-up as
  their required customer authentication, or the use of their API in this way.
- The common-password list is about twenty entries.

Not verified by us:

- GitHub Codespaces: `npm run demo` was run locally only.
- The web app driven in a browser against the server: the server flow was exercised
  with a script over HTTP and the screens with Jest against the in-app demo.
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
