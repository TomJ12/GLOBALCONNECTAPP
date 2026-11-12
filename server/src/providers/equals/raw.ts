/**
 * Wire shapes of provider B, modelled on the public Equals Money API
 * documentation (docs.equalsmoney.com, read 2026-11-11). Amounts are JSON
 * numbers, lists use limit/offset/count/rows, dates in orders are YYYYMMDD and
 * every call carries `accountId` as a query parameter.
 *
 * FROM THE PUBLIC DOCS (field names as documented):
 *   GET  /v2/budgets?accountId=&include=balance       rows[].balance[]
 *   POST /v2/orders/quote?accountId=                  quoteRequestId, orderId, settlement, quote
 *   POST /v2/orders/trade?accountId=                  { orderId, quoteRequestId }
 *   POST /v2/recipients/validate?accountId=           then
 *   POST /v2/recipients/{id}/confirm?accountId=       status AUTHORISED
 *   Authorization: ApiKey <key>
 *
 * NOT TAKEN FROM THE DOCS (the pages were not read, so these are this mock's
 * own guesses and are marked INVENTED below): the inner fields of
 * settlementDetails, listing recipients, single-currency payment orders,
 * listing and looking up orders, account activity, indicative rates and the
 * error body. Nothing was tested against a live or sandbox API.
 */
import { z } from 'zod';

const list = <T extends z.ZodType>(row: T) => z.object({ limit: z.number(), offset: z.number(), count: z.number(), rows: z.array(row) });

export const rawBudgetBalance = z.object({
  currencyCode: z.string(),
  availableBalance: z.number(),
  ledgerBalance: z.number(),
  pendingBalance: z.number(),
  allocatedBalance: z.number(),
  ledgerAndAllocatedBalance: z.number(),
  activeCurrencyOnBudget: z.boolean().optional(),
});

/** INVENTED inner shape: the docs say only that each currency has local and international account and bank details. */
const rawSettlementAccount = z
  .object({ accountName: z.string(), accountNumber: z.string().optional(), sortCode: z.string().optional(), iban: z.string().optional(), bic: z.string().optional() })
  .nullable();

export const rawBudget = z.object({
  id: z.string(),
  name: z.string(),
  accountId: z.string(),
  type: z.string(),
  status: z.string(),
  balance: z.array(rawBudgetBalance).nullable().optional(),
  settlementDetails: z
    .object({
      currencyDetails: z.array(z.object({ currencyCode: z.string(), local: rawSettlementAccount, international: rawSettlementAccount })),
      balanceReference: z.string().optional(),
    })
    .optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export const rawBudgets = list(rawBudget);

const amountIn = z.object({ amount: z.number(), currency: z.string() });
export const rawOrderQuote = z.object({
  quoteRequestId: z.string(),
  orderId: z.string(),
  settlement: z.object({ date: z.string().regex(/^\d{8}$/), price: amountIn, charges: z.object({ fee: z.number() }) }),
  quote: z.object({
    rate: z.number(),
    inverseRate: z.number(),
    fromGbpAmount: z.number().optional(),
    from: amountIn,
    to: amountIn,
    direction: z.string(),
  }),
});

export const rawRecipient = z.object({
  id: z.string(),
  accountId: z.string(),
  status: z.string(),
  type: z.string(),
  name: z.string(),
  currencyCode: z.string(),
  accountIdentifier: z.string(),
  bankIdentifier: z.string().optional(),
  bankAddress: z.object({ countryCode: z.string() }).optional(),
  createdAt: z.string(),
});
/** INVENTED: GET /v2/recipients */
export const rawRecipients = list(rawRecipient);

/** INVENTED: a payment order. Only the `payments` object inside it follows the documented trade request. */
export const rawPaymentOrder = z.object({
  orderId: z.string(),
  status: z.string(),
  clientReference: z.string().optional(),
  payments: z.object({
    amount: z.number(),
    currency: z.object({ budgetId: z.string(), currencyCode: z.string() }),
    recipientId: z.string(),
    internalReference: z.string().optional(),
    externalReference: z.string(),
  }),
  createdAt: z.string(),
});
export const rawPaymentOrders = list(rawPaymentOrder);

/** INVENTED: GET /v2/orders/{orderId}, the booked trade behind an order id. */
export const rawTradeOrder = rawOrderQuote.extend({ status: z.string(), createdAt: z.string() });

/** INVENTED: GET /v2/activity */
export const rawActivity = list(
  z.object({
    id: z.string(),
    type: z.string(),
    direction: z.enum(['in', 'out']),
    amount: z.number(),
    currencyCode: z.string(),
    description: z.string(),
    reference: z.string().optional(),
    status: z.string(),
    createdAt: z.string(),
  }),
);

/** INVENTED: GET /v2/rates */
export const rawRate = z.object({ from: z.string(), to: z.string(), rate: z.number(), timestamp: z.string() });

/** INVENTED error body. */
export const rawError = z.object({ code: z.string(), message: z.string().optional(), field: z.string().optional() });

export type RawBudget = z.infer<typeof rawBudget>;
export type RawRecipient = z.infer<typeof rawRecipient>;
export type RawPaymentOrder = z.infer<typeof rawPaymentOrder>;
export type RawOrderQuote = z.infer<typeof rawOrderQuote>;

export interface EqualsRequest {
  method: 'GET' | 'POST';
  /** For example "/v2/budgets". */
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  /** Sent as `Authorization: ApiKey <key>`. */
  apiKey: string;
}

/** The wire. A real one is fetch() against the provider's base URL. Rejects only when no response arrived. */
export interface EqualsTransport {
  request(request: EqualsRequest): Promise<{ status: number; body: string }>;
}
