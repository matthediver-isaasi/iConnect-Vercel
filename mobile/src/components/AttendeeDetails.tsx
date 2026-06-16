import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors, radius, spacing } from '@/theme';
import type { ResolvedCheckin } from '@/types';

function fullName(r: ResolvedCheckin): string {
  const a = r.attendee?.first_name?.trim() || '';
  const b = r.attendee?.last_name?.trim() || '';
  return [a, b].filter(Boolean).join(' ') || 'Attendee';
}

function formatDate(value?: string | null): string {
  if (!value) return '';
  try {
    return new Date(value).toLocaleString(undefined, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return value;
  }
}

interface BannerProps {
  label: string;
  surface: string;
  textColor: string;
  detail?: string | null;
}

function Banner({ label, surface, textColor, detail }: BannerProps) {
  return (
    <View style={[styles.banner, { backgroundColor: surface }]}>
      <Text style={[styles.bannerLabel, { color: textColor }]}>{label}</Text>
      {detail ? <Text style={[styles.bannerDetail, { color: textColor }]}>{detail}</Text> : null}
    </View>
  );
}

export function AttendeeDetails({ resolved }: { resolved: ResolvedCheckin }) {
  const a = resolved.attendee;
  const dietary = (a?.dietary_selections || []).filter(Boolean);
  const allergies = (a?.allergy_selections || []).filter((x) => x && x.name);
  const accessibility = (a?.accessibility_selections || []).filter(Boolean);

  return (
    <View style={styles.container}>
      {/* Flags */}
      {resolved.flags?.length > 0 &&
        resolved.flags.map((flag) => (
          <Banner
            key={flag.field_id}
            label={flag.label}
            surface={colors.accent}
            textColor="#FFFFFF"
          />
        ))}

      {/* Indicators */}
      {a?.badge ? <Banner label="Badge" surface={colors.surfaceAlt} textColor={colors.text} /> : null}
      {a?.buddy ? <Banner label="Buddy" surface={colors.surfaceAlt} textColor={colors.text} /> : null}
      {a?.isSpeaker ? (
        <Banner
          label={a.speakerName ? `Speaker · ${a.speakerName}` : 'Speaker'}
          surface={colors.primary}
          textColor={colors.primaryText}
        />
      ) : null}
      {a?.designation ? (
        <Banner label={a.designation} surface={colors.accent} textColor="#FFFFFF" />
      ) : null}

      {/* Dietary / allergies / accessibility */}
      {dietary.length > 0 ? (
        <Banner label="Dietary" detail={dietary.join(', ')} surface={colors.warningSurface} textColor={colors.warning} />
      ) : null}
      {allergies.length > 0 ? (
        <Banner
          label="Allergies"
          detail={allergies.map((x) => (x.severity ? `${x.name} (${x.severity})` : x.name)).join(', ')}
          surface={colors.dangerSurface}
          textColor={colors.danger}
        />
      ) : null}
      {accessibility.length > 0 ? (
        <Banner label="Accessibility" detail={accessibility.join(', ')} surface={colors.surfaceAlt} textColor={colors.text} />
      ) : null}

      {/* Name + details */}
      <Text style={styles.name} testID="text-attendee-name">
        {fullName(resolved)}
      </Text>
      {a?.email ? <Text style={styles.muted}>{a.email}</Text> : null}

      <View style={styles.metaBlock}>
        <Text style={styles.metaTitle}>{resolved.event?.title}</Text>
        {resolved.event?.start_date ? (
          <Text style={styles.muted}>{formatDate(resolved.event.start_date)}</Text>
        ) : null}
      </View>

      {resolved.session ? (
        <View style={styles.metaBlock}>
          <Text style={styles.metaTitle}>{resolved.session.title}</Text>
          {resolved.session.track_name ? (
            <Text style={styles.muted}>{resolved.session.track_name}</Text>
          ) : null}
        </View>
      ) : null}

      {resolved.session?.location || resolved.event?.location ? (
        <Text style={styles.muted}>{resolved.session?.location || resolved.event?.location}</Text>
      ) : null}

      {resolved.ticketClassName ? (
        <Text style={styles.muted}>Ticket: {resolved.ticketClassName}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: spacing.sm,
  },
  banner: {
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  bannerLabel: {
    fontSize: 15,
    fontWeight: '700',
  },
  bannerDetail: {
    fontSize: 14,
    marginTop: 2,
    fontWeight: '500',
  },
  name: {
    color: colors.text,
    fontSize: 22,
    fontWeight: '700',
    marginTop: spacing.xs,
  },
  muted: {
    color: colors.textMuted,
    fontSize: 14,
  },
  metaBlock: {
    marginTop: spacing.xs,
  },
  metaTitle: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '600',
  },
});
