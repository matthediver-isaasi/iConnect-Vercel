import React, { useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery } from "@tanstack/react-query";
import IEditElementRenderer from "../components/iedit/IEditElementRenderer";

export default function SharonPage() {
  // Fetch page by slug
  const { data: page, isLoading: pageLoading } = useQuery({
    queryKey: ['iedit-page-sharon'],
    queryFn: async () => {
      const allPages = await base44.entities.IEditPage.filter({ 
        slug: 'sharon',
        status: 'published'
      });
      return allPages[0];
    }
  });

  // Fetch page elements
  const { data: elements = [], isLoading: elementsLoading } = useQuery({
    queryKey: ['iedit-elements-sharon', page?.id],
    queryFn: () => base44.entities.IEditPageElement.filter({ 
      page_id: page.id 
    }, 'display_order'),
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

  if (pageLoading || elementsLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-slate-600">Loading...</div>
      </div>
    );
  }

  if (!page) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <h1 className="text-4xl font-bold text-slate-900 mb-4">Page Not Found</h1>
          <p className="text-slate-600">The sharon page hasn't been published yet.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full">
      {elements.map((element) => (
        <IEditElementRenderer key={element.id} element={element} />
      ))}
      
      {elements.length === 0 && (
        <div className="min-h-screen flex items-center justify-center">
          <p className="text-slate-600">This page has no content yet.</p>
        </div>
      )}
    </div>
  );
}