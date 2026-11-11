# Global Connect — client app (front end, mock backend)

A mobile app for Global Connect business customers: multi-currency balances, account
details, payments with approval, spot and forward conversion, rates and rate alerts.

**Everything runs against an in-memory mock. No real API is connected and all data is
sample data.** Fees, delivery times and regulatory wording are bracketed placeholders.

- Expo SDK 58, React Native 0.88, TypeScript strict, expo-router
- Runs on iOS, Android and web
- TanStack Query for server state, zustand for session and developer settings
- big.js for all money and rate arithmetic (amounts are decimal strings, never floats)
- zod validation of every backend response

## Run it

```bash
npm install
npm run web        # browser
npm run ios        # iOS simulator (macOS) or Expo Go
npm run android    # Android emulator or Expo Go
```

On a phone: `npx expo start`, then scan the QR code with Expo Go.

Sign in with any email address, then either press **Complete the link** (a developer
shortcut shown only on the mock, which sends no email) or type the code
`SAMPLE-LINK-CODE`. The emailed link itself opens
`globalconnect://magic-link?request=<id>&code=<code>` (`/magic-link?...` on web), handled
by `src/app/magic-link.tsx`.

### Checks

```bash
npx tsc --noEmit         # typecheck
npx expo lint            # ESLint
npx jest                 # unit and screen tests
npx expo export -p web   # static web build in dist/
```

Serve the web build with any static server that falls back to `index.html`, for example
`npx serve -s dist`.

## Driving the mock (for testing)

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
src/
  app/            expo-router routes only (thin files that export a screen)
  screens/        one component per screen
  components/     UI kit (AppText, Button, Card, Screen, QueryState, ...)
  hooks/          queries.ts (all server state), useHeldQuote, useOutcomeCheck, useSingleFlight
  api/
    types.ts      provider-NEUTRAL domain types
    provider.ts   ProviderClient interface
    errors.ts     ProviderError: the only error type that leaves the API layer
    index.ts      THE one factory that picks the backend
    mockControls.ts
    adapters/
      currencycloudMock.ts        wires the client to the in-memory server
      currencycloud/
        raw.ts         zod schemas of the wire shapes
        mapping.ts     raw -> neutral (pure, tested)
        client.ts      ProviderClient over a Transport (validates, maps)
        transport.ts   the seam: request in, status + body text out
        mockServer.ts  in-memory backend with sample data
  alerts/         AlertsStore interface + local (on-device) implementation
  config/         disclosures.ts (all placeholder wording), app.ts, env.ts
  lib/            money, quote expiry, validation, dates, confirmAction, inactivity, online
  state/          session, devSettings, confirm dialog, toast
  theme/          brand tokens
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

**Second-factor seam.** `confirmAction()` is the single place a real second factor plugs
in. Today it is only an in-app confirm step, which is **not** strong customer
authentication. Payments will need a real second factor, as the provider and regulation
require; add it inside `confirmAction()` and every money action picks it up. It has not
been built.

### Sign-in and sessions

- Sign-in is an emailed link or code every time. There is no device unlock of any kind.
- **A link only works on the device that asked for it.** When a link is requested the
  device makes up a random secret (`expo-crypto`), sends it with the request and keeps it
  in device storage until sign-in completes; verification needs the same secret. A link
  opened anywhere else is refused before anything is sent.
- **A link never replaces a session silently.** If someone is already signed in, the
  deep-link screen asks: stay signed in, or sign out and use the link.
- Nothing that can start a session is stored on the device. The session token lives in
  memory only, so closing the app or reloading the page signs you out.
- Sign-out ends the provider session, clears cached data, deletes that user's saved rate
  alerts and any unfinished sign-in secret. With no money movement in doubt, device
  storage is empty afterwards. The one thing that can remain is the pending record of a
  money movement whose outcome is still unknown (key and signature, per user).
- After 2 minutes in the background (`INACTIVITY_LOCK_MS`) the app signs out and returns
  to the email sign-in. Because sign-out deletes alerts, alerts do not survive this
  either. That is the current default pending a product decision. On web, `AppState`
  only fires when the tab is hidden and shown again.

## Replacing the mock adapter with a real one

1. Write a `Transport` (`src/api/adapters/currencycloud/transport.ts`) that calls the
   provider over HTTPS: `params` as a query string for GET and form data for POST, the
   token in `X-Auth-Token`. Resolve for any HTTP status; reject only when no response
   arrives.
2. In `src/api/index.ts`, change `createProviderBackend()` to return
   `new CurrencycloudClient(yourTransport, { planName })` with `isMock: false`.
   That is the only file in the app that names an adapter.
3. Replace the parts marked **NOT PART OF THE PROVIDER API** (below) with real services.
   This is real work, not a one-line change: sign-in needs a Global Connect auth service
   that emails the link/code and answers the two `magic_link` endpoints, and the
   sparklines need a rate-history source. The sign-in screen and the deep-link route
   already work against any backend that implements `requestMagicLink` and
   `verifyMagicLink`; only the "Complete the link" shortcut is mock-only, and it is
   hidden when the backend does not supply a `devCode`.

In practice a mobile app must not hold provider API keys, so the real transport should
talk to a Global Connect backend that proxies the provider. The interface does not change.

For a different provider, implement `ProviderClient` directly and return it from the same
factory.

## How closely the mock follows Currencycloud

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
| Magic-link sign-in (`/v2/authenticate/magic_link/request`, `/verify`, with a `device_secret`) | **Not part of the provider API.** The provider logs in with `login_id` + `api_key`. Global Connect needs its own auth service, which must also enforce the device secret. |
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
- **Confirmation of money movements**: an in-app confirm step only. See "Second-factor seam".

## Compliance guards

`src/test/compliance.test.ts` scans every UI folder (`app`, `components`, `screens`,
`config`, `state`, `hooks`, `lib`, `theme`, `alerts`) and fails if it finds:

- a provider name;
- the words "secure" or "encrypted" in customer-visible lines;
- fee, timing, rate or regulatory claims in customer-visible lines ("instantly",
  "live rates", "real-time", "guaranteed", "FCA", ...). Such wording belongs in
  `src/config/disclosures.ts`, and every value there must stay a bracketed placeholder;
- any leftover device-unlock code, copy or dependency (the feature was removed).

Also: no analytics and no third-party network calls (Inter is bundled, so there is no
runtime font request), and no secrets in the repo (the `EXPO_PUBLIC_*` variables are
developer switches).

## Known limits

- **No second factor.** Money movements are confirmed by a tap in an in-app dialog.
- **Not run on a physical or simulated iOS or Android device.** Verified with Jest and by
  driving the exported web build in headless Chrome.
- **The processing window is a guess.** `outcomeCheckTiming` (90 s) must be set from what
  the provider says about how late a timed-out request can still be applied. If a request
  lands after the window, the app will have released the form. Retrying the *same*
  payment or conversion in the same visit reuses its key and is safe; a changed amount
  after that could produce two movements.
- **Approve and reject are not recorded before sending**, only payments and conversions.
  They are safe to repeat, and the review screen re-reads the payment before acting.
- **Sign-in wording.** The button now reads "Send login link". The brief's "Send secure
  login link" was removed because "secure" is a claim; the tagline and any assurance
  wording are placeholders in `disclosures.ts`.
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
