/** App-level settings that are not brand tokens and not customer-facing disclosures. */

/** Currency the Home total is shown in. */
export const BASE_CURRENCY = 'GBP';

/**
 * Currencies offered in pickers. SAMPLE LIST: a real build should load this
 * from the provider's reference data for the customer's account.
 */
export const SUPPORTED_CURRENCIES: readonly string[] = ['GBP', 'USD', 'EUR', 'AED', 'JPY'];

/** Pairs on the Rates watchlist: [base, quote]. */
export const WATCHLIST_PAIRS: readonly (readonly [string, string])[] = [
  ['GBP', 'USD'],
  ['GBP', 'EUR'],
  ['EUR', 'USD'],
  ['GBP', 'AED'],
];

/** SAMPLE plan label. The provider has no plan concept; this comes from Global Connect. */
export const SAMPLE_PLAN_NAME = 'Business Standard';

/** Forward settlement choices, in months from today. */
export const FORWARD_TENORS_MONTHS: readonly number[] = [1, 3, 6, 12];

export const APP_NAME = 'Global Connect';

/**
 * After a payment or conversion whose outcome is unknown (no answer, timeout),
 * the request may still be on its way to being applied. The app keeps checking
 * for this long before it lets the customer try again, and never says "nothing
 * happened" on the strength of one early check.
 *
 * PLACEHOLDER VALUES: [PROCESSING WINDOW — confirm with the provider how long a
 * timed-out request can still be applied]. Mutable so tests can shorten them.
 */
export const outcomeCheckTiming = {
  /** How long to keep the form blocked and keep checking. */
  windowMs: 90_000,
  /** How often to check within the window. */
  intervalMs: 5_000,
};
