import React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { NavigationContainer, DefaultTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useAuth } from '@/context/AuthContext';
import { LoginScreen } from '@/screens/LoginScreen';
import { OrgSelectScreen } from '@/screens/OrgSelectScreen';
import { EventListScreen } from '@/screens/EventListScreen';
import { SessionSelectScreen } from '@/screens/SessionSelectScreen';
import { ScannerScreen } from '@/screens/ScannerScreen';
import { colors } from '@/theme';
import type { RootStackParamList } from '@/navigation/types';

const Stack = createNativeStackNavigator<RootStackParamList>();

const navTheme = {
  ...DefaultTheme,
  colors: {
    ...DefaultTheme.colors,
    background: colors.background,
    card: colors.surface,
    text: colors.text,
    border: colors.border,
    primary: colors.primary,
  },
};

const screenOptions = {
  headerStyle: { backgroundColor: colors.surface },
  headerTintColor: colors.text,
  headerTitleStyle: { color: colors.text },
  contentStyle: { backgroundColor: colors.background },
} as const;

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <View style={{ flex: 1, backgroundColor: colors.background, alignItems: 'center', justifyContent: 'center' }}>
      {children}
    </View>
  );
}

export function RootNavigator() {
  const { status } = useAuth();

  if (status === 'loading') {
    return (
      <Centered>
        <ActivityIndicator color={colors.primary} />
      </Centered>
    );
  }

  // Auth screens are driven entirely by the auth status, so they need no stack
  // navigation between them — render the right one directly.
  if (status !== 'authenticated') {
    return status === 'needs-org' ? <OrgSelectScreen /> : <LoginScreen />;
  }

  return (
    <NavigationContainer theme={navTheme}>
      <Stack.Navigator screenOptions={screenOptions}>
        <Stack.Screen name="EventList" component={EventListScreen} options={{ headerShown: false }} />
        <Stack.Screen name="SessionSelect" component={SessionSelectScreen} options={{ title: 'Sessions' }} />
        <Stack.Screen name="Scanner" component={ScannerScreen} options={{ title: 'Scan' }} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
