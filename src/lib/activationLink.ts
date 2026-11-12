/**
 * The activation code carried by an activation link.
 *
 * The link is `/activate#code=…`: the code is in the fragment, which a browser
 * keeps to itself, so it is never sent to a server and cannot end up in a
 * request log. A `?code=` parameter (how a deep link hands it to the app) is
 * still read, but the server does not put one in a link.
 */
export function activationCodeFromLink(queryCode: unknown, fragment: string | undefined | null): string {
  const fromFragment = /(?:^#|&)code=([A-Za-z0-9-]+)/.exec(fragment ?? '')?.[1];
  if (fromFragment) return fromFragment;
  return typeof queryCode === 'string' ? queryCode : '';
}

interface AddressBar {
  location?: { hash?: string; pathname?: string; search?: string };
  history?: { replaceState?: (data: unknown, unused: string, url?: string) => void };
}

/** The fragment of the page address on web; nothing on a device. */
export function currentFragment(): string {
  return (globalThis as AddressBar).location?.hash ?? '';
}

/** Takes the code out of the address bar once it has been read, so it is not left in the browser history. */
export function clearFragment(): void {
  const { location, history } = globalThis as AddressBar;
  if (!location?.hash || !history?.replaceState) return;
  history.replaceState(null, '', `${location.pathname ?? ''}${location.search ?? ''}`);
}
