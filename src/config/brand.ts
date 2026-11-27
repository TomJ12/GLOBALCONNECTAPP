/**
 * Brand wording approved by Global Connect for display in the app.
 *
 * Unlike `disclosures.ts`, these are final lines, not placeholders. Anything
 * about fees, timing, regulation or how sign-in is protected does NOT belong
 * here: it stays a bracketed placeholder in `disclosures.ts` until approved.
 */
export const brand = {
  /** Headline on the sign-in screen (the company's existing website headline). */
  signInHeadline: 'Connecting Businesses Globally',
  /** Supporting line under the sign-in headline. */
  signInSupporting: 'Sign in to manage your currency accounts.',
} as const;
