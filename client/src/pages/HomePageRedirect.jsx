import { useQuery } from "@tanstack/react-query";
import IEditElementRenderer from "../components/iedit/IEditElementRenderer";
import Events from "./Events";

export default function HomePageRedirect() {
  const { data: homePageSlug, isLoading: settingsLoading } = useQuery({
    queryKey: ['home-page-setting'],
    queryFn: async () => {
      const response = await fetch('/api/public/portal-branding');
      if (!response.ok) return null;
      const data = await response.json();
      return data.homePageSlug || null;
    },
    staleTime: 60000
  });

  const { data: pageData, isLoading: pageLoading } = useQuery({
    queryKey: ['public-home-page', homePageSlug],
    queryFn: async () => {
      if (!homePageSlug) return null;
      const response = await fetch(`/api/public/page/${homePageSlug}`);
      if (!response.ok) return null;
      const data = await response.json();
      if (!data.success) return null;
      return {
        page: data.page,
        elements: data.elements || []
      };
    },
    enabled: !!homePageSlug,
    staleTime: 0
  });

  if (settingsLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-pulse text-slate-600">Loading...</div>
      </div>
    );
  }

  if (!homePageSlug || !pageData?.page) {
    return <Events />;
  }

  if (pageLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-pulse text-slate-600">Loading...</div>
      </div>
    );
  }

  const sortedElements = [...(pageData.elements || [])].sort((a, b) => 
    (a.display_order || 0) - (b.display_order || 0)
  );

  return (
    <div className="iedit-page-container">
      {sortedElements.map((element) => (
        <IEditElementRenderer
          key={element.id}
          element={element}
          isPreview={false}
        />
      ))}
    </div>
  );
}
