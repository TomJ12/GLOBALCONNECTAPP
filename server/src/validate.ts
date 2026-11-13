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
