import React, { useEffect, useMemo } from "react";
import { useParams, useLocation } from "react-router-dom";
import { base44 } from "@/api/base44Client";
import { useQuery } from "@tanstack/react-query";
import IEditElementRenderer from "../components/iedit/IEditElementRenderer";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { useLayoutContext } from "@/contexts/LayoutContext";
import { useArticleUrl } from "@/contexts/ArticleUrlContext";
import { useBelowFirstElementBanners } from "@/contexts/BannerContext";
import PortalHeroBanner from "@/components/banners/PortalHeroBanner";
import Articles from "./Articles";
import ArticleView from "./ArticleView";
import ArticleEditor from "./ArticleEditor";
import MyArticles from "./MyArticles";
import PublicArticles from "./PublicArticles";

export default function DynamicPage() {
  const { slug } = useParams();
  const location = useLocation();
  const { memberInfo, isAccessReady } = useMemberAccess();
  const { setForcePublicLayout } = useLayoutContext();
  
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
      return { component: 'MyArticles', displayName: articleDisplayName };
    }
    if (slugLower === publicSlug.toLowerCase()) {
      return { component: 'PublicArticles', displayName: articleDisplayName };
    }
    
    return null;
  }, [articleDisplayName, urlSlug, viewSlug, editorSlug, mySlug, publicSlug, isCustomSlug, articleUrlLoading, slug]);

  const { data: page, isLoading: pageLoading, error: pageError } = useQuery({
    queryKey: ['iedit-dynamic-page', slug],
    queryFn: async () => {
      const pages = await base44.entities.IEditPage.list({ 
        filter: { slug: slug }
      });
      return pages[0] || null;
    },
    enabled: !!slug && !dynamicArticleRoute,
    staleTime: 0
  });

  // Fetch page elements when page is loaded
  const { data: elements = [], isLoading: elementsLoading } = useQuery({
    queryKey: ['iedit-dynamic-elements', page?.id],
    queryFn: () => base44.entities.IEditPageElement.list({ 
      filter: { page_id: page.id },
      sort: { display_order: 'asc' }
    }),
    enabled: !!page?.id,
    staleTime: 0
  });

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
      
      // Use a small timeout to ensure DOM has fully updated after React render
      const scrollTimeout = setTimeout(() => {
        const targetElement = document.getElementById(anchorId);
        if (targetElement) {
          // Get the sticky header height to offset the scroll position
          const header = document.querySelector('header.sticky, header[class*="sticky"]');
          const headerHeight = header ? header.offsetHeight : 0;
          
          // Calculate the target scroll position with header offset
          const elementPosition = targetElement.getBoundingClientRect().top;
          const offsetPosition = elementPosition + window.pageYOffset - headerHeight - 20; // 20px extra padding
          
          window.scrollTo({
            top: offsetPosition,
            behavior: 'smooth'
          });
        }
      }, 100);

      return () => clearTimeout(scrollTimeout);
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
      case 'MyArticles':
        return <MyArticles />;
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
    return (
      <div className="min-h-screen flex items-center justify-center" data-testid="page-not-found">
        <div className="text-center">
          <h1 className="text-6xl font-bold text-slate-300 mb-4">404</h1>
          <h2 className="text-2xl font-bold text-slate-900 mb-2">Page Not Found</h2>
          <p className="text-slate-600 mb-6">
            The page you're looking for doesn't exist.
          </p>
          <a 
            href="/" 
            className="inline-flex items-center justify-center px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
            data-testid="link-home"
          >
            Go Home
          </a>
        </div>
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

  // Get banners that should appear below the first element
  const belowFirstElementBanners = useBelowFirstElementBanners();

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
                <PortalHeroBanner key={banner.id} banner={banner} />
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
