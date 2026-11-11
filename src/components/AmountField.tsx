import { StyleSheet, TextInput, View } from 'react-native';

import { currencyDecimals, currencyPrefix } from '@/lib/money';
import { colors, fonts, fontSizes, spacing } from '@/theme';

import { AppText } from './AppText';
import { CurrencyPicker } from './CurrencyPicker';

export interface AmountFieldProps {
  label: string;
  currency: string;
  /**
   * Exactly what the person typed. It is NOT cleaned up here: the screen reads it
   * with readAmountInput() and shows a message if it is not a clear amount.
   */
  value: string;
  onChangeText: (text: string) => void;
  /** When given, the currency can be changed. */
  currencies?: readonly string[];
  onChangeCurrency?: (currency: string) => void;
  caption?: string;
  error?: string | null;
  /** False locks both the amount and the currency picker, for example while a booking is in flight. */
  editable?: boolean;
  placeholder?: string;
  testID?: string;
}

/** A big, legible amount input with its currency beside it. */
export function AmountField({
  label,
  currency,
  value,
  onChangeText,
  currencies,
  onChangeCurrency,
  caption,
  error,
  editable = true,
  placeholder,
  testID,
}: AmountFieldProps) {
  const zero = currencyDecimals(currency) === 0 ? '0' : `0.${'0'.repeat(currencyDecimals(currency))}`;
  return (
    <View style={styles.field}>
      <AppText variant="label" tone="muted">
        {label}
      </AppText>
      <View style={styles.row}>
        <AppText variant="amount" tone="muted" accessibilityElementsHidden importantForAccessibility="no">
          {currencyPrefix(currency).trim()}
        </AppText>
        <TextInput
          testID={testID}
          accessibilityLabel={`${label}, amount in ${currency}`}
          accessibilityHint={error ?? caption}
          aria-invalid={error ? true : undefined}
          value={value}
          editable={editable}
          onChangeText={onChangeText}
          maxLength={24}
          keyboardType={currencyDecimals(currency) === 0 ? 'number-pad' : 'decimal-pad'}
          inputMode={currencyDecimals(currency) === 0 ? 'numeric' : 'decimal'}
          placeholder={placeholder ?? zero}
          placeholderTextColor={colors.textMuted}
          maxFontSizeMultiplier={1.25}
          style={styles.input}
        />
        {currencies && onChangeCurrency ? (
          <CurrencyPicker label={`${label} currency`} value={currency} options={currencies} onChange={onChangeCurrency} disabled={!editable} />
        ) : (
          <View style={styles.staticCurrency}>
            <AppText variant="bodyStrong">{currency}</AppText>
          </View>
        )}
      </View>
      {error ? (
        <AppText variant="label" tone="danger" accessibilityRole="alert" accessibilityLiveRegion="polite">
          {`Error: ${error}`}
        </AppText>
      ) : caption ? (
        <AppText variant="caption" tone="muted">
          {caption}
        </AppText>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  field: { gap: spacing.xs },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  input: {
    flex: 1,
    minWidth: 0,
    minHeight: 52,
    fontFamily: fonts.bold,
    fontSize: fontSizes.amount,
    color: colors.text,
    padding: 0,
  },
  staticCurrency: { paddingHorizontal: spacing.md, justifyContent: 'center', minHeight: 44 },
});
