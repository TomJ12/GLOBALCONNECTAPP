/**
 * SAMPLE DIRECTORY. Stands in for the admin tool operations would use to
 * create companies and invite people. Every person and company is made up;
 * the email domains are reserved example domains.
 */
import type { UserRole } from '@/api/types';

import type { DirectoryData } from './memory';
import type { UserRecord } from './types';

function invited(id: string, email: string, name: string): UserRecord {
  return { id, email, name, passwordHash: null, totpSecret: null, lastTotpStep: 0, recoveryCodeHashes: [], activatedAt: null };
}

const member = (userId: string, companyId: string, role: UserRole) => ({ userId, companyId, role });

export function seedDirectory(): DirectoryData {
  return {
    companies: [
      {
        id: 'co_northfield',
        name: 'Northfield Trading Ltd',
        providerKey: 'currencycloud',
        providerAccountId: 'sample-account-0001',
        providerContactId: 'sample-contact-0001',
      },
      {
        id: 'co_castlebrook',
        name: 'Castlebrook Imports Ltd',
        providerKey: 'equals',
        providerAccountId: 'S00001',
        providerContactId: 'sample-person-0001',
      },
    ],
    users: [
      invited('usr_amira', 'amira@northfield.example', 'Amira Shah'),
      invited('usr_ben', 'ben@castlebrook.example', 'Ben Okoro'),
      invited('usr_dana', 'dana@adviser.example', 'Dana Reid'),
    ],
    memberships: [
      member('usr_amira', 'co_northfield', 'admin'),
      member('usr_ben', 'co_castlebrook', 'admin'),
      member('usr_dana', 'co_northfield', 'admin'),
      member('usr_dana', 'co_castlebrook', 'admin'),
    ],
  };
}
