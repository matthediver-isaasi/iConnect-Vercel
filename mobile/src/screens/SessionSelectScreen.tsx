import React from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Screen } from '@/components/Screen';
import { Button } from '@/components/Button';
import { useAuth } from '@/context/AuthContext';
import { ApiError, getDashboard } from '@/lib/api';
import { colors, radius, spacing } from '@/theme';
import type { DashboardSession } from '@/types';
import type { RootStackParamList } from '@/navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'SessionSelect'>;

export function SessionSelectScreen({ navigation, route }: Props) {
  const { eventId, eventTitle } = route.params;
  const { token, handleUnauthorized } = useAuth();

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['sessions', eventId],
    queryFn: async () => {
      try {
        return await getDashboard(token!, { eventId, eventType: 'complex' });
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) handleUnauthorized();
        throw err;
      }
    },
    enabled: !!token,
  });

  const sessions = data?.sessions || [];

  const openScanner = (session?: DashboardSession) => {
    navigation.navigate('Scanner', {
      eventId,
      eventType: 'complex',
      eventTitle,
      sessionId: session?.id,
      sessionTitle: session?.title,
    });
  };

  return (
    <Screen>
      <View style={styles.header}>
        <Text style={styles.title}>{eventTitle}</Text>
        <Text style={styles.subtitle}>Pick a session to track at the door.</Text>
      </View>

      {isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : isError ? (
        <View style={styles.center}>
          <Text style={styles.error}>
            {error instanceof ApiError ? error.message : 'Failed to load sessions.'}
          </Text>
          <Button title="Retry" variant="secondary" onPress={() => void refetch()} />
        </View>
      ) : (
        <FlatList
          data={sessions}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.list}
          ListHeaderComponent={
            <Pressable
              testID="button-session-all"
              onPress={() => openScanner(undefined)}
              style={({ pressed }) => [styles.row, styles.allRow, { opacity: pressed ? 0.85 : 1 }]}
            >
              <Text style={styles.sessionTitle}>All sessions</Text>
              <Text style={styles.muted}>Scan codes for any session of this event</Text>
            </Pressable>
          }
          ListEmptyComponent={
            <Text style={styles.muted}>No in-person sessions found for this event.</Text>
          }
          renderItem={({ item }) => (
            <Pressable
              testID={`button-session-${item.id}`}
              onPress={() => openScanner(item)}
              style={({ pressed }) => [styles.row, { opacity: pressed ? 0.85 : 1 }]}
            >
              <Text style={styles.sessionTitle}>{item.title}</Text>
            </Pressable>
          )}
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: {
    gap: spacing.xs,
    marginBottom: spacing.md,
  },
  title: {
    color: colors.text,
    fontSize: 20,
    fontWeight: '700',
  },
  subtitle: {
    color: colors.textMuted,
    fontSize: 15,
  },
  list: {
    gap: spacing.sm,
    paddingBottom: spacing.md,
  },
  row: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: 4,
  },
  allRow: {
    borderColor: colors.primary,
  },
  sessionTitle: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '600',
  },
  muted: {
    color: colors.textMuted,
    fontSize: 14,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
  },
  error: {
    color: colors.danger,
    fontSize: 15,
    textAlign: 'center',
  },
});
