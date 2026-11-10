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

On a phone: `npx expo start`, then scan the QR code with Expo Go. Face ID in Expo Go on
iOS is limited; for the real prompt make a development build (`npx expo run:ios`).

Sign in with any email address, then press **Complete the link** (a developer shortcut:
the mock sends no email).

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

1. **Developer panel**: Home → avatar → *Profile and settings*. Also linked from the
   sign-in screen, so you can undo a forced error that has signed you out.
2. **Environment variables** at start/build time (see `.env.example`):

   | Variable | Meaning | Default |
   |---|---|---|
   | `EXPO_PUBLIC_MOCK_LATENCY_MS` | delay on every request | 350 |
   | `EXPO_PUBLIC_MOCK_FAILURE_RATE` | 0–1 chance of a network error or 500 | 0 |
   | `EXPO_PUBLIC_MOCK_FORCE_ERROR` | `none`, `network`, `unauthorized` (401), `rate_limited` (429), `server` (500), `malformed` (broken JSON), `wrong_shape` (valid JSON, wrong fields) | none |
   | `EXPO_PUBLIC_MOCK_QUOTE_TTL_S` | how long a quote is held | 30 |
   | `EXPO_PUBLIC_MOCK_OFFLINE` | `1` starts offline | 0 |
   | `EXPO_PUBLIC_EXPOSE_DEV_GLOBALS` | `1` exposes `globalThis.__GC_DEV__` in a production build | 0 |

3. **`globalThis.__GC_DEV__`** (dev builds, or with the variable above):
   `setControls({ forcedError: 'rate_limited' })`, `getControls()`, `resetControls()`,
   `resetSampleData()`.

Mock state lasts for the JS session: a conversion moves balances, an approved payment
leaves the pending list and appears in activity. Reloading the page resets it.

## Architecture

```
src/
  app/            expo-router routes only (thin files that export a screen)
  screens/        one component per screen
  components/     UI kit (AppText, Button, Card, Screen, QueryState, ...)
  hooks/          queries.ts (all server state), useHeldQuote, useSingleFlight
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
  lib/            money, quote expiry, validation, dates, biometrics, online, storage
  state/          session, devSettings, confirm dialog, toast
  theme/          brand tokens
```

Rules the code follows:

- Screens never import an adapter. They use hooks in `src/hooks/queries.ts`, which call
  `getProviderClient()`.
- Every response is parsed with zod in `client.ts`. Broken JSON or a wrong shape becomes
  `ProviderError('malformed_response')`, never a crash.
- Raw provider error text is never shown. `ProviderError.userMessage` is our own wording.
- Queries retry once for retryable errors. **Mutations never retry and are never queued
  offline.** Every money-moving button goes through `useSingleFlight` (a ref lock, so a
  double tap in one frame is ignored) and sends an idempotency key.
- `confirmWithBiometrics()` (`src/lib/biometrics.ts`) is the one helper for unlock and
  for approving money movements. On web, or with no biometrics enrolled, it falls back to
  an in-app confirm dialog.
- A 401 from any request signs the user out; sign-out clears the query cache.

## Replacing the mock adapter with a real one

1. Write a `Transport` (`src/api/adapters/currencycloud/transport.ts`) that calls the
   provider over HTTPS: `params` as a query string for GET and form data for POST, the
   token in `X-Auth-Token`. Resolve for any HTTP status; reject only when no response
   arrives.
2. In `src/api/index.ts`, change `createProviderBackend()` to return
   `new CurrencycloudClient(yourTransport, { planName })` with `isMock: false`.
   That is the only file the rest of the app depends on.
3. Replace the parts marked **NOT PART OF THE PROVIDER API** (below) with real services.

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
| Magic-link sign-in, device credential (`/v2/authenticate/magic_link/*`, `/v2/authenticate/device`) | **Not part of the provider API.** The provider logs in with `login_id` + `api_key`. Global Connect needs its own auth service. |
| Rate history for sparklines (`/v2/rates/history`) | **Not part of the provider API.** Invented endpoint, synthetic points. Needs a market-data source. |
| Error codes `quote_expired` and `insufficient_funds` | Invented by the mock. The public spec does not list the real codes. |
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

## Compliance guards

- No provider name appears in UI code. `src/test/compliance.test.ts` scans the UI
  folders for provider names and for fee/timing/regulatory claims.
- No analytics and no third-party network calls. Inter is bundled with the app, so there
  is no runtime font request either.
- No secrets in the repo. The `EXPO_PUBLIC_*` variables are developer switches.

## Known limits

- The session token lives in memory, so a reload signs you out (quick unlock restores it).
- On web the quick-unlock credential is in local storage. Acceptable for a mock
  credential only; a real web build needs a server-managed session.
- The web/no-biometrics fallback is a confirm dialog, not strong authentication.
- Forward settlement dates skip weekends but not bank holidays.
- Not run on a physical iOS or Android device in this environment; see the build report.
