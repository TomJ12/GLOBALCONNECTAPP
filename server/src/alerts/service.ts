/**
 * RATE ALERTS, kept and checked by the server.
 *
 * An alert says: "tell me when I can SELL (or BUY) the base currency of this pair at this rate or better". It
 * belongs to one person in one company and is checked against THAT COMPANY'S CLIENT RATE (the provider's rate
 * with the company's margin, rates/service.ts): the same indicative rate the person sees on the Rates screen.
 *
 *   sell  fires when the client's sell rate is at or ABOVE the target
 *   buy   fires when the client's buy rate is at or BELOW the target
 *
 * IT FIRES ONCE. A fired alert is `triggered` and is not looked at again until its owner turns it on again.
 * Checking again after a restart cannot fire it twice: the notification is made under a key of the alert and the
 * moment it was last turned on (notify/notifier.ts makes one notification per key), and only then is the alert
 * marked triggered; a crash in between repeats the first step, which then does nothing.
 *
 * ONE RATE FETCH PER PROVIDER AND PAIR PER CHECK, however many companies and alerts want it; the margin is then
 * applied per company.
 *
 * What a notification says is indicative, and says so. It promises nothing.
 */
import Big from 'big.js';

import type { RatePair } from '@/api/types';

import { randomToken } from '../crypto';
import { ApiError } from '../errors';
import type { ProviderAdapter } from '../providers/adapter';
import type { MarginConfig } from '../rates/margin';
import type { ClientRates } from '../rates/service';
import type { AuditInput, CompanyRecord, RateAlertRecord, Stores, UserRecord } from '../store/types';
import { noteOf, type Notifier } from '../notify/notifier';

/** What the app is given for one alert. */
export interface AlertView {
  id: string;
  base: string;
  quote: string;
  side: 'sell' | 'buy';
  targetRate: string;
  status: RateAlertRecord['status'];
  createdAt: string;
  triggeredAt: string | null;
  /** The person's own rate that set it off. */
  triggeredRate: string | null;
}

export interface AlertsDeps {
  stores: Pick<Stores, 'alerts' | 'directory'>;
  rates: ClientRates;
  notifier: Notifier;
  now: () => number;
  /** Most alerts one person can have, across all their companies. */
  perUser: number;
  /** Runs a call against the company's provider. */
  withProvider: <T>(company: CompanyRecord, run: (provider: ProviderAdapter) => Promise<T>) => Promise<T>;
  onError?: (message: string) => void;
}

const TARGET = /^(0|[1-9]\d{0,8})(\.\d{1,6})?$/;
const view = (record: RateAlertRecord): AlertView => ({
  id: record.id,
  base: record.base,
  quote: record.quote,
  side: record.side,
  targetRate: record.targetRate,
  status: record.status,
  createdAt: new Date(record.createdAt).toISOString(),
  triggeredAt: record.triggeredAt === null ? null : new Date(record.triggeredAt).toISOString(),
  triggeredRate: record.triggeredRate,
});
/** An alert is its owner's, in the company it was made in. Nobody else can change or delete it. */
const owns = (record: RateAlertRecord, user: Pick<UserRecord, 'id'>, company: Pick<CompanyRecord, 'id'>): boolean => record.userId === user.id && record.companyId === company.id;
const partyOf = (user: Pick<UserRecord, 'id' | 'email'>) => ({ type: 'client' as const, id: user.id, label: user.email });

export class RateAlerts {
  private checking = false;
  /** Alerts are created one at a time, so the cap cannot be passed by two requests arriving together. */
  private creating: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: AlertsDeps) {}

  private entry(action: string, user: Pick<UserRecord, 'id' | 'email'>, company: Pick<CompanyRecord, 'id' | 'name'>, source: string, record: RateAlertRecord, extra: Record<string, string> = {}): AuditInput {
    return { at: this.deps.now(), actor: partyOf(user), target: { type: 'company', id: company.id, label: company.name }, action, outcome: 'success', source, detail: { alert: record.id, pair: `${record.base}${record.quote}`, side: record.side, target: record.targetRate, ...extra } };
  }

  /** A person's alerts in the company they are working in. */
  async list(user: UserRecord, company: CompanyRecord): Promise<AlertView[]> {
    return (await this.deps.stores.alerts.list({ userId: user.id }, (row) => row.companyId === company.id)).sort((a, b) => a.createdAt - b.createdAt).map(view);
  }

  async create(user: UserRecord, company: CompanyRecord, input: { base: string; quote: string; side: 'sell' | 'buy'; targetRate: string }, source: string): Promise<AlertView> {
    const [base, quote] = [input.base.toUpperCase(), input.quote.toUpperCase()];
    if (!/^[A-Z]{3}$/.test(base) || !/^[A-Z]{3}$/.test(quote) || base === quote) throw new ApiError('validation', { fields: ['currency'] });
    if (input.side !== 'sell' && input.side !== 'buy') throw new ApiError('validation', { fields: ['side'] });
    if (!TARGET.test(input.targetRate) || !new Big(input.targetRate).gt(0)) throw new ApiError('validation', { fields: ['targetRate'] });
    // The pair must be one this company can be given a rate for.
    await this.deps.withProvider(company, (provider) => this.deps.rates.providerRate(company, provider, base, quote));
    const write = async (): Promise<AlertView> => {
      const at = this.deps.now();
      const record: RateAlertRecord = { id: `alr_${randomToken().slice(0, 16)}`, userId: user.id, companyId: company.id, base, quote, side: input.side, targetRate: new Big(input.targetRate).toFixed(), status: 'active', createdAt: at, armedAt: at, arming: randomToken().slice(0, 12), triggeredAt: null, triggeredRate: null };
      if ((await this.deps.stores.alerts.count({ userId: user.id })) >= this.deps.perUser) throw new ApiError('validation', { reason: 'too_many_alerts' });
      await this.deps.stores.alerts.mutate(record.id, () => record, () => this.entry('client.alert.create', user, company, source, record));
      return view(record);
    };
    const result = this.creating.then(write, write);
    this.creating = result.catch(() => undefined);
    return result;
  }

  /** Turning a paused or a fired alert on arms it afresh; turning it off pauses it. Only the owner's own alert, in this company. */
  async setEnabled(user: UserRecord, company: CompanyRecord, id: string, enabled: boolean, source: string): Promise<AlertView> {
    const at = this.deps.now();
    const arming = randomToken().slice(0, 12);
    const stored = await this.deps.stores.alerts.mutate(
      id,
      (current) => {
        if (!current || !owns(current, user, company)) return undefined;
        if (enabled) return current.status === 'active' ? undefined : { ...current, status: 'active', armedAt: at, arming, triggeredAt: null, triggeredRate: null };
        return current.status === 'paused' ? undefined : { ...current, status: 'paused' };
      },
      (record) => (record && record.userId === user.id && record.companyId === company.id && (enabled ? record.arming === arming : record.status === 'paused') ? this.entry(enabled ? 'client.alert.enable' : 'client.alert.pause', user, company, source, record) : null),
    );
    if (!stored || stored.userId !== user.id || stored.companyId !== company.id) throw new ApiError('not_found');
    return view(stored);
  }

  async remove(user: UserRecord, company: CompanyRecord, id: string, source: string): Promise<void> {
    let removed: RateAlertRecord | null = null;
    await this.deps.stores.alerts.mutate(
      id,
      (current) => {
        if (!current || !owns(current, user, company)) return undefined;
        removed = current;
        return null;
      },
      () => (removed ? this.entry('client.alert.delete', user, company, source, removed) : null),
    );
    if (!removed) throw new ApiError('not_found');
  }

  /** For staff: how many alerts a person has in each state. Not what they are. */
  async countsOf(userId: string): Promise<Record<RateAlertRecord['status'], number>> {
    const counts = { active: 0, paused: 0, triggered: 0 };
    for (const row of await this.deps.stores.alerts.list({ userId })) counts[row.status] += 1;
    return counts;
  }

  /**
   * ONE CHECK of every active alert. Returns how many fired. Never throws; a pair whose rate cannot be fetched is
   * skipped until the next check. If a check is still running, this one does nothing.
   */
  async check(): Promise<number> {
    if (this.checking) return 0;
    this.checking = true;
    try {
      return await this.run();
    } catch (error) {
      this.deps.onError?.(error instanceof Error ? error.message : 'alert check failed');
      return 0;
    } finally {
      this.checking = false;
    }
  }

  private async run(): Promise<number> {
    const { stores, rates, notifier, now } = this.deps;
    const active = await stores.alerts.list({ status: 'active' });
    if (active.length === 0) return 0;
    const companies = new Map<string, CompanyRecord | null>();
    const margins = new Map<string, MarginConfig>();
    // One fetch per provider and pair for this whole check, shared by every company on that provider.
    const fetched = new Map<string, Promise<RatePair | null>>();
    let fired = 0;
    for (const alert of active) {
      if (!companies.has(alert.companyId)) companies.set(alert.companyId, await stores.directory.getCompany(alert.companyId));
      const company = companies.get(alert.companyId);
      // Only for a person who is still an active member of an active company. (The alert is kept: it works again if that is restored.)
      if (!company || company.deactivatedAt) continue;
      const member = (await stores.directory.listMembers(company.id)).find((item) => item.userId === alert.userId);
      if (!member || !member.active) continue;
      const pairKey = `${company.providerKey}:${alert.base}${alert.quote}`;
      if (!fetched.has(pairKey)) fetched.set(pairKey, this.deps.withProvider(company, (provider) => rates.providerRate(company, provider, alert.base, alert.quote)).catch(() => null));
      const raw = await fetched.get(pairKey);
      if (!raw) continue;
      if (!margins.has(company.id)) margins.set(company.id, (await rates.marginOf(company.id)).config);
      let mine: RatePair;
      try {
        mine = rates.indicativeFrom(company, raw, margins.get(company.id) as MarginConfig);
      } catch {
        continue;
      }
      const rate = alert.side === 'sell' ? mine.rate : (mine.buyRate ?? mine.rate);
      const reached = alert.side === 'sell' ? new Big(rate).gte(alert.targetRate) : new Big(rate).lte(alert.targetRate);
      if (!reached) continue;
      const at = now();
      // FIRST the notification (made once per alert and arming, whatever happens next), THEN the alert is marked.
      await notifier.notify(noteOf({ userId: alert.userId, companyId: company.id, category: 'rates', kind: 'rate_alert', note: { base: alert.base, quote: alert.quote, side: alert.side, target: alert.targetRate, rate, at }, dedupe: `alert:${alert.id}:${alert.arming}` }));
      const stored = await stores.alerts.mutate(
        alert.id,
        (current) => (current && current.status === 'active' && current.arming === alert.arming ? { ...current, status: 'triggered', triggeredAt: at, triggeredRate: rate } : undefined),
        (record) => (record && record.status === 'triggered' && record.triggeredAt === at ? { at, actor: { type: 'system', id: null, label: 'rate alerts' }, target: { type: 'client', id: alert.userId, label: member.email }, action: 'client.alert.triggered', outcome: 'success', source: 'server', detail: { alert: alert.id, pair: `${alert.base}${alert.quote}`, side: alert.side, target: alert.targetRate, rate } } : null),
      );
      if (stored?.status === 'triggered' && stored.triggeredAt === at) fired += 1;
    }
    return fired;
  }
}
