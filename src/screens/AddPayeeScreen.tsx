import { useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { toProviderError } from '@/api/errors';
import { AppText } from '@/components/AppText';
import { Button } from '@/components/Button';
import { SegmentedControl } from '@/components/Controls';
import { OptionPicker } from '@/components/CurrencyPicker';
import { Header } from '@/components/Header';
import { Screen } from '@/components/Screen';
import { InlineMessage } from '@/components/StateViews';
import { TextField } from '@/components/TextField';
import { useCreateBeneficiary } from '@/hooks/queries';
import { useSingleFlight } from '@/hooks/useSingleFlight';
import { currencyName } from '@/lib/money';
import { useIsOnline } from '@/lib/online';
import {
  PAYEE_COUNTRIES,
  PAYEE_CURRENCIES,
  normalizeIban,
  normalizeSortCode,
  payeeFieldRules,
  validatePayeeDraft,
  type PayeeBankField,
  type PayeeDraft,
} from '@/lib/validation';
import { showToast } from '@/state/toast';
import { spacing } from '@/theme';

const FIELD_LABELS: Record<PayeeBankField, string> = {
  sortCode: 'Sort code',
  accountNumber: 'Account number',
  iban: 'IBAN',
  bic: 'BIC (SWIFT code)',
  routingNumber: 'Routing number (ABA)',
};

const FIELD_HINTS: Record<PayeeBankField, string> = {
  sortCode: '6 digits',
  accountNumber: '',
  iban: 'Starts with a two-letter country code',
  bic: '8 or 11 characters',
  routingNumber: '9 digits',
};

const EMPTY: PayeeDraft = {
  name: '',
  entityType: 'company',
  countryCode: 'GB',
  currency: 'GBP',
  sortCode: '',
  accountNumber: '',
  iban: '',
  bic: '',
  routingNumber: '',
};

export function AddPayeeScreen() {
  const router = useRouter();
  const createBeneficiary = useCreateBeneficiary();
  const online = useIsOnline();
  const [draft, setDraft] = useState<PayeeDraft>(EMPTY);
  const [showErrors, setShowErrors] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const rules = payeeFieldRules(draft.countryCode, draft.currency);
  const errors = showErrors ? validatePayeeDraft(draft) : {};
  const update = (patch: Partial<PayeeDraft>) => setDraft((current) => ({ ...current, ...patch }));

  const close = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/payments/new');
  };

  const save = useSingleFlight(async () => {
    setShowErrors(true);
    setSubmitError(null);
    if (Object.keys(validatePayeeDraft(draft)).length > 0) return;
    const wanted = new Set(rules.map((rule) => rule.field));
    const value = (field: PayeeBankField) => (wanted.has(field) && draft[field].trim() !== '' ? draft[field].trim() : undefined);
    try {
      await createBeneficiary.mutateAsync({
        name: draft.name.trim(),
        entityType: draft.entityType,
        currency: draft.currency,
        bankCountry: draft.countryCode,
        sortCode: value('sortCode') ? normalizeSortCode(value('sortCode') ?? '') : undefined,
        accountNumber: value('accountNumber'),
        iban: value('iban') ? normalizeIban(value('iban') ?? '') : undefined,
        bic: value('bic')?.toUpperCase(),
        routingNumber: value('routingNumber'),
      });
      showToast('Payee added');
      close();
    } catch (caught) {
      const providerError = toProviderError(caught);
      setSubmitError(
        providerError.kind === 'validation' ? 'These bank details were not accepted. Check them and try again.' : providerError.userMessage,
      );
    }
  });

  return (
    <Screen
      header={<Header title="Add a payee" leading="close" onLeadingPress={close} />}
      footer={<Button label="Save payee" onPress={save.run} loading={save.busy} disabled={!online} testID="save-payee" />}
    >
      <SegmentedControl
        accessibilityLabel="Payee type"
        value={draft.entityType}
        onChange={(entityType) => update({ entityType })}
        options={[
          { value: 'company', label: 'Business' },
          { value: 'individual', label: 'Person' },
        ]}
      />
      <TextField
        label="Account holder name"
        value={draft.name}
        onChangeText={(name) => update({ name })}
        error={errors.name}
        autoCapitalize="words"
        autoCorrect={false}
        maxLength={100}
        testID="payee-name"
      />
      <View style={{ gap: spacing.xs }}>
        <AppText variant="label" tone="muted">
          Bank country
        </AppText>
        <OptionPicker
          wide
          label="Bank country"
          value={draft.countryCode}
          onChange={(countryCode) => update({ countryCode })}
          options={PAYEE_COUNTRIES.map((country) => ({ value: country.code, label: country.name }))}
        />
      </View>
      <View style={{ gap: spacing.xs }}>
        <AppText variant="label" tone="muted">
          Currency
        </AppText>
        <OptionPicker
          wide
          label="Currency"
          value={draft.currency}
          onChange={(currency) => update({ currency })}
          options={PAYEE_CURRENCIES.map((currency) => ({ value: currency, label: currency, detail: currencyName(currency) }))}
        />
      </View>
      {rules.map((rule) => (
        <TextField
          key={rule.field}
          label={rule.required ? FIELD_LABELS[rule.field] : `${FIELD_LABELS[rule.field]} (optional)`}
          value={draft[rule.field]}
          onChangeText={(text) => update({ [rule.field]: text } as Partial<PayeeDraft>)}
          error={errors[rule.field]}
          hint={FIELD_HINTS[rule.field] || undefined}
          autoCapitalize="characters"
          autoCorrect={false}
          keyboardType={rule.field === 'sortCode' || rule.field === 'routingNumber' ? 'number-pad' : 'default'}
          maxLength={rule.field === 'iban' ? 42 : 34}
          testID={`payee-${rule.field}`}
        />
      ))}
      {submitError ? <InlineMessage tone="danger">{submitError}</InlineMessage> : null}
    </Screen>
  );
}
