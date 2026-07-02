import React, { useCallback, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useQuery } from '@tanstack/react-query';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Button } from '@/components/Button';
import { AttendeeDetails } from '@/components/AttendeeDetails';
import { useAuth } from '@/context/AuthContext';
import {
  ApiError,
  extractToken,
  getDashboard,
  markAttended,
  resolveToken,
  undoAttended,
} from '@/lib/api';
import { COUNTER_POLL_INTERVAL_MS } from '@/config';
import { colors, radius, spacing } from '@/theme';
import type { ResolvedCheckin } from '@/types';
import type { RootStackParamList } from '@/navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'Scanner'>;

function formatDate(value?: string | null): string {
  if (!value) return '';
  try {
    return new Date(value).toLocaleString(undefined, {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return value;
  }
}

export function ScannerScreen({ route }: Props) {
  const { eventId, eventType, eventTitle, sessionId, sessionTitle } = route.params;
  const { token, handleUnauthorized } = useAuth();
  const [permission, requestPermission] = useCameraPermissions();

  // Scan / resolve state.
  const [resolved, setResolved] = useState<ResolvedCheckin | null>(null);
  const [resolving, setResolving] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [undoOpen, setUndoOpen] = useState(false);
  const [undoReason, setUndoReason] = useState('');
  // Guards repeated barcode callbacks while we process one scan.
  const lockedRef = useRef(false);

  const onApiError = useCallback(
    (err: unknown, fallback: string): string => {
      if (err instanceof ApiError) {
        if (err.status === 401) handleUnauthorized();
        return err.message;
      }
      return fallback;
    },
    [handleUnauthorized]
  );

  const counter = useQuery({
    queryKey: ['dashboard', eventId, eventType, sessionId ?? 'all'],
    queryFn: async () => {
      try {
        return await getDashboard(token!, { eventId, eventType, sessionId });
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) handleUnauthorized();
        throw err;
      }
    },
    enabled: !!token,
    refetchInterval: COUNTER_POLL_INTERVAL_MS,
  });

  const counts = counter.data?.counts;

  const resetScan = useCallback(() => {
    setResolved(null);
    setScanError(null);
    setResolving(false);
    setUndoOpen(false);
    setUndoReason('');
    lockedRef.current = false;
  }, []);

  const handleScanned = useCallback(
    async (raw: string) => {
      if (lockedRef.current) return;
      lockedRef.current = true;
      setResolving(true);
      setScanError(null);
      setResolved(null);

      const checkinToken = extractToken(raw);
      if (!checkinToken) {
        setScanError('That QR code is not a valid check-in code.');
        setResolving(false);
        return;
      }
      try {
        const data = await resolveToken(token!, checkinToken);
        setResolved(data);
      } catch (err) {
        const message =
          err instanceof ApiError && (err.status === 404 || err.status === 403)
            ? 'This check-in code is invalid, expired, or for another organisation.'
            : onApiError(err, 'Could not look up that code. Try again.');
        setScanError(message);
      } finally {
        setResolving(false);
      }
    },
    [token, onApiError]
  );

  const onMark = useCallback(async () => {
    if (!resolved) return;
    setActionBusy(true);
    try {
      const res = await markAttended(token!, resolved.token);
      setResolved(res.data);
      void counter.refetch();
    } catch (err) {
      setScanError(onApiError(err, 'Check-in failed. Try again.'));
    } finally {
      setActionBusy(false);
    }
  }, [resolved, token, counter, onApiError]);

  const onUndo = useCallback(async () => {
    if (!resolved) return;
    const reason = undoReason.trim();
    if (!reason) return;
    setActionBusy(true);
    try {
      const data = await undoAttended(token!, resolved.token, reason);
      setResolved(data);
      setUndoOpen(false);
      setUndoReason('');
      void counter.refetch();
    } catch (err) {
      setScanError(onApiError(err, 'Could not undo the check-in. Try again.'));
    } finally {
      setActionBusy(false);
    }
  }, [resolved, undoReason, token, counter, onApiError]);

  // Permission gates.
  if (!permission) {
    return (
      <View style={styles.permissionWrap}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }
  if (!permission.granted) {
    return (
      <View style={styles.permissionWrap}>
        <Text style={styles.permissionTitle}>Camera access needed</Text>
        <Text style={styles.permissionBody}>
          Allow camera access to scan attendee check-in QR codes at the door.
        </Text>
        <Button title="Grant camera access" onPress={() => void requestPermission()} />
      </View>
    );
  }

  const showOverlay = resolving || !!resolved || !!scanError;
  const cameraActive = !showOverlay;

  return (
    <View style={styles.root}>
      {/* Live counter */}
      <SafeAreaView edges={['top']} style={styles.counterBar}>
        <View style={styles.counterText}>
          <Text style={styles.counterEvent} numberOfLines={1}>
            {sessionTitle || eventTitle}
          </Text>
          {counts ? (
            <Text style={styles.counterValue} testID="text-counter">
              {counts.attended} of {counts.total} arrived
            </Text>
          ) : (
            <Text style={styles.counterValue}>—</Text>
          )}
        </View>
        <Pressable onPress={() => void counter.refetch()} hitSlop={8}>
          <Text style={styles.refresh}>Refresh</Text>
        </Pressable>
      </SafeAreaView>

      {/* Camera */}
      <View style={styles.cameraWrap}>
        {cameraActive ? (
          <CameraView
            style={StyleSheet.absoluteFill}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={({ data }) => void handleScanned(data)}
          />
        ) : (
          <View style={[StyleSheet.absoluteFill, styles.cameraPaused]} />
        )}
        {cameraActive ? (
          <View pointerEvents="none" style={styles.reticleWrap}>
            <View style={styles.reticle} />
            <Text style={styles.reticleHint}>Point at an attendee's QR code</Text>
          </View>
        ) : null}
      </View>

      {/* Result overlay */}
      {showOverlay ? (
        <SafeAreaView edges={['bottom']} style={styles.sheet}>
          <ScrollView contentContainerStyle={styles.sheetContent}>
            {resolving ? (
              <View style={styles.sheetCenter}>
                <ActivityIndicator color={colors.primary} />
                <Text style={styles.muted}>Looking up code…</Text>
              </View>
            ) : scanError ? (
              <View style={styles.sheetCenter}>
                <Text style={styles.errorTitle}>Unable to check in</Text>
                <Text style={styles.errorBody} testID="text-scan-error">
                  {scanError}
                </Text>
                <Button title="Scan next" onPress={resetScan} testID="button-scan-next" />
              </View>
            ) : resolved ? (
              <View style={styles.resultBody}>
                <AttendeeDetails resolved={resolved} />

                {resolved.alreadyCheckedIn ? (
                  <View style={styles.alreadyBox}>
                    <Text style={styles.alreadyTitle}>Already checked in</Text>
                    {resolved.checkedInAt ? (
                      <Text style={styles.muted}>{formatDate(resolved.checkedInAt)}</Text>
                    ) : null}
                  </View>
                ) : null}

                <View style={styles.actions}>
                  {resolved.alreadyCheckedIn ? (
                    <Button
                      title="Undo check-in"
                      variant="danger"
                      onPress={() => setUndoOpen(true)}
                      disabled={actionBusy}
                      testID="button-undo"
                    />
                  ) : (
                    <Button
                      title="Mark attended"
                      variant="success"
                      onPress={onMark}
                      loading={actionBusy}
                      testID="button-mark-attended"
                    />
                  )}
                  <Button title="Scan next" variant="secondary" onPress={resetScan} testID="button-scan-next" />
                </View>
              </View>
            ) : null}
          </ScrollView>
        </SafeAreaView>
      ) : null}

      {/* Undo reason modal */}
      <Modal visible={undoOpen} transparent animationType="fade" onRequestClose={() => setUndoOpen(false)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Undo check-in</Text>
            <Text style={styles.muted}>Enter a reason for deregistering this attendee.</Text>
            <TextInput
              testID="input-undo-reason"
              value={undoReason}
              onChangeText={setUndoReason}
              placeholder="Reason"
              placeholderTextColor={colors.textMuted}
              style={styles.modalInput}
              multiline
            />
            <View style={styles.modalActions}>
              <Button
                title="Cancel"
                variant="secondary"
                onPress={() => {
                  setUndoOpen(false);
                  setUndoReason('');
                }}
                style={styles.modalBtn}
              />
              <Button
                title="Confirm undo"
                variant="danger"
                onPress={onUndo}
                loading={actionBusy}
                disabled={!undoReason.trim()}
                style={styles.modalBtn}
                testID="button-confirm-undo"
              />
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#000',
  },
  counterBar: {
    backgroundColor: colors.surface,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
    gap: spacing.sm,
  },
  counterText: {
    flexShrink: 1,
  },
  counterEvent: {
    color: colors.textMuted,
    fontSize: 13,
  },
  counterValue: {
    color: colors.text,
    fontSize: 20,
    fontWeight: '700',
  },
  refresh: {
    color: colors.primary,
    fontSize: 15,
    fontWeight: '600',
  },
  cameraWrap: {
    flex: 1,
    backgroundColor: '#000',
  },
  cameraPaused: {
    backgroundColor: '#000',
  },
  reticleWrap: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
  },
  reticle: {
    width: 220,
    height: 220,
    borderColor: 'rgba(255,255,255,0.9)',
    borderWidth: 3,
    borderRadius: radius.lg,
  },
  reticleHint: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
    backgroundColor: 'rgba(0,0,0,0.45)',
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.sm,
  },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    maxHeight: '70%',
  },
  sheetContent: {
    padding: spacing.md,
  },
  sheetCenter: {
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.lg,
  },
  resultBody: {
    gap: spacing.md,
  },
  actions: {
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  alreadyBox: {
    backgroundColor: colors.successSurface,
    borderRadius: radius.md,
    padding: spacing.md,
    alignItems: 'center',
    gap: 2,
  },
  alreadyTitle: {
    color: colors.success,
    fontSize: 16,
    fontWeight: '700',
  },
  muted: {
    color: colors.textMuted,
    fontSize: 14,
    textAlign: 'center',
  },
  errorTitle: {
    color: colors.danger,
    fontSize: 18,
    fontWeight: '700',
  },
  errorBody: {
    color: colors.text,
    fontSize: 15,
    textAlign: 'center',
  },
  permissionWrap: {
    flex: 1,
    backgroundColor: colors.background,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
    padding: spacing.lg,
  },
  permissionTitle: {
    color: colors.text,
    fontSize: 20,
    fontWeight: '700',
  },
  permissionBody: {
    color: colors.textMuted,
    fontSize: 15,
    textAlign: 'center',
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg,
  },
  modalCard: {
    width: '100%',
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  modalTitle: {
    color: colors.text,
    fontSize: 18,
    fontWeight: '700',
  },
  modalInput: {
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.md,
    color: colors.text,
    fontSize: 15,
    minHeight: 80,
    textAlignVertical: 'top',
  },
  modalActions: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  modalBtn: {
    flex: 1,
  },
});
