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
  // shouldShowFeature combines role exclusions (for logged-in) and public visibility (for anonymous)
  // Default to false (privacy-first) until explicitly set by Layout.jsx
  shouldShowFeature: () => false,
  setShouldShowFeature: () => {},
  refreshOrganizationInfo: () => {},
  setRefreshOrganizationInfo: () => {},
  reloadMemberInfo: () => {},
  setReloadMemberInfo: () => {},
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
  // Default to false (privacy-first) until Layout.jsx sets the proper function
  const [shouldShowFeatureFn, setShouldShowFeatureFn] = useState(() => () => false);
  const [refreshOrganizationInfoFn, setRefreshOrganizationInfoFn] = useState(() => () => {});
  const [reloadMemberInfoFn, setReloadMemberInfoFn] = useState(() => () => {});
  
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

  const setShouldShowFeature = useCallback((fn) => {
    setShouldShowFeatureFn(() => fn);
  }, []);

  const setRefreshOrganizationInfo = useCallback((fn) => {
    setRefreshOrganizationInfoFn(() => fn);
  }, []);

  const setReloadMemberInfo = useCallback((fn) => {
    setReloadMemberInfoFn(() => fn);
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
      // shouldShowFeature combines role exclusions (for logged-in) and public visibility (for anonymous)
      shouldShowFeature: shouldShowFeatureFn,
      setShouldShowFeature,
      refreshOrganizationInfo: refreshOrganizationInfoFn,
      setRefreshOrganizationInfo,
      reloadMemberInfo: reloadMemberInfoFn,
      setReloadMemberInfo,
    }}>
      {children}
    </LayoutContext.Provider>
  );
}

export function useLayoutContext() {
  return useContext(LayoutContext);
}

export default LayoutContext;
