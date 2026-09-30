import React, { useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { Screen } from '@/components/Screen';
import { Button } from '@/components/Button';
import { useAuth } from '@/context/AuthContext';
import { ApiError } from '@/lib/api';
import { colors, radius, spacing } from '@/theme';

export function OrgSelectScreen() {
  const { pendingOrgs, selectOrg, cancelOrgSelection } = useAuth();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onSelect = async (tenantId: string) => {
    setBusyId(tenantId);
    setError(null);
    try {
      await selectOrg(tenantId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not select that organisation.');
      setBusyId(null);
    }
  };

  return (
    <Screen>
      <View style={styles.header}>
        <Text style={styles.title}>Choose an organisation</Text>
        <Text style={styles.subtitle}>Your account belongs to more than one organisation.</Text>
      </View>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <FlatList
        data={pendingOrgs}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.list}
        renderItem={({ item }) => (
          <Pressable
            testID={`button-org-${item.id}`}
            onPress={() => onSelect(item.id)}
            disabled={!!busyId}
            style={({ pressed }) => [styles.row, { opacity: pressed ? 0.85 : 1 }]}
          >
            <View style={styles.rowText}>
              <Text style={styles.orgName}>{item.name || 'Organisation'}</Text>
              {item.role ? <Text style={styles.orgMeta}>{item.role}</Text> : null}
            </View>
            {busyId === item.id ? <Text style={styles.orgMeta}>Signing in…</Text> : null}
          </Pressable>
        )}
      />

      <Button title="Back to sign in" variant="secondary" onPress={cancelOrgSelection} />
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
    fontSize: 22,
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
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  rowText: {
    flexShrink: 1,
    gap: 2,
  },
  orgName: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '600',
  },
  orgMeta: {
    color: colors.textMuted,
    fontSize: 13,
  },
  error: {
    color: colors.danger,
    fontSize: 14,
    marginBottom: spacing.sm,
  },
});
