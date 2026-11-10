import { AlertsStoreError } from '../AlertsStore';
import { LocalAlertsStore, MAX_ALERTS, type KeyValueStorage } from '../localAlertsStore';

function memoryStorage(initial: Record<string, string> = {}): KeyValueStorage & { data: Record<string, string>; failWrites: boolean } {
  const storage = {
    data: { ...initial },
    failWrites: false,
    async getItem(key: string) {
      return storage.data[key] ?? null;
    },
    async setItem(key: string, value: string) {
      if (storage.failWrites) throw new Error('disk full');
      storage.data[key] = value;
    },
  };
  return storage;
}

describe('LocalAlertsStore', () => {
  it('starts with the sample alerts, then persists changes', async () => {
    const storage = memoryStorage();
    const store = new LocalAlertsStore(storage, 'k');
    expect((await store.list()).map((alert) => [alert.base, alert.quote, alert.direction, alert.targetRate, alert.enabled])).toEqual([
      ['GBP', 'USD', 'above', '1.3200', true],
      ['GBP', 'EUR', 'below', '1.1650', false],
    ]);
    const created = await store.create({ base: 'EUR', quote: 'USD', direction: 'above', targetRate: '1.12' });
    expect(created.enabled).toBe(true);
    await store.setEnabled(created.id, false);
    await store.remove('sample-alert-1');

    const reopened = new LocalAlertsStore(storage, 'k');
    expect((await reopened.list()).map((alert) => [alert.id, alert.enabled])).toEqual([
      [created.id, false],
      ['sample-alert-2', false],
    ]);
  });

  it('stays empty once every alert is deleted', async () => {
    const storage = memoryStorage();
    const store = new LocalAlertsStore(storage, 'k');
    for (const alert of await store.list()) await store.remove(alert.id);
    expect(await new LocalAlertsStore(storage, 'k').list()).toEqual([]);
  });

  it('survives corrupt storage', async () => {
    expect(await new LocalAlertsStore(memoryStorage({ k: '{not json' }), 'k').list()).toEqual([]);
    expect(await new LocalAlertsStore(memoryStorage({ k: '{"version":1,"alerts":[{"id":1}]}' }), 'k').list()).toEqual([]);
  });

  it('validates input', async () => {
    const store = new LocalAlertsStore(memoryStorage(), 'k');
    await expect(store.create({ base: 'GBP', quote: 'USD', direction: 'above', targetRate: '0' })).rejects.toBeInstanceOf(AlertsStoreError);
    await expect(store.create({ base: 'GBP', quote: 'USD', direction: 'above', targetRate: 'abc' })).rejects.toBeInstanceOf(AlertsStoreError);
    await expect(store.create({ base: 'GBP', quote: 'GBP', direction: 'above', targetRate: '1' })).rejects.toBeInstanceOf(AlertsStoreError);
    await expect(store.setEnabled('missing', true)).rejects.toBeInstanceOf(AlertsStoreError);
    await expect(store.remove('missing')).resolves.toBeUndefined();
  });

  it('keeps every alert when several are created at once, up to the limit', async () => {
    const store = new LocalAlertsStore(memoryStorage(), 'k');
    const results = await Promise.allSettled(
      Array.from({ length: MAX_ALERTS }, (_, index) => store.create({ base: 'GBP', quote: 'USD', direction: 'above', targetRate: `1.${index + 10}` })),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(MAX_ALERTS - 2);
    const alerts = await store.list();
    expect(alerts).toHaveLength(MAX_ALERTS);
    expect(new Set(alerts.map((alert) => alert.id)).size).toBe(MAX_ALERTS);
  });

  it('reports a failed save', async () => {
    const storage = memoryStorage();
    const store = new LocalAlertsStore(storage, 'k');
    storage.failWrites = true;
    await expect(store.create({ base: 'GBP', quote: 'USD', direction: 'above', targetRate: '1.4' })).rejects.toThrow('Could not save');
  });
});
