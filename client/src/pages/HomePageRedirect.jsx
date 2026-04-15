import { useLayoutEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import IEditElementRenderer from "../components/iedit/IEditElementRenderer";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { useLayoutContext } from "@/contexts/LayoutContext";
import Events from "./Events";

export default function HomePageRedirect() {
  const { memberInfo } = useMemberAccess();
  const { setForcePublicLayout, setForceBlankLayout, setChromeReady } = useLayoutContext();
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

  useLayoutEffect(() => {
    setChromeReady(false);
    return () => {
      setChromeReady(true);
      setForceBlankLayout(false);
    };
  }, [setChromeReady, setForceBlankLayout]);

  useLayoutEffect(() => {
    if (settingsLoading) return;
    if (!homePageSlug) {
      setChromeReady(true);
      return;
    }
    if (pageLoading || !pageData?.page) return;
    if (pageData.page.hide_chrome) {
      setForcePublicLayout(false);
      setForceBlankLayout(true);
    }
    setChromeReady(true);
  }, [homePageSlug, pageData, settingsLoading, pageLoading, setForceBlankLayout, setForcePublicLayout, setChromeReady]);

  if (settingsLoading) {
    return null;
  }

  if (!homePageSlug) {
    return <Events />;
  }

  if (pageLoading || !pageData?.page) {
    return null;
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
          memberInfo={memberInfo}
          isPreview={false}
        />
      ))}
    </div>
  );
}
