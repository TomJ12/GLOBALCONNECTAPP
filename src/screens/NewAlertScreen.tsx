import { useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import type { AlertDirection } from '@/alerts';
import { AppText } from '@/components/AppText';
import { Button } from '@/components/Button';
import { Card } from '@/components/Card';
import { ChipGroup, SegmentedControl } from '@/components/Controls';
import { Header } from '@/components/Header';
import { Screen } from '@/components/Screen';
import { InlineMessage } from '@/components/StateViews';
import { TextField } from '@/components/TextField';
import { WATCHLIST_PAIRS } from '@/config/app';
import { disclosures } from '@/config/disclosures';
import { useCreateAlert, useRate } from '@/hooks/queries';
import { useSingleFlight } from '@/hooks/useSingleFlight';
import { formatRate, isPositiveAmount } from '@/lib/money';
import { showToast } from '@/state/toast';
import { spacing } from '@/theme';

/** Digits and one decimal point, at most six decimal places. */
function sanitizeRateInput(text: string): string {
  const cleaned = text.replace(/[^\d.]/g, '');
  const dot = cleaned.indexOf('.');
  if (dot === -1) return cleaned.slice(0, 6);
  return `${cleaned.slice(0, dot).slice(0, 6) || '0'}.${cleaned.slice(dot + 1).replace(/\./g, '').slice(0, 6)}`;
}

export function NewAlertScreen() {
  const router = useRouter();
  const createAlert = useCreateAlert();
  const [pairIndex, setPairIndex] = useState(0);
  const [direction, setDirection] = useState<AlertDirection>('above');
  const [targetText, setTargetText] = useState('');
  const [error, setError] = useState<string | null>(null);

  const [base, quote] = WATCHLIST_PAIRS[pairIndex] ?? WATCHLIST_PAIRS[0] ?? ['GBP', 'USD'];
  const rate = useRate(base, quote);

  const close = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/rates');
  };

  const save = useSingleFlight(async () => {
    const target = targetText.replace(/\.$/, '');
    if (!isPositiveAmount(target)) {
      setError('Enter a target rate greater than zero.');
      return;
    }
    setError(null);
    try {
      await createAlert.mutateAsync({ base, quote, direction, targetRate: target });
      showToast('Alert saved');
      close();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save the alert.');
    }
  });

  return (
    <Screen
      header={<Header title="New rate alert" leading="close" onLeadingPress={close} />}
      footer={<Button label="Save alert" onPress={save.run} loading={save.busy} testID="save-alert" />}
    >
      <View style={{ gap: spacing.sm }}>
        <AppText variant="label" tone="muted">
          Currency pair
        </AppText>
        <ChipGroup
          accessibilityLabel="Currency pair"
          value={pairIndex}
          onChange={setPairIndex}
          options={WATCHLIST_PAIRS.map(([pairBase, pairQuote], index) => ({
            value: index,
            label: `${pairBase} / ${pairQuote}`,
            accessibilityLabel: `${pairBase} to ${pairQuote}`,
          }))}
        />
      </View>
      <Card>
        <AppText tone="muted">{`Current rate, 1 ${base} in ${quote}`}</AppText>
        <AppText variant="amount">{rate.data ? formatRate(rate.data.rate) : rate.isError ? 'Unavailable' : '…'}</AppText>
      </Card>
      <View style={{ gap: spacing.sm }}>
        <AppText variant="label" tone="muted">
          Tell me when the rate
        </AppText>
        <SegmentedControl
          accessibilityLabel="Alert condition"
          value={direction}
          onChange={setDirection}
          options={[
            { value: 'above', label: 'Reaches' },
            { value: 'below', label: 'Drops to' },
          ]}
        />
      </View>
      <TextField
        label="Target rate"
        value={targetText}
        onChangeText={(text) => {
          setTargetText(sanitizeRateInput(text));
          if (error) setError(null);
        }}
        keyboardType="decimal-pad"
        inputMode="decimal"
        placeholder={rate.data ? formatRate(rate.data.rate) : '0.0000'}
        error={error}
        testID="alert-target"
      />
      <InlineMessage tone="info">{disclosures.alertDelivery}</InlineMessage>
    </Screen>
  );
}
