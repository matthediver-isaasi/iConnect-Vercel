import * as SecureStore from 'expo-secure-store';

const TOKEN_KEY = 'iconnect_checkin_token';
const TENANT_KEY = 'iconnect_checkin_tenant';
const USER_KEY = 'iconnect_checkin_user';

import type { AuthUser, Tenant } from '@/types';

export interface PersistedSession {
  token: string;
  user: AuthUser;
  tenant: Tenant;
}

export async function saveSession(session: PersistedSession): Promise<void> {
  await Promise.all([
    SecureStore.setItemAsync(TOKEN_KEY, session.token),
    SecureStore.setItemAsync(TENANT_KEY, JSON.stringify(session.tenant)),
    SecureStore.setItemAsync(USER_KEY, JSON.stringify(session.user)),
  ]);
}

export async function loadSession(): Promise<PersistedSession | null> {
  const [token, tenantRaw, userRaw] = await Promise.all([
    SecureStore.getItemAsync(TOKEN_KEY),
    SecureStore.getItemAsync(TENANT_KEY),
    SecureStore.getItemAsync(USER_KEY),
  ]);
  if (!token || !tenantRaw || !userRaw) return null;
  try {
    return {
      token,
      tenant: JSON.parse(tenantRaw) as Tenant,
      user: JSON.parse(userRaw) as AuthUser,
    };
  } catch {
    return null;
  }
}

export async function clearSession(): Promise<void> {
  await Promise.all([
    SecureStore.deleteItemAsync(TOKEN_KEY),
    SecureStore.deleteItemAsync(TENANT_KEY),
    SecureStore.deleteItemAsync(USER_KEY),
  ]);
}
