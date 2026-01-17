import React, { useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery } from "@tanstack/react-query";
import { useTenantBranding } from "@/contexts/TenantBrandingContext";
import PublicLayout from "../components/layouts/PublicLayout";
import IEditElementRenderer from "../components/iedit/IEditElementRenderer";

export default function ViewPage() {
  const { branding } = useTenantBranding();
  const urlParams = new URLSearchParams(window.location.search);
  const pageSlug = urlParams.get('slug');

  const { data: page, isLoading: pageLoading } = useQuery({
    queryKey: ['iedit-page-by-slug', pageSlug],
    queryFn: async () => {
      const pages = await base44.entities.IEditPage.list();
      return pages.find(p => p.slug === pageSlug && p.status === 'published');
    },
    enabled: !!pageSlug,
  });

  const { data: elements, isLoading: elementsLoading } = useQuery({
    queryKey: ['iedit-page-elements', page?.id],
    queryFn: async () => {
      const allElements = await base44.entities.IEditPageElement.list();
      return allElements
        .filter(e => e.page_id === page.id)
        .sort((a, b) => (a.display_order || 0) - (b.display_order || 0));
    },
    enabled: !!page?.id,
  });

  useEffect(() => {
    if (page) {
      document.title = page.meta_title || page.title || branding?.name || 'Portal';
      
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
    const hash = window.location.hash;
    if (elements && elements.length > 0 && !elementsLoading && hash) {
      const anchorId = hash.substring(1); // Remove the # prefix
      
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
  }, [elements, elementsLoading]);

  if (pageLoading || elementsLoading) {
    return (
      <PublicLayout currentPageName="ViewPage">
        <div className="min-h-screen flex items-center justify-center">
          <div className="animate-pulse text-slate-600">Loading page...</div>
        </div>
      </PublicLayout>
    );
  }

  if (!page) {
    return (
      <PublicLayout currentPageName="ViewPage">
        <div className="min-h-screen flex items-center justify-center">
          <div className="text-center">
            <h2 className="text-2xl font-bold text-slate-900 mb-4">Page not found</h2>
            <p className="text-slate-600">
              {pageSlug ? `The page "${pageSlug}" doesn't exist or hasn't been published yet.` : 'No page specified'}
            </p>
          </div>
        </div>
      </PublicLayout>
    );
  }

  const LayoutComponent = page.layout_type === 'member' 
    ? ({ children }) => <div className="min-h-screen">{children}</div>
    : PublicLayout;

  return (
    <LayoutComponent currentPageName="ViewPage">
      <div className="w-full">
        {elements && elements.length > 0 ? (
          elements.map((element) => (
            <IEditElementRenderer
              key={element.id}
              element={element}
              memberInfo={null}
              organizationInfo={null}
            />
          ))
        ) : (
          <div className="min-h-screen flex items-center justify-center">
            <div className="text-center">
              <p className="text-slate-600">This page has no content yet.</p>
            </div>
          </div>
        )}
      </div>
    </LayoutComponent>
  );
}