/** Input checks shared by the ops console, the operator commands and the mailer. */

/**
 * A plain address: letters, digits and . _ % + - before the @, a dotted host
 * name after it. No quotes, brackets, spaces or control characters, so an
 * address can be shown and put in a mail header as it is.
 */
export function isEmail(value: string): boolean {
  if (value.length > 254 || value.includes('..')) return false;
  return /^[A-Za-z0-9](?:[A-Za-z0-9._%+-]{0,62}[A-Za-z0-9_%+-])?@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/.test(value);
}

export const emailDomain = (email: string): string => email.slice(email.lastIndexOf('@') + 1).toLowerCase();

/** Control characters, including new lines and tabs, and the Unicode line and paragraph separators. */
const CONTROL = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]');
export const hasControlCharacters = (value: string): boolean => CONTROL.test(value);

/** For text that goes into a mail body or header: anything that could start a new line becomes a space. */
export const singleLine = (value: string): string => value.replace(new RegExp(CONTROL.source, 'g'), ' ').replace(/\s+/g, ' ').trim();

/** How names are compared for "is this the same company": case, accents-as-typed and spacing do not make a new name. */
export const nameKey = (name: string): string => name.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * TEXT THAT A PERSON TYPED (a reason, a payee's name, a colleague's name), made safe to show to SOMEBODY ELSE in a
 * notification, an email or a page: one line, bounded, and with nothing left that a mail client or an app would
 * turn into a working link. It is not removed, it is BROKEN VISIBLY, so the reader still sees what was written:
 *
 *   https://pay.example/login   ->  https[:]//pay[.]example/login
 *   www.pay.example/verify      ->  www[.]pay[.]example/verify
 *   someone@pay.example         ->  someone[@]pay[.]example
 *   mailto:x, tel:+44...        ->  mailto[:]x, tel[:]+44...
 *
 * Applied until nothing changes, so that removing one thing can never put another together (the trick of nesting
 * "https:/a:///" inside a scheme). Amounts and ordinary sentences are left alone ("125.00", "Ltd. Thanks").
 * This is the ONE function for it: every notification and email line that carries typed text goes through it.
 */
export function plainText(value: string | null | undefined, max = 200): string {
  let text = singleLine(value ?? '');
  for (let pass = 0; pass < 8; pass += 1) {
    const next = text
      // A scheme: any "word:" directly followed by a slash or backslash, and the schemes that need no slashes.
      .replace(/:(?=[/\\])/g, '[:]')
      .replace(/\b(mailto|tel|sms|callto|javascript|data|file|ftp|https?|wss?)\s*:(?!\])/gi, '$1[:]')
      // An address: something@something.
      .replace(/@(?=[\p{L}\p{N}])/gu, '[@]')
      // A host name: a dot between a letter or digit and a letter ("pay.example", "www.pay"); not "125.00" or "Ltd. ".
      .replace(/(?<=[\p{L}\p{N}-])\.(?=\p{L})/gu, '[.]');
    if (next === text) break;
    text = next;
  }
  return text.slice(0, max);
}
