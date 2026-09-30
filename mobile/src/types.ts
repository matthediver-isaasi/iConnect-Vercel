// Shared API types mirroring the iConnect REST contract the app consumes.

export type EventType = 'simple' | 'complex';

export interface AuthUser {
  id: string;
  email: string;
  first_name?: string | null;
  last_name?: string | null;
  role?: string | null;
  role_id?: string | null;
  userType: 'tenant_user' | 'member';
}

export interface Tenant {
  id: string;
  name?: string | null;
  slug?: string | null;
  logo_url?: string | null;
}

export interface Organisation {
  id: string;
  name?: string | null;
  slug?: string | null;
  logo_url?: string | null;
  role?: string | null;
  membership_type?: string | null;
  is_default?: boolean;
}

export interface MobileLoginResolved {
  success: true;
  token: string;
  expiresAt: string;
  tokenType: 'Bearer';
  user: AuthUser;
  tenant: Tenant;
  hasMultipleTenants: boolean;
}

export interface MobileLoginNeedsOrg {
  success: true;
  requiresTenantSelection: true;
  identity: { id: string; email: string; first_name?: string; last_name?: string };
  organisations: Organisation[];
}

export type MobileLoginResponse = MobileLoginResolved | MobileLoginNeedsOrg;

export interface EventSummary {
  id: string;
  title: string;
  start_date?: string | null;
  end_date?: string | null;
  type: EventType;
}

export interface AllergySelection {
  name: string;
  severity?: string | null;
}

export interface CheckinFlag {
  field_id: string;
  label: string;
  color?: string | null;
  form_submission_id?: string | null;
}

export interface Attendee {
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
  profile_photo_url?: string | null;
  designation?: string | null;
  buddy?: boolean;
  badge?: boolean;
  isSpeaker?: boolean;
  speakerName?: string | null;
  dietary_selections?: string[] | null;
  allergy_selections?: AllergySelection[] | null;
  accessibility_selections?: string[] | null;
  ticket_class_name?: string | null;
}

export interface ResolvedCheckin {
  type: EventType;
  token: string;
  attendee: Attendee | null;
  event: { id: string; title?: string | null; start_date?: string | null; location?: string | null; is_online?: boolean } | null;
  session: {
    id: string;
    title?: string | null;
    start_time?: string | null;
    end_time?: string | null;
    location?: string | null;
    track_name?: string | null;
    is_online?: boolean;
  } | null;
  ticketClassName?: string | null;
  bookingReference?: string | null;
  isOnline?: boolean;
  checkedInAt?: string | null;
  checkedInBy?: string | null;
  alreadyCheckedIn?: boolean;
  flags: CheckinFlag[];
}

export interface DashboardSession {
  id: string;
  title: string;
  track_id?: string | null;
}

export interface DashboardTrack {
  id: string;
  name: string;
}

export interface DashboardData {
  event: { id: string; title?: string | null; start_date?: string | null; location?: string | null; type: EventType };
  counts: { total: number; attended: number };
  tracks: DashboardTrack[];
  sessions: DashboardSession[];
  attendees: unknown[];
}
