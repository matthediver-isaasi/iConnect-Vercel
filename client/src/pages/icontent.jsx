import React, { useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery } from "@tanstack/react-query";
import PublicLayout from "../components/layouts/PublicLayout";
import IEditElementRenderer from "../components/iedit/IEditElementRenderer";

export default function IContentPage() {
  const urlParams = new URLSearchParams(window.location.search);
  const pageSlug = urlParams.get('page');

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
      document.title = page.meta_title || page.title || 'Portal';
      
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

  if (pageLoading || elementsLoading) {
    return (
      <PublicLayout currentPageName="icontent">
        <div className="min-h-screen flex items-center justify-center">
          <div className="animate-pulse text-slate-600">Loading page...</div>
        </div>
      </PublicLayout>
    );
  }

  if (!page) {
    return (
      <PublicLayout currentPageName="icontent">
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
    <LayoutComponent currentPageName="icontent">
      <div className="w-full">
        {elements && elements.length > 0 ? (
          elements.map((element) => (
            <IEditElementRenderer
              key={element.id}
              element={element}
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