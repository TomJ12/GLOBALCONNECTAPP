import fs from 'fs';
import path from 'path';

import { disclosures } from '@/config/disclosures';

const SRC = path.resolve(__dirname, '..');
/** Provider names may appear in adapter code and tests, never in anything that renders. */
const UI_DIRS = ['app', 'components', 'screens', 'config', 'state', 'hooks', 'lib', 'theme', 'alerts'];
const PROVIDER_NAMES = /currency\s?cloud|equals|ibanfirst|sciopay|gc partners|barclays|universe money|visa\b/i;

function filesUnder(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : filesUnder(full);
    return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
  });
}

describe('compliance guards', () => {
  it('never names a provider in UI code', () => {
    const offenders: string[] = [];
    for (const dir of UI_DIRS) {
      for (const file of filesUnder(path.join(SRC, dir))) {
        fs.readFileSync(file, 'utf8')
          .split('\n')
          .forEach((line, index) => {
            if (PROVIDER_NAMES.test(line)) offenders.push(`${path.relative(SRC, file)}:${index + 1}`);
          });
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps every disclosure as a bracketed placeholder', () => {
    for (const value of Object.values(disclosures)) {
      expect(value).toMatch(/^\[[^\[\]]+\]$/);
    }
  });

  it('does not hard-code fee, timing, rate or regulatory claims anywhere in UI code', () => {
    const claims =
      /\b(no fees?|free of charge|instantly|same[- ]day|within \d+ (minutes|hours|days)|FCA|regulated by|authorised by|safeguard|live rates?|real[- ]time|guaranteed|best rate|mid[- ]market|secure|encrypted)/i;
    const offenders: string[] = [];
    for (const dir of UI_DIRS) {
      // config/disclosures.ts is where such wording lives, as bracketed placeholders checked above.
      for (const file of filesUnder(path.join(SRC, dir)).filter((name) => !name.endsWith(path.join('config', 'disclosures.ts')))) {
        fs.readFileSync(file, 'utf8')
          .split('\n')
          .forEach((line, index) => {
            // Only text a customer could see: skip comment lines.
            if (!/^\s*(\/\/|\*|\/\*)/.test(line) && claims.test(line)) offenders.push(`${path.relative(SRC, file)}:${index + 1}`);
          });
      }
    }
    expect(offenders).toEqual([]);
  });

  it('has no biometric, Face ID or quick-unlock code, copy or dependency left', () => {
    const banned = /face\s?id|touch\s?id|biometr|fingerprint|quick unlock|local-authentication|secure-store|deviceCredential/i;
    const root = path.resolve(SRC, '..');
    const files = filesUnder(SRC).concat(['package.json', 'app.json', 'README.md'].map((name) => path.join(root, name)));
    const offenders = files
      .filter((file) => !file.endsWith('compliance.test.ts'))
      .filter((file) => banned.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(root, file));
    expect(offenders).toEqual([]);
  });
});
