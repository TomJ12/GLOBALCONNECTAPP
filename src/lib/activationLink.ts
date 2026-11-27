/**
 * The single-use code carried by an activation link or a password-reset link.
 *
 * The link is `/activate#code=…` (or `/reset#code=…`): the code is in the
 * FRAGMENT, which a browser keeps to itself, so it is never sent to a server
 * and cannot end up in a request log, a proxy log or a Referer header.
 *
 * ONLY THE FRAGMENT IS READ. A `?code=` in the query string is ignored (the
 * server never writes one, and a link made that way would put the code into
 * every log on its way); on a device, where there is no address bar, the code
 * is typed.
 */
export function activationCodeFromLink(fragment: string | undefined | null): string {
  return /(?:^#|&)code=([A-Za-z0-9-]+)/.exec(fragment ?? '')?.[1] ?? '';
}

interface AddressBar {
  location?: { hash?: string; pathname?: string; search?: string };
  history?: { replaceState?: (data: unknown, unused: string, url?: string) => void };
}

/** The fragment of the page address on web; nothing on a device. */
export function currentFragment(): string {
  return (globalThis as AddressBar).location?.hash ?? '';
}

/** Takes the code out of the address bar, so it is not left there or in the browser history. A `code` in the query string is removed as well (it is never used). */
export function clearFragment(): void {
  const { location, history } = globalThis as AddressBar;
  if (!location || !history?.replaceState) return;
  const search = (location.search ?? '').replace(/([?&])code=[^&]*&?/g, '$1').replace(/[?&]$/, '');
  if (!location.hash && search === (location.search ?? '')) return;
  history.replaceState(null, '', `${location.pathname ?? ''}${search}`);
}

/**
 * The token of a "this was not me" link (`/cancel-reset#token=…`), read from the fragment and the address bar
 * wiped at once, like a code. It can only cancel one reset of an authenticator; it is still not left lying about.
 */
export function takeTokenFromAddressBar(): string {
  const token = /(?:^#|&)token=([A-Za-z0-9_.-]+)/.exec(currentFragment())?.[1] ?? '';
  clearFragment();
  return token;
}

/**
 * READ AND CLEARED IN ONE STEP: the code is taken from the address bar and the address bar is wiped at once,
 * before anything is sent anywhere, whether or not the code turns out to be good.
 */
export function takeCodeFromAddressBar(): string {
  const code = activationCodeFromLink(currentFragment());
  clearFragment();
  return code;
}
