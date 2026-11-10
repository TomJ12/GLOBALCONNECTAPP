import { Tabs } from 'expo-router/js-tabs';
import { ArrowLeftRight, House, Send, TrendingUp } from 'lucide-react-native';

import { colors, fonts } from '@/theme';

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.primaryPressed,
        tabBarInactiveTintColor: colors.textMuted,
        tabBarLabelStyle: { fontFamily: fonts.medium, fontSize: 12 },
        tabBarStyle: { backgroundColor: colors.card, borderTopColor: colors.hairline },
        sceneStyle: { backgroundColor: colors.background },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{ title: 'Home', tabBarIcon: ({ color, size, focused }) => <House color={color} size={size} strokeWidth={focused ? 2.6 : 2} /> }}
      />
      <Tabs.Screen
        name="payments"
        options={{ title: 'Payments', tabBarIcon: ({ color, size, focused }) => <Send color={color} size={size} strokeWidth={focused ? 2.6 : 2} /> }}
      />
      <Tabs.Screen
        name="convert"
        options={{ title: 'Convert', tabBarIcon: ({ color, size, focused }) => <ArrowLeftRight color={color} size={size} strokeWidth={focused ? 2.6 : 2} /> }}
      />
      <Tabs.Screen
        name="rates"
        options={{ title: 'Rates', tabBarIcon: ({ color, size, focused }) => <TrendingUp color={color} size={size} strokeWidth={focused ? 2.6 : 2} /> }}
      />
    </Tabs>
  );
}
