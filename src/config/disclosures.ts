/**
 * Every fee, delivery time, regulatory statement and marketing claim shown in
 * the app comes from this file. They are BRACKETED PLACEHOLDERS on purpose:
 * the wording must be supplied and approved by Global Connect compliance.
 * Do not write real-looking values here and do not hard-code such text in a
 * screen. A test checks every value is still a bracketed placeholder.
 */
export const disclosures = {
  fee: '[YOUR FEE]',
  deliveryEstimate: '[DELIVERY ESTIMATE]',
  settlementTime: '[SETTLEMENT TIME]',
  paymentRoute: '[LOCAL / SWIFT]',
  regulatoryFooter: '[REGULATORY DISCLOSURE — payment and FX services provided by regulated partners]',
  accountProvider: '[REGULATORY DISCLOSURE — account provider]',
  rateSource: '[RATE DISCLOSURE — source and indicative status of rates]',
  forwardTerms: '[FORWARD CONTRACT TERMS — deposit, margin and cancellation]',
  alertDelivery: '[RATE ALERT DELIVERY — how and when alerts are sent]',
  openAccount: '[HOW TO OPEN AN ACCOUNT]',
  /** Marketing line on the sign-in screen. */
  signInTagline: '[SIGN-IN TAGLINE]',
  /** Any reassurance about how sign-in is protected. Do not describe it as "secure" in a screen. */
  signInAssurance: '[SIGN-IN SECURITY WORDING]',
} as const;

export type DisclosureKey = keyof typeof disclosures;
