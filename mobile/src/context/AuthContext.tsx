import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, mobileLogin, mobileLogout } from '@/lib/api';
import { clearSession, loadSession, saveSession } from '@/lib/storage';
import type { AuthUser, MobileLoginResolved, Organisation, Tenant } from '@/types';

type Status = 'loading' | 'unauthenticated' | 'needs-org' | 'authenticated';

interface PendingOrgState {
  email: string;
  password: string;
  organisations: Organisation[];
}

interface AuthContextValue {
  status: Status;
  token: string | null;
  user: AuthUser | null;
  tenant: Tenant | null;
  pendingOrgs: Organisation[];
  /** Returns true when a token was issued, false when org selection is required. */
  login: (email: string, password: string) => Promise<boolean>;
  selectOrg: (tenantId: string) => Promise<void>;
  cancelOrgSelection: () => void;
  logout: () => Promise<void>;
  /** Called by the API layer when any request returns 401 — forces a re-login. */
  handleUnauthorized: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [pending, setPending] = useState<PendingOrgState | null>(null);

  // Restore a persisted session on cold start.
  useEffect(() => {
    let active = true;
    (async () => {
      const saved = await loadSession();
      if (!active) return;
      if (saved) {
        setToken(saved.token);
        setUser(saved.user);
        setTenant(saved.tenant);
        setStatus('authenticated');
      } else {
        setStatus('unauthenticated');
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const applyResolved = useCallback(async (resolved: MobileLoginResolved) => {
    await saveSession({ token: resolved.token, user: resolved.user, tenant: resolved.tenant });
    setToken(resolved.token);
    setUser(resolved.user);
    setTenant(resolved.tenant);
    setPending(null);
    setStatus('authenticated');
  }, []);

  const login = useCallback(
    async (email: string, password: string): Promise<boolean> => {
      const res = await mobileLogin(email.trim(), password);
      if ('requiresTenantSelection' in res && res.requiresTenantSelection) {
        setPending({ email: email.trim(), password, organisations: res.organisations || [] });
        setStatus('needs-org');
        return false;
      }
      await applyResolved(res as MobileLoginResolved);
      return true;
    },
    [applyResolved]
  );

  const selectOrg = useCallback(
    async (tenantId: string) => {
      if (!pending) throw new Error('No pending login');
      const res = await mobileLogin(pending.email, pending.password, tenantId);
      if ('requiresTenantSelection' in res && res.requiresTenantSelection) {
        // Should not happen once a tenant is supplied, but guard anyway.
        throw new ApiError(400, 'Could not select that organisation. Please try again.');
      }
      await applyResolved(res as MobileLoginResolved);
    },
    [pending, applyResolved]
  );

  const cancelOrgSelection = useCallback(() => {
    setPending(null);
    setStatus('unauthenticated');
  }, []);

  const resetToUnauthenticated = useCallback(async () => {
    await clearSession();
    setToken(null);
    setUser(null);
    setTenant(null);
    setPending(null);
    setStatus('unauthenticated');
  }, []);

  const logout = useCallback(async () => {
    const current = token;
    // Clear locally first so the UI is responsive even if the network call fails.
    await resetToUnauthenticated();
    if (current) {
      try {
        await mobileLogout(current);
      } catch {
        // Logout is best-effort; the token is already cleared locally.
      }
    }
  }, [token, resetToUnauthenticated]);

  // Keep a stable callback the API layer can hold onto for global 401 handling.
  const unauthorizedRef = useRef(resetToUnauthenticated);
  unauthorizedRef.current = resetToUnauthenticated;
  const handleUnauthorized = useCallback(() => {
    void unauthorizedRef.current();
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      token,
      user,
      tenant,
      pendingOrgs: pending?.organisations || [],
      login,
      selectOrg,
      cancelOrgSelection,
      logout,
      handleUnauthorized,
    }),
    [status, token, user, tenant, pending, login, selectOrg, cancelOrgSelection, logout, handleUnauthorized]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
