/**
 * The server-side provider contract. It is the app's neutral ProviderClient
 * (the same file, not a copy) plus what the provider can do. One adapter
 * instance serves exactly one company and is built from that company's
 * directory entry; it has no way to be pointed at another company, and it
 * puts that company's scope (provider A: `on_behalf_of`, provider B:
 * `accountId`) on every call it makes. A company without that scope gets no
 * adapter at all.
 */
import type { ProviderClient } from '@/api/provider';
import type { Capabilities } from '@/api/types';

import type { CompanyRecord, ProviderKey } from '../store/types';

export interface ProviderAdapter extends ProviderClient {
  readonly capabilities: Capabilities;
}

export type ProviderMapping = Pick<CompanyRecord, 'providerAccountId' | 'providerContactId'>;

export interface ProviderFactory {
  /** Builds (and signs in) the adapter for one company. */
  forCompany(company: CompanyRecord): Promise<ProviderAdapter>;
  /** Asks the provider whether this account id (and contact) really exists. */
  accountExists(mapping: ProviderMapping): Promise<boolean>;
  /** True when this factory talks to the in-memory mock, not to the provider. */
  readonly mock: boolean;
}

/** Finds the adapter for a company from its directory entry. Adapters are built once and reused. */
export class ProviderRegistry {
  private readonly adapters = new Map<string, Promise<ProviderAdapter>>();

  constructor(private readonly factories: Partial<Record<ProviderKey, ProviderFactory>>) {}

  forCompany(company: CompanyRecord): Promise<ProviderAdapter> {
    let adapter = this.adapters.get(company.id);
    if (!adapter) {
      const factory = this.factories[company.providerKey];
      adapter = factory ? factory.forCompany(company) : Promise.reject(new Error('No adapter configured for this company'));
      this.adapters.set(company.id, adapter);
      // A failed sign-in must not be remembered.
      adapter.catch(() => this.adapters.delete(company.id));
    }
    return adapter;
  }

  async accountExists(providerKey: ProviderKey, mapping: ProviderMapping): Promise<boolean> {
    const factory = this.factories[providerKey];
    return factory ? factory.accountExists(mapping) : false;
  }

  /** The providers that are served by an in-memory mock. */
  mocked(): ProviderKey[] {
    return (Object.keys(this.factories) as ProviderKey[]).filter((key) => this.factories[key]?.mock);
  }

  /** Forget a company's adapter, so the next request signs in to the provider again. */
  invalidate(companyId: string): void {
    this.adapters.delete(companyId);
  }
}
