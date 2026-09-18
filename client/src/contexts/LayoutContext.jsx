import { createContext, useContext, useState, useCallback, useMemo } from 'react';
import { RouteLayoutContext } from './RouteLayoutContext';
import { canvasSnapshotMatchesMember, EMPTY_CANVAS_MEMBER_VALUES, getCanvasMemberValues } from '../lib/canvasViewerValues';
export { usePageLayoutDecision } from './RouteLayoutContext';

const LayoutContext = createContext({
  forcePublicLayout: false,
  setForcePublicLayout: () => {},
  forceBlankLayout: false,
  setForceBlankLayout: () => {},
  publicChrome: 'both',
  setPublicChrome: () => {},
  chromeReady: true,
  setChromeReady: () => {},
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
  // SECURITY: Auth resolution flag - true once /api/auth/me completes (success OR failure)
  // This tells hooks that auth check is complete and they can safely gate queries
  authResolved: false,
  setAuthResolved: () => {},
  canvasMemberValues: EMPTY_CANVAS_MEMBER_VALUES,
  setCanvasMemberSnapshot: () => {},
});

export function LayoutProvider({ children }) {
  const [forcePublicLayout, setForcePublicLayout] = useState(false);
  const [forceBlankLayout, setForceBlankLayoutState] = useState(false);
  // Per-page public chrome control: 'both' | 'none' | 'header' | 'footer'.
  // Read by PublicLayout; set by DynamicPage / ViewPage from the page record.
  const [publicChrome, setPublicChromeState] = useState('both');
  const [chromeReady, setChromeReadyState] = useState(true);
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
  // SECURITY: Auth resolution flag - true once /api/auth/me completes (success OR failure)
  const [authResolved, setAuthResolvedState] = useState(false);
  // Deliberately separate from memberInfo/organizationInfo: those can be
  // hydrated from localStorage. Only the successful /auth/me request sets this.
  const [canvasMemberSnapshot, setCanvasMemberSnapshot] = useState(null);
  const canvasMemberValues = useMemo(() => getCanvasMemberValues({
    snapshot: canvasMemberSnapshot, member: memberInfo, sessionValidated, authResolved,
  }), [canvasMemberSnapshot, memberInfo, sessionValidated, authResolved]);
  
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
    setCanvasMemberSnapshot(current => canvasSnapshotMatchesMember(current, value) ? current : null);
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
    if (!value) setCanvasMemberSnapshot(null);
    setSessionValidatedState(value);
  }, []);

  const setAuthResolved = useCallback((value) => {
    if (!value) setCanvasMemberSnapshot(null);
    setAuthResolvedState(value);
  }, []);

  const setForceBlankLayout = useCallback((value) => {
    setForceBlankLayoutState(value);
  }, []);

  const setPublicChrome = useCallback((value) => {
    setPublicChromeState(value || 'both');
  }, []);

  const setChromeReady = useCallback((value) => {
    setChromeReadyState(value);
  }, []);

  return (
    <LayoutContext.Provider value={{ 
      forcePublicLayout, 
      setForcePublicLayout: setLayout,
      forceBlankLayout,
      setForceBlankLayout,
      publicChrome,
      setPublicChrome,
      chromeReady,
      setChromeReady,
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
      // SECURITY: Auth resolution flag
      authResolved,
      setAuthResolved,
        canvasMemberValues,
        setCanvasMemberSnapshot,
    }}>
      {children}
    </LayoutContext.Provider>
  );
}

export function useLayoutContext() {
  const layout = useContext(LayoutContext);
  const routeLayout = useContext(RouteLayoutContext);
  return routeLayout ? { ...layout, ...routeLayout } : layout;
}

export default LayoutContext;
