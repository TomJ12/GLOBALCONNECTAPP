import { useLocalSearchParams, useRouter } from 'expo-router';
import { ArrowUpDown, CircleCheck, Clock } from 'lucide-react-native';
import { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';

import { toProviderError } from '@/api/errors';
import type { Conversion, ConversionKind, FixedSide, QuoteRequest } from '@/api/types';
import { AmountField } from '@/components/AmountField';
import { AppText } from '@/components/AppText';
import { DetailRow } from '@/components/Bits';
import { Button } from '@/components/Button';
import { Card, Divider } from '@/components/Card';
import { ChipGroup, SegmentedControl } from '@/components/Controls';
import { Header } from '@/components/Header';
import { Screen } from '@/components/Screen';
import { InlineMessage } from '@/components/StateViews';
import { FORWARD_TENORS_MONTHS, SUPPORTED_CURRENCIES } from '@/config/app';
import { disclosures } from '@/config/disclosures';
import { useBalances, useBookConversion } from '@/hooks/queries';
import { useHeldQuote } from '@/hooks/useHeldQuote';
import { useSingleFlight } from '@/hooks/useSingleFlight';
import { confirmWithBiometrics } from '@/lib/biometrics';
import { formatDate, settlementDateAfterMonths } from '@/lib/dates';
import { compareAmounts, formatMoney, formatRate, parseAmountInput } from '@/lib/money';
import { useIsOnline } from '@/lib/online';
import { formatCountdown, isQuoteExpired } from '@/lib/quote';
import { colors, radii, sizes, spacing } from '@/theme';

/** A booking request must reach the provider before the hold ends, so stop a little early. */
const EXPIRY_SAFETY_MS = 1000;

function isSupported(value: unknown): value is string {
  return typeof value === 'string' && SUPPORTED_CURRENCIES.includes(value.toUpperCase());
}

export function ConvertScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ sell?: string; buy?: string }>();
  const balances = useBalances();
  const book = useBookConversion();
  const online = useIsOnline();

  const [kind, setKind] = useState<ConversionKind>('spot');
  const [sellCurrency, setSellCurrency] = useState('GBP');
  const [buyCurrency, setBuyCurrency] = useState('USD');
  const [fixedSide, setFixedSide] = useState<FixedSide>('sell');
  const [amountText, setAmountText] = useState('');
  const [tenorMonths, setTenorMonths] = useState<number>(FORWARD_TENORS_MONTHS[1] ?? 3);
  const [notice, setNotice] = useState<{ tone: 'danger' | 'warning'; text: string } | null>(null);
  const [result, setResult] = useState<Conversion | null>(null);

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

  const fixedCurrency = fixedSide === 'sell' ? sellCurrency : buyCurrency;
  const amount = parseAmountInput(amountText, fixedCurrency);
  // Recomputed only when the tenor changes, so the date is stable while typing.
  const settlementDate = useMemo(() => settlementDateAfterMonths(tenorMonths), [tenorMonths]);

  const request = useMemo<QuoteRequest | null>(() => {
    if (amount === null || result !== null) return null;
    return {
      kind,
      sellCurrency,
      buyCurrency,
      fixedSide,
      amount,
      settlementDate: kind === 'forward' ? settlementDate : undefined,
    };
  }, [amount, result, kind, sellCurrency, buyCurrency, fixedSide, settlementDate]);

  const [booking, setBooking] = useState(false);
  const held = useHeldQuote(request, { paused: booking });
  const { quote } = held;

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
    if (!quote || insufficient) return;
    setNotice(null);
    if (isQuoteExpired(quote, Date.now(), EXPIRY_SAFETY_MS)) {
      setNotice({ tone: 'warning', text: 'That rate expired. Check the new rate and confirm again.' });
      held.refresh();
      return;
    }
    setBooking(true);
    try {
      const summary = `${formatMoney(quote.sellAmount, quote.sellCurrency)} to ${formatMoney(quote.buyAmount, quote.buyCurrency)}`;
      const confirmed = await confirmWithBiometrics({
        reason: kind === 'forward' ? `Book forward: ${summary}` : `Convert ${summary}`,
        fallbackTitle: kind === 'forward' ? 'Book this forward?' : 'Convert now?',
        fallbackMessage: `${summary} at ${formatRate(quote.rate)}.`,
        fallbackConfirmLabel: kind === 'forward' ? 'Book forward' : 'Convert',
      });
      if (!confirmed) return;
      // The hold may have run out while the confirmation was on screen.
      if (isQuoteExpired(quote, Date.now(), EXPIRY_SAFETY_MS)) {
        setNotice({ tone: 'warning', text: 'That rate expired while you were confirming. Check the new rate and confirm again.' });
        return;
      }
      // Keyed by quote: a retry of the same quote can never book twice.
      const conversion = await book.mutateAsync({ quote, idempotencyKey: `conversion-${quote.id}` });
      setResult(conversion);
    } catch (caught) {
      const providerError = toProviderError(caught);
      if (providerError.kind === 'quote_expired') {
        setNotice({ tone: 'warning', text: 'That rate expired. Check the new rate and confirm again.' });
        held.refresh();
      } else if (providerError.kind === 'insufficient_funds') {
        setNotice({ tone: 'danger', text: `There is not enough ${quote.sellCurrency} in your balance for this conversion.` });
      } else {
        setNotice({ tone: 'danger', text: `${providerError.userMessage} If you try again with this rate, it will only be converted once.` });
      }
    } finally {
      setBooking(false);
    }
  });

  const reset = () => {
    setResult(null);
    setAmountText('');
    setNotice(null);
    setFixedSide('sell');
  };

  if (result) {
    const isForward = result.kind === 'forward';
    const balanceAfter = balances.data?.find((item) => item.currency === result.buyCurrency);
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
  const canSubmit = quoteUsable && !insufficient && online && !held.isFetching;
  const buttonLabel =
    kind === 'forward'
      ? quote
        ? `Book forward for ${formatMoney(quote.buyAmount, quote.buyCurrency)}`
        : 'Book forward'
      : quote
        ? `Convert ${formatMoney(quote.sellAmount, quote.sellCurrency)}`
        : 'Convert';

  let status: { text: string; busy: boolean } | null = null;
  if (amount !== null) {
    if (quote && !held.isExpired && !held.isFetching) status = { text: `Rate held for ${formatCountdown(held.secondsLeft)}`, busy: false };
    else if (held.isFetching) status = { text: quote ? 'Rate expired. Getting a new rate…' : 'Getting your rate…', busy: true };
    else if (quote && held.isExpired) status = { text: 'Rate expired', busy: false };
  }

  return (
    <Screen
      edges={['top', 'left', 'right']}
      header={<Header title="Convert" leading="none" />}
      footer={
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
      }
    >
      <SegmentedControl
        accessibilityLabel="Conversion type"
        value={kind}
        disabled={confirm.busy}
        onChange={(next) => {
          setKind(next);
          setNotice(null);
        }}
        options={[
          { value: 'spot', label: 'Spot', accessibilityLabel: 'Spot, convert now' },
          { value: 'forward', label: 'Forward', accessibilityLabel: 'Forward, lock a rate for later' },
        ]}
      />

      <Card style={{ gap: spacing.md }}>
        <AmountField
          label="You sell"
          currency={sellCurrency}
          value={displayValue('sell')}
          onChangeText={edit('sell')}
          currencies={SUPPORTED_CURRENCIES}
          onChangeCurrency={changeSell}
          editable={!confirm.busy}
          caption={available !== null ? `Balance ${formatMoney(available, sellCurrency)}` : undefined}
          error={insufficient && available !== null ? `You have ${formatMoney(available, sellCurrency)} available in ${sellCurrency}.` : null}
          testID="sell-amount"
        />
        <View style={styles.swapRow}>
          <View style={styles.swapLine} />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Swap currencies. Currently selling ${sellCurrency} and buying ${buyCurrency}`}
            onPress={swap}
            disabled={confirm.busy}
            style={({ pressed }) => [styles.swap, pressed ? styles.pressed : null]}
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
          editable={!confirm.busy}
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
            disabled={confirm.busy}
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
      {held.error && !held.isFetching ? (
        <View style={{ gap: spacing.sm }}>
          <InlineMessage tone="danger">
            {held.error.kind === 'validation' ? 'We cannot quote that amount. Try a different amount.' : `We could not get a rate. ${held.error.userMessage}`}
          </InlineMessage>
          <Button variant="secondary" label="Get a new rate" onPress={held.refresh} disabled={!online} testID="quote-retry" />
        </View>
      ) : null}
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
