/**
 * Rate alerts are an app feature, not something the payments provider offers,
 * so they sit behind their own small interface. Today there is one local
 * implementation; a server-backed one (needed for real push notifications)
 * would implement the same interface.
 */
import type { CurrencyCode, DecimalString, IsoDateTime } from '@/api/types';

/**
 * 'above' is an alert on the rate at which you SELL the pair's first currency (tell me when it is at or above the
 * target); 'below' on the rate at which you BUY it (at or below the target). Either way: "at this rate or better".
 */
export type AlertDirection = 'above' | 'below';

export interface RateAlert {
  id: string;
  base: CurrencyCode;
  quote: CurrencyCode;
  /** 'above': tell me when the rate reaches or passes the target. 'below': when it drops to it. */
  direction: AlertDirection;
  targetRate: DecimalString;
  enabled: boolean;
  createdAt: IsoDateTime;
  /** Set once a server-checked alert has fired: when, and the rate (your own) that set it off. It stays off until turned on again. */
  triggered?: { at: IsoDateTime; rate: DecimalString } | null;
}

export interface NewRateAlert {
  base: CurrencyCode;
  quote: CurrencyCode;
  direction: AlertDirection;
  targetRate: DecimalString;
}

export interface AlertsStore {
  list(): Promise<RateAlert[]>;
  create(input: NewRateAlert): Promise<RateAlert>;
  setEnabled(id: string, enabled: boolean): Promise<RateAlert>;
  remove(id: string): Promise<void>;
}

export class AlertsStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AlertsStoreError';
  }
}
