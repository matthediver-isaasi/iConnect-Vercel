import React, { useMemo } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Screen } from '@/components/Screen';
import { Button } from '@/components/Button';
import { useAuth } from '@/context/AuthContext';
import { ApiError, listEvents } from '@/lib/api';
import { colors, radius, spacing } from '@/theme';
import type { EventSummary } from '@/types';
import type { RootStackParamList } from '@/navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'EventList'>;

function isToday(ev: EventSummary): boolean {
  if (!ev.start_date) return false;
  const dayOf = (v?: string | null) => {
    if (!v) return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  };
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const start = dayOf(ev.start_date);
  if (start == null) return false;
  const end = ev.end_date ? dayOf(ev.end_date) ?? start : start;
  return start <= today && today <= end;
}

export function EventListScreen({ navigation }: Props) {
  const { token, tenant, user, logout, handleUnauthorized } = useAuth();

  const { data, isLoading, isError, error, refetch, isRefetching } = useQuery({
    queryKey: ['events', tenant?.id],
    queryFn: async () => {
      try {
        return await listEvents(token!);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) handleUnauthorized();
        throw err;
      }
    },
    enabled: !!token,
  });

  const events = useMemo(
    () => [...(data || [])].sort((a, b) => (a.title || '').localeCompare(b.title || '')),
    [data]
  );
  const todays = useMemo(() => events.filter(isToday), [events]);

  const openEvent = (ev: EventSummary) => {
    if (ev.type === 'complex') {
      navigation.navigate('SessionSelect', { eventId: ev.id, eventTitle: ev.title });
    } else {
      navigation.navigate('Scanner', { eventId: ev.id, eventType: 'simple', eventTitle: ev.title });
    }
  };

  const renderEvent = (ev: EventSummary, prefix: string) => (
    <Pressable
      testID={`${prefix}-${ev.id}`}
      onPress={() => openEvent(ev)}
      style={({ pressed }) => [styles.row, { opacity: pressed ? 0.85 : 1 }]}
    >
      <View style={styles.rowText}>
        <Text style={styles.eventTitle}>{ev.title}</Text>
        {ev.type === 'complex' ? <Text style={styles.badge}>multi-session</Text> : null}
      </View>
    </Pressable>
  );

  return (
    <Screen padded={false}>
      <View style={styles.headerBar}>
        <View style={styles.headerText}>
          <Text style={styles.title}>Select an event</Text>
          <Text style={styles.subtitle} numberOfLines={1}>
            {tenant?.name || 'Organisation'}
            {user?.email ? ` · ${user.email}` : ''}
          </Text>
        </View>
        <Pressable testID="button-logout" onPress={() => void logout()} hitSlop={8}>
          <Text style={styles.logout}>Sign out</Text>
        </Pressable>
      </View>

      {isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : isError ? (
        <View style={styles.center}>
          <Text style={styles.error}>
            {error instanceof ApiError ? error.message : 'Failed to load events.'}
          </Text>
          <Button title="Retry" variant="secondary" onPress={() => void refetch()} />
        </View>
      ) : events.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.muted}>No in-person events available for check-in.</Text>
          <Button title="Refresh" variant="secondary" onPress={() => void refetch()} />
        </View>
      ) : (
        <FlatList
          data={events}
          keyExtractor={(item) => `${item.type}-${item.id}`}
          contentContainerStyle={styles.list}
          refreshing={isRefetching}
          onRefresh={() => void refetch()}
          ListHeaderComponent={
            todays.length > 0 ? (
              <View style={styles.todaySection}>
                <Text style={styles.sectionLabel}>Running today</Text>
                {todays.map((ev) => (
                  <View key={`today-${ev.id}`}>{renderEvent(ev, 'button-today-event')}</View>
                ))}
                <Text style={[styles.sectionLabel, styles.allLabel]}>All events</Text>
              </View>
            ) : null
          }
          renderItem={({ item }) => renderEvent(item, 'button-event')}
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  headerBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomColor: colors.border,
    borderBottomWidth: 1,
  },
  headerText: {
    flexShrink: 1,
    gap: 2,
  },
  title: {
    color: colors.text,
    fontSize: 20,
    fontWeight: '700',
  },
  subtitle: {
    color: colors.textMuted,
    fontSize: 13,
  },
  logout: {
    color: colors.primary,
    fontSize: 15,
    fontWeight: '600',
  },
  list: {
    padding: spacing.md,
    gap: spacing.sm,
  },
  todaySection: {
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  sectionLabel: {
    color: colors.textMuted,
    fontSize: 13,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  allLabel: {
    marginTop: spacing.sm,
  },
  row: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.md,
  },
  rowText: {
    gap: 4,
  },
  eventTitle: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '600',
  },
  badge: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: '600',
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
    padding: spacing.lg,
  },
  muted: {
    color: colors.textMuted,
    fontSize: 15,
    textAlign: 'center',
  },
  error: {
    color: colors.danger,
    fontSize: 15,
    textAlign: 'center',
  },
});
