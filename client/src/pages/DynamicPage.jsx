import React, { useEffect, useMemo, useState } from "react";
import { useParams, useLocation, useNavigate } from "react-router-dom";
import { base44 } from "@/api/base44Client";
import { useQuery } from "@tanstack/react-query";
import IEditElementRenderer from "../components/iedit/IEditElementRenderer";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { useLayoutContext } from "@/contexts/LayoutContext";
import { useArticleUrl } from "@/contexts/ArticleUrlContext";
import { useBelowFirstElementBanners } from "@/contexts/BannerContext";
import PortalHeroBanner from "@/components/banners/PortalHeroBanner";
import PageBannerDisplay from "@/components/banners/PageBannerDisplay";
import Articles from "./Articles";
import ArticleView from "./ArticleView";
import ArticleEditor from "./ArticleEditor";
import PublicArticles from "./PublicArticles";

export default function DynamicPage() {
  const { slug } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const { memberInfo, memberRole, isAccessReady } = useMemberAccess();
  const { setForcePublicLayout } = useLayoutContext();
  
  // Get banners that should appear below the first element
  // Must be called unconditionally at the top to follow React's Rules of Hooks
  const belowFirstElementBanners = useBelowFirstElementBanners();
  
  // Use shared ArticleUrlContext instead of duplicating settings query
  const { 
    displayName: articleDisplayName, 
    urlSlug, 
    viewSlug, 
    editorSlug, 
    mySlug, 
    publicSlug, 
    isCustomSlug, 
    isLoading: articleUrlLoading 
  } = useArticleUrl();

  const dynamicArticleRoute = useMemo(() => {
    // Only intercept dynamic routes if we have a custom slug configured
    if (!isCustomSlug || !slug || articleUrlLoading) return null;
    
    const slugLower = slug.toLowerCase();
    
    if (slugLower === urlSlug.toLowerCase()) {
      return { component: 'Articles', displayName: articleDisplayName };
    }
    if (slugLower === viewSlug.toLowerCase()) {
      return { component: 'ArticleView', displayName: articleDisplayName };
    }
    if (slugLower === editorSlug.toLowerCase()) {
      return { component: 'ArticleEditor', displayName: articleDisplayName };
    }
    if (slugLower === mySlug.toLowerCase()) {
      // MyArticles is now integrated into Articles page - redirect there
      return { component: 'Articles', displayName: articleDisplayName };
    }
    if (slugLower === publicSlug.toLowerCase()) {
      return { component: 'PublicArticles', displayName: articleDisplayName };
    }
    
    return null;
  }, [articleDisplayName, urlSlug, viewSlug, editorSlug, mySlug, publicSlug, isCustomSlug, articleUrlLoading, slug]);

  // Fetch page and elements together using public endpoint first, fall back to authenticated
  const { data: pageData, isLoading: pageLoading, error: pageError } = useQuery({
    queryKey: ['iedit-dynamic-page', slug],
    queryFn: async () => {
      // Try public endpoint first (works for unauthenticated users on public pages)
      try {
        const publicResponse = await fetch(`/api/public/page?slug=${encodeURIComponent(slug)}`);
        if (publicResponse.ok) {
          const data = await publicResponse.json();
          return { page: data.page, elements: data.elements };
        }
      } catch (e) {
        // Fall through to authenticated endpoint
      }
      
      // Fall back to authenticated endpoints for protected pages or logged-in users
      const pages = await base44.entities.IEditPage.list({ 
        filter: { slug: slug }
      });
      const page = pages[0] || null;
      if (!page) return { page: null, elements: [] };
      
      const elements = await base44.entities.IEditPageElement.list({ 
        filter: { page_id: page.id },
        sort: { display_order: 'asc' }
      });
      return { page, elements };
    },
    enabled: !!slug && !dynamicArticleRoute,
    staleTime: 0
  });

  const page = pageData?.page;
  const elements = pageData?.elements || [];
  const elementsLoading = pageLoading;

  // Set page title and meta description
  useEffect(() => {
    if (page) {
      document.title = page.meta_title || page.title || 'AGCAS';
      
      if (page.meta_description) {
        let metaDesc = document.querySelector('meta[name="description"]');
        if (!metaDesc) {
          metaDesc = document.createElement('meta');
          metaDesc.name = 'description';
          document.head.appendChild(metaDesc);
        }
        metaDesc.content = page.meta_description;
      }
    }
  }, [page]);

  // Handle anchor scrolling after elements are loaded
  useEffect(() => {
    // Only proceed if we have elements loaded and there's a hash in the URL
    if (elements.length > 0 && !elementsLoading && location.hash) {
      const anchorId = location.hash.substring(1); // Remove the # prefix
      let cancelled = false;
      
      const scrollToAnchor = () => {
        const targetElement = document.getElementById(anchorId);
        console.log('[Anchor Debug] Scrolling to anchor:', anchorId, 'Element found:', !!targetElement);
        
        if (targetElement) {
          // Get the sticky header height to offset the scroll position
          const header = document.querySelector('header.sticky, header[class*="sticky"]');
          const headerHeight = header ? header.offsetHeight : 0;
          
          // Calculate the target scroll position with header offset
          const elementPosition = targetElement.getBoundingClientRect().top;
          const offsetPosition = elementPosition + window.pageYOffset - headerHeight - 20;
          
          console.log('[Anchor Debug] Final scroll calculation:', {
            elementPosition,
            pageYOffset: window.pageYOffset,
            headerHeight,
            offsetPosition,
            documentHeight: document.body.scrollHeight
          });
          
          window.scrollTo({
            top: offsetPosition,
            behavior: 'smooth'
          });
        }
      };
      
      // Wait for document height to stabilize (indicates images/content have loaded)
      let lastHeight = 0;
      let stableCount = 0;
      const checkInterval = setInterval(() => {
        if (cancelled) {
          clearInterval(checkInterval);
          return;
        }
        
        const currentHeight = document.body.scrollHeight;
        console.log('[Anchor Debug] Checking height stability:', { currentHeight, lastHeight, stableCount });
        
        if (currentHeight === lastHeight) {
          stableCount++;
          // Consider stable after 3 consecutive checks (600ms of no change)
          if (stableCount >= 3) {
            clearInterval(checkInterval);
            scrollToAnchor();
          }
        } else {
          stableCount = 0;
          lastHeight = currentHeight;
        }
      }, 200);
      
      // Fallback: scroll after 3 seconds max regardless of stability
      const fallbackTimeout = setTimeout(() => {
        if (!cancelled) {
          clearInterval(checkInterval);
          console.log('[Anchor Debug] Fallback timeout reached, scrolling now');
          scrollToAnchor();
        }
      }, 3000);

      return () => {
        cancelled = true;
        clearInterval(checkInterval);
        clearTimeout(fallbackTimeout);
      };
    }
  }, [elements, elementsLoading, location.hash]);

  // Check if page is accessible
  const isPublished = page?.status === 'published';
  const layoutType = page?.layout_type || 'public';
  const isMemberPage = layoutType === 'member';
  const isHybridPage = layoutType === 'hybrid';
  const isPublicPage = layoutType === 'public';
  const isLoggedIn = !!memberInfo;

  // Signal to Layout whether to use public layout (no sidebar)
  // - Default to public layout while loading (before we know the page type)
  // - Public pages: Always use public layout, even for logged-in users
  // - Hybrid pages: Use public layout for guests, portal layout for logged-in users
  // - Member pages: Always use portal layout (with sidebar)
  // - Dynamic article routes: Use portal layout (except PublicArticles)
  useEffect(() => {
    if (dynamicArticleRoute) {
      const isPublicArticleRoute = dynamicArticleRoute.component === 'PublicArticles';
      setForcePublicLayout(isPublicArticleRoute);
      return () => {
        setForcePublicLayout(false);
      };
    }

    if (pageLoading || !page) {
      setForcePublicLayout(true);
      return;
    }
    
    const shouldForcePublic = isPublicPage || (isHybridPage && !isLoggedIn);
    setForcePublicLayout(shouldForcePublic);
    
    return () => {
      setForcePublicLayout(false);
    };
  }, [page, pageLoading, isPublicPage, isHybridPage, isLoggedIn, setForcePublicLayout, dynamicArticleRoute]);

  // Check for redirect mappings when page is not found
  const shouldCheckRedirect = !pageLoading && !page && !dynamicArticleRoute && !!slug;
  const { data: redirectResult, isLoading: redirectLoading } = useQuery({
    queryKey: ['redirect-resolve', slug],
    queryFn: async () => {
      const currentPath = '/' + slug;
      const response = await fetch(`/api/redirects/resolve?path=${encodeURIComponent(currentPath)}`);
      if (!response.ok) return { found: false };
      return response.json();
    },
    enabled: shouldCheckRedirect,
    staleTime: 60000
  });

  // Handle 404 - check redirect mappings first, then fall back to default behavior
  // We need to wait for access state to be determined:
  // - For guests: memberInfo is null (from localStorage init, not undefined)
  // - For logged-in users: isAccessReady will be true after role is loaded
  const isGuest = memberInfo === null;
  const authCheckComplete = isGuest || isAccessReady;
  
  // Determine if redirect check is complete:
  // - If we should check redirects, wait for the result to be defined (not just not loading)
  // - If we shouldn't check redirects, consider it complete
  const redirectCheckComplete = shouldCheckRedirect 
    ? (redirectResult !== undefined && !redirectLoading)
    : true;
  
  useEffect(() => {
    // Wait for page loading to complete and we're in a 404 scenario
    if (pageLoading || page || dynamicArticleRoute) {
      return;
    }
    
    // If we should check redirects, wait for that to complete
    if (!redirectCheckComplete) {
      console.log('[DynamicPage] Waiting for redirect check to complete...');
      return;
    }
    
    // Check if we have a redirect mapping
    if (redirectResult?.found && redirectResult?.target_url) {
      console.log('[DynamicPage] Redirect mapping found:', redirectResult.target_url);
      // Handle external vs internal redirects
      if (redirectResult.target_url.startsWith('http://') || redirectResult.target_url.startsWith('https://')) {
        window.location.href = redirectResult.target_url;
      } else {
        navigate(redirectResult.target_url, { replace: true });
      }
      return;
    }
    
    // No redirect mapping found - use default 404 behavior
    if (authCheckComplete) {
      if (memberInfo) {
        // Logged in user: redirect to role's default landing page
        const landingPage = memberRole?.default_landing_page || 'Preferences';
        console.log('[DynamicPage] 404 redirect - logged in user to:', landingPage);
        navigate(`/${landingPage}`, { replace: true });
      } else {
        // Guest: redirect to home page
        console.log('[DynamicPage] 404 redirect - guest to home');
        navigate('/', { replace: true });
      }
    }
  }, [page, pageLoading, dynamicArticleRoute, redirectCheckComplete, redirectResult, authCheckComplete, memberInfo, memberRole, navigate]);

  // Debug: Log what's being rendered
  console.log('[DynamicPage] slug:', slug);
  console.log('[DynamicPage] dynamicArticleRoute:', dynamicArticleRoute);
  console.log('[DynamicPage] mySlug:', mySlug, 'isCustomSlug:', isCustomSlug);

  if (dynamicArticleRoute) {
    console.log('[DynamicPage] Rendering component:', dynamicArticleRoute.component);
    switch (dynamicArticleRoute.component) {
      case 'Articles':
        return <Articles />;
      case 'ArticleView':
        return <ArticleView />;
      case 'ArticleEditor':
        return <ArticleEditor />;
      case 'PublicArticles':
        return <PublicArticles />;
      default:
        return null;
    }
  }

  if (pageLoading || elementsLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center" data-testid="loading-dynamic-page">
        <div className="text-slate-600">Loading page...</div>
      </div>
    );
  }

  if (!page) {
    // Show loading state while redirect is processing
    return (
      <div className="min-h-screen flex items-center justify-center" data-testid="page-not-found-redirecting">
        <div className="text-slate-600">Redirecting...</div>
      </div>
    );
  }

  // Page exists but not published
  if (!isPublished) {
    return (
      <div className="min-h-screen flex items-center justify-center" data-testid="page-not-published">
        <div className="text-center">
          <h1 className="text-4xl font-bold text-slate-900 mb-4">Page Not Available</h1>
          <p className="text-slate-600">
            This page is currently in draft mode and not publicly accessible.
          </p>
        </div>
      </div>
    );
  }

  // For member pages, wait for access to be ready before showing member-only gate
  if (isMemberPage && !isAccessReady) {
    return (
      <div className="min-h-screen flex items-center justify-center" data-testid="loading-access-check">
        <div className="text-slate-600">Checking access...</div>
      </div>
    );
  }

  // Member page but user not logged in (only check after access is ready)
  if (isMemberPage && !isLoggedIn) {
    return (
      <div className="min-h-screen flex items-center justify-center" data-testid="page-requires-login">
        <div className="text-center">
          <h1 className="text-4xl font-bold text-slate-900 mb-4">Members Only</h1>
          <p className="text-slate-600 mb-6">
            This page is only accessible to logged-in members.
          </p>
          <a 
            href="/Home" 
            className="inline-flex items-center justify-center px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
            data-testid="link-login"
          >
            Log In
          </a>
        </div>
      </div>
    );
  }

  // Render the page content - Layout handles the appropriate wrapper (PublicLayout or sidebar)
  return (
    <div className="w-full" data-testid={`dynamic-page-${slug}`}>
      {elements.map((element, index) => (
        <React.Fragment key={element.id}>
          <IEditElementRenderer element={element} />
          {/* Insert below-first-element banners after the first element */}
          {index === 0 && belowFirstElementBanners.length > 0 && (
            <div className="w-full">
              {belowFirstElementBanners.map((banner) => (
                banner.banner_type === 'image'
                  ? <PageBannerDisplay key={banner.id} banner={banner} />
                  : <PortalHeroBanner key={banner.id} banner={banner} />
              ))}
            </div>
          )}
        </React.Fragment>
      ))}
      
      {elements.length === 0 && (
        <div className="min-h-screen flex items-center justify-center" data-testid="page-no-content">
          <div className="text-center">
            <p className="text-slate-600">This page has no content yet.</p>
          </div>
        </div>
      )}
    </div>
  );
}
