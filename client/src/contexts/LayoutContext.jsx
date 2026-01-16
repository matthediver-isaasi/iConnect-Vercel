import { createContext, useContext, useState, useCallback } from 'react';

const LayoutContext = createContext({
  forcePublicLayout: false,
  setForcePublicLayout: () => {},
  hasBanner: false,
  setHasBanner: () => {},
  portalBanner: null,
  setPortalBanner: () => {},
  memberInfo: null,
  setMemberInfo: () => {},
  organizationInfo: null,
  setOrganizationInfo: () => {},
  memberRole: null,
  setMemberRole: () => {},
  // isAdmin removed - access control now uses isFeatureExcluded() exclusively
  isFeatureExcluded: () => false,
  setIsFeatureExcluded: () => {},
  refreshOrganizationInfo: () => {},
  setRefreshOrganizationInfo: () => {},
  reloadMemberInfo: () => {},
  setReloadMemberInfo: () => {},
  // SECURITY: Session validation flag - true only after /api/auth/me succeeds
  // Hooks should require BOTH memberInfo AND sessionValidated to treat user as authenticated
  sessionValidated: false,
  setSessionValidated: () => {},
});

export function LayoutProvider({ children }) {
  const [forcePublicLayout, setForcePublicLayout] = useState(false);
  const [hasBanner, setHasBannerState] = useState(false);
  const [portalBanner, setPortalBannerState] = useState(null);
  const [memberInfo, setMemberInfoState] = useState(null);
  const [organizationInfo, setOrganizationInfoState] = useState(null);
  const [memberRole, setMemberRoleState] = useState(null);
  // isAdmin state removed - access control now uses isFeatureExcluded() exclusively
  const [isFeatureExcludedFn, setIsFeatureExcludedFn] = useState(() => () => false);
  const [refreshOrganizationInfoFn, setRefreshOrganizationInfoFn] = useState(() => () => {});
  const [reloadMemberInfoFn, setReloadMemberInfoFn] = useState(() => () => {});
  // SECURITY: Session validation flag - starts false, set true only after /api/auth/me succeeds
  const [sessionValidated, setSessionValidatedState] = useState(false);
  
  const setLayout = useCallback((value) => {
    setForcePublicLayout(value);
  }, []);

  const setHasBanner = useCallback((value) => {
    setHasBannerState(value);
  }, []);

  const setPortalBanner = useCallback((value) => {
    setPortalBannerState(value);
  }, []);

  const setMemberInfo = useCallback((value) => {
    setMemberInfoState(value);
  }, []);

  const setOrganizationInfo = useCallback((value) => {
    setOrganizationInfoState(value);
  }, []);

  const setMemberRole = useCallback((value) => {
    setMemberRoleState(value);
  }, []);

  // setIsAdmin removed - access control now uses isFeatureExcluded() exclusively

  const setIsFeatureExcluded = useCallback((fn) => {
    setIsFeatureExcludedFn(() => fn);
  }, []);

  const setRefreshOrganizationInfo = useCallback((fn) => {
    setRefreshOrganizationInfoFn(() => fn);
  }, []);

  const setReloadMemberInfo = useCallback((fn) => {
    setReloadMemberInfoFn(() => fn);
  }, []);

  const setSessionValidated = useCallback((value) => {
    setSessionValidatedState(value);
  }, []);

  return (
    <LayoutContext.Provider value={{ 
      forcePublicLayout, 
      setForcePublicLayout: setLayout,
      hasBanner,
      setHasBanner,
      portalBanner,
      setPortalBanner,
      memberInfo,
      setMemberInfo,
      organizationInfo,
      setOrganizationInfo,
      memberRole,
      setMemberRole,
      // isAdmin removed - access control now uses isFeatureExcluded() exclusively
      isFeatureExcluded: isFeatureExcludedFn,
      setIsFeatureExcluded,
      refreshOrganizationInfo: refreshOrganizationInfoFn,
      setRefreshOrganizationInfo,
      reloadMemberInfo: reloadMemberInfoFn,
      setReloadMemberInfo,
      // SECURITY: Session validation flag
      sessionValidated,
      setSessionValidated,
    }}>
      {children}
    </LayoutContext.Provider>
  );
}

export function useLayoutContext() {
  return useContext(LayoutContext);
}

export default LayoutContext;
