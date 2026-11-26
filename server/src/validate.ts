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
 *   skype:someone, geo:51.5,0   ->  skype[:]someone, geo[:]51.5,0   (ANY "word:" followed by something)
 *   192.168.1.10/login          ->  192[.]168[.]1[.]10/login
 *
 * FIRST the text is put in one form: compatibility characters are folded (full-width letters, the one-dot leader
 * and the ideographic full stop become their plain equivalents) and characters that cannot be seen (zero-width,
 * direction controls, the soft hyphen) are removed, so that "evil．com" or "evil<zero-width>.com" is matched as
 * what a client would make of it. One pass is enough and running it again changes nothing (both are tested):
 * every replacement only inserts brackets, which join nothing together. Amounts and ordinary sentences are left
 * alone ("125.00", "Ltd. Thanks", "at 10:30").
 * This is the ONE function for it: every notification and email line that carries typed text goes through it.
 */
const UNSEEN = /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0]/g;
export function plainText(value: string | null | undefined, max = 200): string {
  const text = singleLine((value ?? '').normalize('NFKC').replace(UNSEEN, '').replace(/[\u3002\uFF61]/g, '.'));
  return (
    text
      // A scheme: any "word:" directly followed by a slash or backslash...
      .replace(/:(?=[/\\])/g, '[:]')
      // ...any word that starts with a letter, then a colon, then anything that is not a space (skype:, geo:, magnet:)...
      .replace(/([a-z][a-z0-9+.-]*):(?=[^\s\]])/gi, '$1[:]')
      // ...and the well-known ones even with a space before the colon.
      .replace(/\b(mailto|tel|sms|callto|javascript|data|file|ftp|https?|wss?)\s*:(?!\])/gi, '$1[:]')
      // An address: something@something.
      .replace(/@(?=[\p{L}\p{N}])/gu, '[@]')
      // A numeric address with a path or a port: dotted digits followed by a slash, a backslash or a colon.
      .replace(/\d+(?:\.\d+)+(?=[/\\:[])/g, (digits) => digits.replace(/\./g, '[.]'))
      // A host name: a dot between a letter or digit and a letter ("pay.example", "www.pay"); not "125.00" or "Ltd. ".
      .replace(/(?<=[\p{L}\p{N}-])\.(?=\p{L})/gu, '[.]')
      .slice(0, max)
  );
}
