import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { LogOut } from 'lucide-react-native';
import { StyleSheet, Switch, View } from 'react-native';

import { isMockBackend, resetSampleData } from '@/api';
import { FORCED_ERRORS, FORCED_ERROR_LABELS, type ForcedError } from '@/api/mockControls';
import { AppText } from '@/components/AppText';
import { DetailRow } from '@/components/Bits';
import { Button } from '@/components/Button';
import { Card, Divider } from '@/components/Card';
import { ChipGroup } from '@/components/Controls';
import { Header } from '@/components/Header';
import { Screen } from '@/components/Screen';
import { APP_NAME } from '@/config/app';
import { disclosures } from '@/config/disclosures';
import { useSingleFlight } from '@/hooks/useSingleFlight';
import { useDevSettings } from '@/state/devSettings';
import { useSession } from '@/state/session';
import { showToast } from '@/state/toast';
import { colors, radii, spacing } from '@/theme';

const LATENCIES = [0, 350, 1500, 5000];
const FAILURE_RATES = [0, 0.1, 0.5, 1];
const QUOTE_TTLS = [5, 10, 30, 120];

function withCurrent(values: number[], current: number): number[] {
  return values.includes(current) ? values : [...values, current].sort((a, b) => a - b);
}

function DeveloperPanel() {
  const controls = useDevSettings((state) => state.controls);
  const setControls = useDevSettings((state) => state.setControls);
  const resetControls = useDevSettings((state) => state.resetControls);
  const queryClient = useQueryClient();

  return (
    <View style={styles.devPanel} testID="developer-panel">
      <AppText variant="title" accessibilityRole="header">
        Developer panel
      </AppText>
      <AppText variant="caption" tone="muted">
        Controls for the sample backend. Not for customers: remove or hide this panel before release.
      </AppText>

      <View style={styles.control}>
        <AppText variant="label">Response delay</AppText>
        <ChipGroup
          accessibilityLabel="Response delay"
          value={controls.latencyMs}
          onChange={(latencyMs) => setControls({ latencyMs })}
          options={withCurrent(LATENCIES, controls.latencyMs).map((ms) => ({ value: ms, label: ms === 0 ? 'None' : `${ms} ms` }))}
        />
      </View>

      <View style={styles.control}>
        <AppText variant="label">Random failures</AppText>
        <ChipGroup
          accessibilityLabel="Random failure rate"
          value={controls.failureRate}
          onChange={(failureRate) => setControls({ failureRate })}
          options={withCurrent(FAILURE_RATES, controls.failureRate).map((rate) => ({ value: rate, label: rate === 0 ? 'Off' : `${Math.round(rate * 100)}%` }))}
        />
      </View>

      <View style={styles.control}>
        <AppText variant="label">Force every request to fail with</AppText>
        <ChipGroup<ForcedError>
          accessibilityLabel="Forced error"
          value={controls.forcedError}
          onChange={(forcedError) => setControls({ forcedError })}
          options={FORCED_ERRORS.map((value) => ({ value, label: FORCED_ERROR_LABELS[value] }))}
        />
      </View>

      <View style={styles.control}>
        <AppText variant="label">Quote hold time</AppText>
        <ChipGroup
          accessibilityLabel="Quote hold time"
          value={controls.quoteTtlSeconds}
          onChange={(quoteTtlSeconds) => setControls({ quoteTtlSeconds })}
          options={withCurrent(QUOTE_TTLS, controls.quoteTtlSeconds).map((seconds) => ({ value: seconds, label: `${seconds} s` }))}
        />
      </View>

      <View style={styles.switchRow}>
        <AppText variant="label" style={styles.grow}>
          Simulate being offline
        </AppText>
        <Switch
          accessibilityLabel="Simulate being offline"
          value={controls.offline}
          onValueChange={(offline) => setControls({ offline })}
          trackColor={{ true: colors.primary, false: colors.disabledBg }}
          testID="dev-offline-switch"
        />
      </View>

      <Button
        variant="secondary"
        label="Reset sample data"
        onPress={() => {
          resetSampleData();
          void queryClient.invalidateQueries();
          showToast('Sample data reset');
        }}
      />
      <Button variant="ghost" label="Reset these controls" onPress={resetControls} />
    </View>
  );
}

export function SettingsScreen() {
  const router = useRouter();
  const session = useSession((state) => state.session);
  const remembered = useSession((state) => state.remembered);
  const signOut = useSession((state) => state.signOut);
  const forgetDevice = useSession((state) => state.forgetDevice);

  const close = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  };

  const leave = useSingleFlight(async () => {
    await signOut();
    router.replace('/sign-in');
  });

  return (
    <Screen header={<Header title="Profile and settings" leading="close" onLeadingPress={close} />}>
      {session ? (
        <>
          <Card padded={false}>
            <DetailRow label="Signed in as" value={session.user.email || session.user.displayName} />
            <Divider />
            <DetailRow label="Quick unlock on this device" value={remembered?.biometricEnabled ? 'On' : 'Off'} />
          </Card>
          <Button
            variant="danger"
            label="Sign out"
            icon={<LogOut color={colors.danger} size={20} />}
            onPress={leave.run}
            loading={leave.busy}
            testID="sign-out"
          />
          {remembered ? (
            <Button
              variant="ghost"
              label="Turn off quick unlock on this device"
              onPress={() => {
                void forgetDevice().then(() => showToast('Quick unlock turned off'));
              }}
            />
          ) : null}
        </>
      ) : (
        <AppText tone="muted">You are signed out.</AppText>
      )}

      {isMockBackend() ? <DeveloperPanel /> : null}

      <AppText variant="caption" tone="muted">{`${APP_NAME}. ${disclosures.regulatoryFooter}`}</AppText>
    </Screen>
  );
}

const styles = StyleSheet.create({
  devPanel: {
    gap: spacing.md,
    padding: spacing.lg,
    borderRadius: radii.card,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: colors.textMuted,
    backgroundColor: colors.card,
  },
  control: { gap: spacing.sm },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: 44 },
  grow: { flex: 1 },
});
