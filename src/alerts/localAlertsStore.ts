import { Big } from 'big.js';
import { z } from 'zod';

import { AlertsStoreError, type AlertsStore, type NewRateAlert, type RateAlert } from './AlertsStore';

/** The few storage calls the store needs. AsyncStorage satisfies this. */
export interface KeyValueStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

const alertSchema = z.object({
  id: z.string(),
  base: z.string().length(3),
  quote: z.string().length(3),
  direction: z.enum(['above', 'below']),
  targetRate: z.string().regex(/^\d+(\.\d+)?$/),
  enabled: z.boolean(),
  createdAt: z.string(),
});
const fileSchema = z.object({ version: z.literal(1), alerts: z.array(alertSchema) });

/** SAMPLE alerts shown the first time the store is used on a device. */
const SAMPLE_ALERTS: readonly Omit<RateAlert, 'createdAt'>[] = [
  { id: 'sample-alert-1', base: 'GBP', quote: 'USD', direction: 'above', targetRate: '1.3200', enabled: true },
  { id: 'sample-alert-2', base: 'GBP', quote: 'EUR', direction: 'below', targetRate: '1.1650', enabled: false },
];

export const MAX_ALERTS = 20;

/**
 * Stores alerts on the device. It does NOT watch rates or send notifications:
 * nothing fires when a target is reached. That needs a server.
 */
export class LocalAlertsStore implements AlertsStore {
  private cache: RateAlert[] | null = null;
  /** Serialises writes so two quick taps cannot overwrite each other. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly storage: KeyValueStorage,
    private readonly key: string = 'globalconnect.alerts.v1',
    private readonly now: () => number = Date.now,
  ) {}

  private async read(): Promise<RateAlert[]> {
    if (this.cache) return this.cache;
    let alerts: RateAlert[] | null = null;
    try {
      const text = await this.storage.getItem(this.key);
      if (text) {
        const parsed = fileSchema.safeParse(JSON.parse(text));
        // Unreadable data is dropped rather than crashing the Rates screen.
        alerts = parsed.success ? parsed.data.alerts : [];
      }
    } catch {
      alerts = [];
    }
    if (alerts === null) {
      const createdAt = new Date(this.now()).toISOString();
      alerts = SAMPLE_ALERTS.map((alert) => ({ ...alert, createdAt }));
    }
    this.cache = alerts;
    return alerts;
  }

  private async write(alerts: RateAlert[]): Promise<void> {
    this.cache = alerts;
    try {
      await this.storage.setItem(this.key, JSON.stringify({ version: 1, alerts }));
    } catch {
      throw new AlertsStoreError('Could not save your alerts on this device.');
    }
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  async list(): Promise<RateAlert[]> {
    return [...(await this.read())];
  }

  create(input: NewRateAlert): Promise<RateAlert> {
    return this.enqueue(async () => {
      if (!/^\d+(\.\d+)?$/.test(input.targetRate) || new Big(input.targetRate).lte(0)) {
        throw new AlertsStoreError('Enter a target rate greater than zero.');
      }
      if (input.base === input.quote) throw new AlertsStoreError('Choose two different currencies.');
      const alerts = await this.read();
      if (alerts.length >= MAX_ALERTS) throw new AlertsStoreError(`You can have up to ${MAX_ALERTS} alerts.`);
      const alert: RateAlert = {
        id: `alert-${this.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`,
        base: input.base,
        quote: input.quote,
        direction: input.direction,
        targetRate: input.targetRate,
        enabled: true,
        createdAt: new Date(this.now()).toISOString(),
      };
      await this.write([alert, ...alerts]);
      return alert;
    });
  }

  setEnabled(id: string, enabled: boolean): Promise<RateAlert> {
    return this.enqueue(async () => {
      const alerts = await this.read();
      const existing = alerts.find((alert) => alert.id === id);
      if (!existing) throw new AlertsStoreError('That alert no longer exists.');
      const updated = { ...existing, enabled };
      await this.write(alerts.map((alert) => (alert.id === id ? updated : alert)));
      return updated;
    });
  }

  remove(id: string): Promise<void> {
    return this.enqueue(async () => {
      const alerts = await this.read();
      await this.write(alerts.filter((alert) => alert.id !== id));
    });
  }
}
