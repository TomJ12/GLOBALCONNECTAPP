import { useIsFocused, useLocalSearchParams, useRouter } from 'expo-router';
import { ArrowUpDown, CircleCheck, Clock } from 'lucide-react-native';
import { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';

import { toProviderError } from '@/api/errors';
import type { BookConversionRequest, Conversion, ConversionKind, FixedSide, Quote, QuoteRequest } from '@/api/types';
import { AmountField } from '@/components/AmountField';
import { AppText } from '@/components/AppText';
import { DetailRow } from '@/components/Bits';
import { Button } from '@/components/Button';
import { Card, Divider } from '@/components/Card';
import { ChipGroup, SegmentedControl } from '@/components/Controls';
import { Header } from '@/components/Header';
import { Screen } from '@/components/Screen';
import { InlineMessage } from '@/components/StateViews';
import { FORWARD_TENORS_MONTHS, SUPPORTED_CURRENCIES, outcomeCheckTiming } from '@/config/app';
import { disclosures } from '@/config/disclosures';
import { useBalances, useBookConversion, useFindConversionByKey } from '@/hooks/queries';
import { useAppIsActive } from '@/hooks/useAppIsActive';
import { quoteRequestKey, useHeldQuote } from '@/hooks/useHeldQuote';
import { useOutcomeCheck, type OutcomeResolution } from '@/hooks/useOutcomeCheck';
import { useSingleFlight } from '@/hooks/useSingleFlight';
import { confirmAction } from '@/lib/confirmAction';
import { formatDate, settlementDateAfterMonths } from '@/lib/dates';
import { newIdempotencyKey } from '@/lib/ids';
import { amountInputMessage, compareAmounts, formatMoney, formatRate, readAmountInput } from '@/lib/money';
import { useIsOnline } from '@/lib/online';
import { conversionMatchesQuote, formatCountdown, isQuoteExpired } from '@/lib/quote';
import { colors, radii, sizes, spacing } from '@/theme';
import { useCapabilities } from '@/state/session';

/** A booking request must reach the provider before the hold ends, so stop a little early. */
const EXPIRY_SAFETY_MS = 1000;

type Notice = { tone: 'danger' | 'warning' | 'info'; text: string } | null;

function isSupported(value: unknown): value is string {
  return typeof value === 'string' && SUPPORTED_CURRENCIES.includes(value.toUpperCase());
}

export function ConvertScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ sell?: string; buy?: string }>();
  const balances = useBalances();
  const book = useBookConversion();
  const findByKey = useFindConversionByKey();
  const online = useIsOnline();
  const focused = useIsFocused();
  const appActive = useAppIsActive();

  const capabilities = useCapabilities();
  const [chosenKind, setKind] = useState<ConversionKind>('spot');
  // An account without forward contracts is never offered one, whatever was chosen before.
  const kind: ConversionKind = capabilities.forwardContracts ? chosenKind : 'spot';
  const [sellCurrency, setSellCurrency] = useState('GBP');
  const [buyCurrency, setBuyCurrency] = useState('USD');
  const [fixedSide, setFixedSide] = useState<FixedSide>('sell');
  const [amountText, setAmountText] = useState('');
  const [tenorMonths, setTenorMonths] = useState<number>(FORWARD_TENORS_MONTHS[1] ?? 3);
  const [notice, setNotice] = useState<Notice>(null);
  const [result, setResult] = useState<Conversion | null>(null);
  /** The quote the person confirmed, kept to compare with what was actually booked. */
  const [confirmedQuote, setConfirmedQuote] = useState<Quote | null>(null);
  /**
   * One idempotency key per conversion INTENT (what is being converted), not per
   * quote. A re-quote after a lost response reuses it, so the same intent can
   * never be booked twice.
   */
  const [attempt, setAttempt] = useState<{ signature: string; key: string } | null>(null);
  const [booking, setBooking] = useState(false);

  // Opened from a rate row: start with that pair. Applied once per distinct
  // pair of params, during render, so there is no extra effect pass.
  const paramKey = `${params.sell ?? ''}|${params.buy ?? ''}`;
  const [appliedParamKey, setAppliedParamKey] = useState('|');
  if (paramKey !== appliedParamKey) {
    setAppliedParamKey(paramKey);
    if (isSupported(params.sell) && isSupported(params.buy) && params.sell.toUpperCase() !== params.buy.toUpperCase()) {
      setSellCurrency(params.sell.toUpperCase());
      setBuyCurrency(params.buy.toUpperCase());
    }
  }

  const finish = (conversion: Conversion) => {
    setResult(conversion);
    setAttempt(null);
    setNotice(null);
  };
  const windowSeconds = Math.round(outcomeCheckTiming.windowMs / 1000);
  const checkingText = `We did not get an answer, so we are checking whether your conversion went through. This can take up to ${windowSeconds} seconds. Do not convert again.`;
  const applyResolution = (resolution: OutcomeResolution<Conversion>) => {
    if (resolution.status === 'found') finish(resolution.value);
    else {
      // The window passed with no record. That is not proof, so the wording does not claim it.
      setNotice({
        tone: 'warning',
        text: `We kept checking for ${windowSeconds} seconds and found no record of that conversion. Check your balances and Activity before converting again.`,
      });
    }
  };
  const outcome = useOutcomeCheck<Conversion>('conversion', (key) => findByKey.mutateAsync(key), applyResolution);
  const outcomeUnknown = outcome.blocked;

  const fixedCurrency = fixedSide === 'sell' ? sellCurrency : buyCurrency;
  // The text is read against the CURRENT currency every render, so after a swap or
  // currency change an amount the new currency cannot hold is rejected, not reshaped.
  const read = readAmountInput(amountText, fixedCurrency);
  const amount = read.ok ? read.amount : null;
  const inputError = read.ok ? null : amountInputMessage(read.problem, fixedCurrency);
  // Recomputed when the calendar day changes, so a screen left open overnight cannot keep yesterday's date.
  const today = new Date().toISOString().slice(0, 10);
  const settlementDate = useMemo(() => settlementDateAfterMonths(tenorMonths, Date.parse(`${today}T12:00:00Z`)), [tenorMonths, today]);

  // Rebuilt every render on purpose: useHeldQuote compares requests by content, not identity.
  const request: QuoteRequest | null =
    amount === null || result !== null
      ? null
      : { kind, sellCurrency, buyCurrency, fixedSide, amount, settlementDate: kind === 'forward' ? settlementDate : undefined };

  const held = useHeldQuote(request, { paused: booking || outcomeUnknown, active: focused && appActive });
  const { quote } = held;
  const locked = booking || outcomeUnknown;

  const sellBalance = balances.data?.find((item) => item.currency === sellCurrency);
  const available = balances.data ? (sellBalance?.amount ?? '0') : null;
  const sellAmount = quote?.sellAmount ?? (fixedSide === 'sell' ? amount : null);
  // A forward is paid for at settlement, so the balance check applies to spot only.
  const insufficient = kind === 'spot' && sellAmount !== null && available !== null && compareAmounts(sellAmount, available) > 0;

  const edit = (side: FixedSide) => (text: string) => {
    setFixedSide(side);
    setAmountText(text);
    setNotice(null);
  };
  const displayValue = (side: FixedSide): string => {
    if (side === fixedSide) return amountText;
    if (!quote) return '';
    return side === 'sell' ? quote.sellAmount : quote.buyAmount;
  };
  const fieldError = (side: FixedSide): string | null => {
    if (side === fixedSide && inputError) return inputError;
    if (side === 'sell' && insufficient && available !== null) return `You have ${formatMoney(available, sellCurrency)} available in ${sellCurrency}.`;
    return null;
  };

  const changeSell = (currency: string) => {
    if (currency === buyCurrency) setBuyCurrency(sellCurrency);
    setSellCurrency(currency);
    setNotice(null);
  };
  const changeBuy = (currency: string) => {
    if (currency === sellCurrency) setSellCurrency(buyCurrency);
    setBuyCurrency(currency);
    setNotice(null);
  };
  const swap = () => {
    setSellCurrency(buyCurrency);
    setBuyCurrency(sellCurrency);
    setNotice(null);
  };

  const confirm = useSingleFlight(async () => {
    if (!quote || !request || insufficient || outcomeUnknown || !outcome.ready) return;
    setNotice(null);
    if (isQuoteExpired(quote, Date.now(), EXPIRY_SAFETY_MS)) {
      setNotice({ tone: 'warning', text: 'That rate expired. Check the new rate and confirm again.' });
      held.refresh();
      return;
    }
    setBooking(true);
    try {
      const summary = `${formatMoney(quote.sellAmount, quote.sellCurrency)} to ${formatMoney(quote.buyAmount, quote.buyCurrency)}`;
      const signature = quoteRequestKey(request);
      const key = attempt?.signature === signature ? attempt.key : newIdempotencyKey('conversion');
      const booking: BookConversionRequest = { quote, idempotencyKey: key };
      const confirmed = await confirmAction({
        title: kind === 'forward' ? 'Book this forward?' : 'Convert now?',
        message:
          kind === 'forward'
            ? `${summary} at ${formatRate(quote.rate)}, settling ${formatDate(settlementDate)}.`
            : `${summary} at ${formatRate(quote.rate)}.`,
        confirmLabel: kind === 'forward' ? 'Book forward' : `Convert ${formatMoney(quote.sellAmount, quote.sellCurrency)}`,
        // Only asked for when the backend lists conversions as needing a code. Off by default.
        stepUp: { action: 'conversion.book', payload: { quoteId: quote.id, idempotencyKey: key } },
      });
      if (!confirmed) return;
      // The hold may have run out while the confirmation was on screen.
      if (isQuoteExpired(quote, Date.now(), EXPIRY_SAFETY_MS)) {
        setNotice({ tone: 'warning', text: 'That rate expired while you were confirming. Check the new rate and confirm again.' });
        held.refresh();
        return;
      }
      setAttempt({ signature, key });
      setConfirmedQuote(quote);
      try {
        // Recorded on the device BEFORE it is sent, so closing the app mid-request cannot lose it.
        await outcome.begin(key, signature);
      } catch {
        setNotice({ tone: 'danger', text: 'We could not start this conversion safely on this device. Nothing was sent. Try again.' });
        return;
      }
      try {
        const conversion = await book.mutateAsync(booking);
        await outcome.settle();
        finish(conversion);
      } catch (caught) {
        const providerError = toProviderError(caught);
        if (providerError.outcomeUnknown) {
          // It may have been booked, or may still be on its way. Block and keep checking.
          setNotice({ tone: 'info', text: checkingText });
          outcome.markUnknown();
          return;
        }
        // A definite refusal: nothing was booked, so the record can go.
        await outcome.settle();
        if (providerError.kind === 'quote_expired') {
          setNotice({ tone: 'warning', text: 'That rate expired. Check the new rate and confirm again.' });
          held.refresh();
        } else if (providerError.kind === 'insufficient_funds') {
          setNotice({ tone: 'danger', text: `There is not enough ${quote.sellCurrency} in your balance for this conversion.` });
        } else {
          setNotice({ tone: 'danger', text: providerError.userMessage });
        }
      }
    } finally {
      setBooking(false);
    }
  });

  const recheck = useSingleFlight(async () => {
    await outcome.checkNow();
  });

  const reset = () => {
    setResult(null);
    setConfirmedQuote(null);
    setAmountText('');
    setNotice(null);
    setFixedSide('sell');
  };

  if (result) {
    const isForward = result.kind === 'forward';
    const balanceAfter = balances.data?.find((item) => item.currency === result.buyCurrency);
    const mismatch = confirmedQuote !== null && !conversionMatchesQuote(result, confirmedQuote);
    return (
      <Screen
        edges={['top', 'left', 'right']}
        header={<Header title={isForward ? 'Forward booked' : 'Converted'} leading="none" />}
        footer={
          <>
            <Button label="Done" onPress={reset} testID="convert-done" />
            <Button label="Go to Home" variant="ghost" onPress={() => { reset(); router.push('/'); }} />
          </>
        }
      >
        <Card style={styles.outcome}>
          <CircleCheck color={colors.positive} size={48} />
          <AppText variant="heading" align="center" accessibilityRole="header" accessibilityLiveRegion="polite">
            {isForward ? 'Rate locked' : 'Conversion complete'}
          </AppText>
          <AppText variant="amount" align="center" adjustsFontSizeToFit numberOfLines={1} testID="convert-result-buy">
            {formatMoney(result.buyAmount, result.buyCurrency)}
          </AppText>
          <AppText tone="muted" align="center">
            {isForward
              ? `You will buy this for ${formatMoney(result.sellAmount, result.sellCurrency)} on ${formatDate(result.settlementDate)}.`
              : `Bought with ${formatMoney(result.sellAmount, result.sellCurrency)}.`}
          </AppText>
        </Card>
        {mismatch ? (
          <InlineMessage tone="danger">
            These amounts are different from the rate you confirmed. The figures shown here are what was booked. Contact support before converting again.
          </InlineMessage>
        ) : null}
        <Card padded={false}>
          <DetailRow label="Rate" value={`1 ${result.rateBase} = ${formatRate(result.rate)} ${result.rateQuote}`} />
          <Divider />
          <DetailRow label="Reference" value={result.reference} />
          {!isForward && balanceAfter ? (
            <>
              <Divider />
              <DetailRow label={`${result.buyCurrency} balance now`} value={formatMoney(balanceAfter.amount, balanceAfter.currency)} />
            </>
          ) : null}
        </Card>
        {isForward ? (
          <AppText variant="caption" tone="muted">
            {disclosures.forwardTerms}
          </AppText>
        ) : null}
      </Screen>
    );
  }

  const quoteUsable = quote !== null && !held.isExpired;
  const canSubmit = quoteUsable && !insufficient && online && !held.isFetching && !outcomeUnknown && outcome.ready;
  const needsNewRate = !outcomeUnknown && !held.isFetching && (held.error !== null || (quote !== null && held.isExpired));
  const buttonLabel =
    kind === 'forward'
      ? quote
        ? `Book forward for ${formatMoney(quote.buyAmount, quote.buyCurrency)}`
        : 'Book forward'
      : quote
        ? `Convert ${formatMoney(quote.sellAmount, quote.sellCurrency)}`
        : 'Convert';

  let status: { text: string; busy: boolean } | null = null;
  if (amount !== null && !outcomeUnknown) {
    if (quote && !held.isExpired && !held.isFetching) status = { text: `Rate held for ${formatCountdown(held.secondsLeft)}`, busy: false };
    else if (held.isFetching) status = { text: quote ? 'Rate expired. Getting a new rate…' : 'Getting your rate…', busy: true };
    else if (quote && held.isExpired) status = { text: 'Rate expired', busy: false };
  }

  return (
    <Screen
      edges={['top', 'left', 'right']}
      header={<Header title="Convert" leading="none" />}
      footer={
        outcomeUnknown ? (
          <Button label="Check again" onPress={recheck.run} loading={recheck.busy || outcome.isChecking} disabled={!online} testID="convert-recheck" />
        ) : (
          <>
            {status ? (
              <View style={styles.status} accessible accessibilityRole="timer" accessibilityLabel={status.text} testID="quote-status">
                {status.busy ? <ActivityIndicator color={colors.textMuted} size="small" /> : <Clock color={colors.textMuted} size={18} />}
                <AppText variant="label" tone="muted">
                  {status.text}
                </AppText>
              </View>
            ) : null}
            <Button label={buttonLabel} onPress={confirm.run} loading={confirm.busy} disabled={!canSubmit} testID="convert-submit" />
          </>
        )
      }
    >
      {capabilities.forwardContracts ? (
        <SegmentedControl
          accessibilityLabel="Conversion type"
          value={kind}
          disabled={locked}
          onChange={(next) => {
            setKind(next);
            setNotice(null);
          }}
          options={[
            { value: 'spot', label: 'Spot', accessibilityLabel: 'Spot, convert now' },
            { value: 'forward', label: 'Forward', accessibilityLabel: 'Forward, lock a rate for later' },
          ]}
        />
      ) : null}

      <Card style={{ gap: spacing.md }}>
        <AmountField
          label="You sell"
          currency={sellCurrency}
          value={displayValue('sell')}
          onChangeText={edit('sell')}
          currencies={SUPPORTED_CURRENCIES}
          onChangeCurrency={changeSell}
          editable={!locked}
          caption={available !== null ? `Balance ${formatMoney(available, sellCurrency)}` : undefined}
          error={fieldError('sell')}
          testID="sell-amount"
        />
        <View style={styles.swapRow}>
          <View style={styles.swapLine} />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Swap currencies. Currently selling ${sellCurrency} and buying ${buyCurrency}`}
            accessibilityState={{ disabled: locked }}
            onPress={swap}
            disabled={locked}
            style={({ pressed }) => [styles.swap, pressed || locked ? styles.pressed : null]}
            testID="swap-currencies"
          >
            <ArrowUpDown color={colors.tintText} size={20} />
          </Pressable>
          <View style={styles.swapLine} />
        </View>
        <AmountField
          label="You buy"
          currency={buyCurrency}
          value={displayValue('buy')}
          onChangeText={edit('buy')}
          currencies={SUPPORTED_CURRENCIES}
          onChangeCurrency={changeBuy}
          editable={!locked}
          error={fieldError('buy')}
          testID="buy-amount"
        />
      </Card>

      {kind === 'forward' ? (
        <Card style={{ gap: spacing.sm }}>
          <AppText variant="label" tone="muted">
            Settlement date
          </AppText>
          <ChipGroup
            accessibilityLabel="Settlement date"
            value={tenorMonths}
            onChange={setTenorMonths}
            disabled={locked}
            options={FORWARD_TENORS_MONTHS.map((months) => ({
              value: months,
              label: months === 12 ? '1 year' : `${months} ${months === 1 ? 'month' : 'months'}`,
            }))}
          />
          <AppText variant="bodyStrong" testID="settlement-date">{`Settles ${formatDate(settlementDate)}`}</AppText>
          <AppText variant="caption" tone="muted">
            {disclosures.forwardTerms}
          </AppText>
        </Card>
      ) : null}

      <Card padded={false}>
        <DetailRow
          label="Your rate"
          value={quote ? `1 ${quote.rateBase} = ${formatRate(quote.rate)} ${quote.rateQuote}` : amount === null ? 'Enter an amount' : '…'}
        />
        <Divider />
        <DetailRow label="Fee" value={disclosures.fee} />
        <Divider />
        <DetailRow label="Settles" value={kind === 'forward' ? formatDate(settlementDate) : disclosures.settlementTime} />
      </Card>

      {notice ? <InlineMessage tone={notice.tone}>{notice.text}</InlineMessage> : null}
      {outcomeUnknown && !notice ? <InlineMessage tone="info">{checkingText}</InlineMessage> : null}
      {held.error && !held.isFetching && !outcomeUnknown ? (
        <InlineMessage tone="danger">
          {held.error.kind === 'validation' ? 'We cannot quote that amount. Try a different amount.' : `We could not get a rate. ${held.error.userMessage}`}
        </InlineMessage>
      ) : null}
      {needsNewRate ? <Button variant="secondary" label="Get a new rate" onPress={held.refresh} disabled={!online} testID="quote-retry" /> : null}
      {balances.isError && !balances.data ? (
        <InlineMessage tone="warning">We could not load your balances, so we cannot check what is available.</InlineMessage>
      ) : null}
      <AppText variant="caption" tone="muted">
        {disclosures.rateSource}
      </AppText>
    </Screen>
  );
}

const styles = StyleSheet.create({
  outcome: { alignItems: 'center', gap: spacing.md, paddingVertical: spacing.xxl },
  status: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm, minHeight: 24 },
  swapRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  swapLine: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: colors.hairline },
  swap: { width: sizes.touchTarget, height: sizes.touchTarget, borderRadius: radii.pill, backgroundColor: colors.tint, alignItems: 'center', justifyContent: 'center' },
  pressed: { opacity: 0.6 },
});
