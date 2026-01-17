import React, { useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery } from "@tanstack/react-query";
import IEditElementRenderer from "../components/iedit/IEditElementRenderer";

export default function ContentPage() {
  // Try hash-based routing as fallback since query params are being stripped
  const urlParams = new URLSearchParams(window.location.search);
  const querySlug = urlParams.get('page');
  const hashSlug = window.location.hash.replace('#', '');
  const pageSlug = querySlug || hashSlug;

  // Fetch page by slug
  const { data: page, isLoading: pageLoading, error: pageError } = useQuery({
    queryKey: ['iedit-public-page', pageSlug],
    queryFn: async () => {
      const allPages = await base44.entities.IEditPage.filter({ 
        slug: pageSlug,
        status: 'published'
      });
      return allPages[0];
    },
    enabled: !!pageSlug
  });

  // Fetch page elements
  const { data: elements = [], isLoading: elementsLoading } = useQuery({
    queryKey: ['iedit-public-elements', page?.id],
    queryFn: () => base44.entities.IEditPageElement.filter({ 
      page_id: page.id 
    }, 'display_order'),
    staleTime: 0,
    refetchOnMount: true,
    enabled: !!page?.id
  });

  // Set page title and meta description
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

  // Debug font loading
  useEffect(() => {
    console.log('[Content Page] Checking font loading...');
    
    if ('fonts' in document) {
      // Check if Degular Medium is loaded
      document.fonts.ready.then(() => {
        const isDegularLoaded = document.fonts.check('500 16px "Degular Medium"');
        console.log('[Content Page] Degular Medium loaded:', isDegularLoaded);
        
        const allFonts = Array.from(document.fonts.values());
        console.log('[Content Page] All loaded fonts:', allFonts.map(f => f.family));
      });
    }

    // Log elements data
    console.log('[Content Page] Elements:', elements);
    elements.forEach((el, i) => {
      console.log(`[Content Page] Element ${i}:`, {
        type: el.element_type,
        content: el.content,
        variant: el.variant
      });
    });
  }, [elements]);

  if (!pageSlug) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <h1 className="text-4xl font-bold text-slate-900 mb-4">No Page Specified</h1>
          <p className="text-slate-600">
            Please provide a page slug in the URL
          </p>
          <p className="text-sm text-slate-500 mt-2">
            Format: /content#your-page-slug
          </p>
        </div>
      </div>
    );
  }

  if (pageLoading || elementsLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-slate-600">Loading page...</div>
      </div>
    );
  }

  if (pageError || !page) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <h1 className="text-4xl font-bold text-slate-900 mb-4">Page Not Found</h1>
          <p className="text-slate-600 mb-2">
            The page you're looking for doesn't exist or hasn't been published yet.
          </p>
          <p className="text-sm text-slate-500">
            (Looking for page: "{pageSlug}")
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full">
      {elements.map((element, index) => (
        <IEditElementRenderer
          key={element.id}
          element={element}
          isFirst={index === 0}
        />
      ))}
      
      {elements.length === 0 && (
        <div className="min-h-screen flex items-center justify-center">
          <div className="text-center">
            <p className="text-slate-600">This page has no content yet.</p>
          </div>
        </div>
      )}
    </div>
  );
}