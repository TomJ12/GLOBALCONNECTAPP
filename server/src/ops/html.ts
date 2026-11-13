/** Tiny HTML templating for the ops console: everything interpolated is escaped unless it is already Html. */
import createQr from 'qrcode-generator';

export class Html {
  constructor(readonly text: string) {}
  toString(): string {
    return this.text;
  }
}

export const esc = (value: unknown): string =>
  String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] as string);

type Part = Html | string | number | null | undefined | false | Part[];
const render = (part: Part): string => (Array.isArray(part) ? part.map(render).join('') : part instanceof Html ? part.text : part === false ? '' : esc(part));

export function h(strings: TemplateStringsArray, ...values: Part[]): Html {
  return new Html(strings.reduce((out, text, index) => out + text + (index < values.length ? render(values[index]) : ''), ''));
}

export const when = (at: number | null | undefined): string => (at ? `${new Date(at).toISOString().slice(0, 19).replace('T', ' ')} UTC` : 'never');

/** QR code as inline SVG (no script, no inline style, no external request). */
export function qrSvg(text: string): Html {
  const qr = createQr(0, 'M');
  qr.addData(text);
  qr.make();
  const size = qr.getModuleCount();
  let path = '';
  for (let row = 0; row < size; row += 1) for (let col = 0; col < size; col += 1) if (qr.isDark(row, col)) path += `M${col + 2} ${row + 2}h1v1h-1z`;
  return new Html(
    `<svg class="qr" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size + 4} ${size + 4}" width="220" height="220" role="img" aria-label="QR code for the authenticator app"><rect width="100%" height="100%" fill="#fff"/><path d="${path}" fill="#0F172A"/></svg>`,
  );
}

export interface Chrome {
  title: string;
  /** Signed-in staff member, or null on the sign-in and activation pages. */
  user: { name: string; role: string } | null;
  csrf: string;
  flash?: string;
}

export function layout(chrome: Chrome, body: Html): string {
  const nav = chrome.user
    ? h`<nav><a href="/ops/companies">Companies</a><a href="/ops/users">Client users</a><a href="/ops/approvals">Approvals</a><a href="/ops/audit">Audit log</a>${
        chrome.user.role === 'ops_admin' && h`<a href="/ops/staff">Ops staff</a>`
      }<span class="who">${chrome.user.name} · ${chrome.user.role === 'ops_admin' ? 'Ops admin' : 'Ops'}</span><form method="post" action="/ops/logout"><input type="hidden" name="_csrf" value="${chrome.csrf}"><button class="link">Sign out</button></form></nav>`
    : h``;
  return h`<!doctype html>
<html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>${chrome.title} · Global Connect Ops</title><link rel="stylesheet" href="/ops/static/ops.css"><script src="/ops/static/ops.js" defer></script></head>
<body><header><a class="brand" href="/ops"><img src="/ops/static/logo.png" alt="" width="26" height="29">Global Connect <span>Ops</span></a>${nav}</header>
<main>${chrome.flash && h`<p class="flash" role="status">${chrome.flash}</p>`}<h1>${chrome.title}</h1>${body}</main></body></html>`.text;
}
