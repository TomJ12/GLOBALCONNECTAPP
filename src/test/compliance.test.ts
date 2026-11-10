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

  it('does not hard-code fee or timing claims in screens', () => {
    const claims = /\b(no fees?|free of charge|instantly|same[- ]day|within \d+ (minutes|hours|days)|FCA|regulated by|authorised by|safeguard)/i;
    const offenders = filesUnder(path.join(SRC, 'screens'))
      .concat(filesUnder(path.join(SRC, 'components')))
      .filter((file) => claims.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(SRC, file));
    expect(offenders).toEqual([]);
  });
});
