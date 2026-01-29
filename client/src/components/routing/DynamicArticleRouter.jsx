import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useLocation, useNavigate } from 'react-router-dom';
import { publicClient } from '@/api/publicClient';

function slugify(text) {
  if (!text) return '';
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

export function useDynamicArticleRouting() {
  const location = useLocation();
  const navigate = useNavigate();
  const [routeInfo, setRouteInfo] = useState(null);

  const { data: articleSettings } = useQuery({
    queryKey: ['public-article-url-settings'],
    queryFn: async () => {
      try {
        // Use public endpoint for unauthenticated access on public pages
        const allSettings = await publicClient.listSystemSettings() || [];
        const setting = allSettings.find(s => s.setting_key === 'article_display_name');
        return setting?.setting_value || 'Articles';
      } catch (error) {
        console.error('Error loading article display name:', error);
        return 'Articles';
      }
    },
    staleTime: 60000
  });

  useEffect(() => {
    if (!articleSettings) return;
    
    const displayName = articleSettings;
    const customSlug = slugify(displayName);
    const isCustom = displayName.toLowerCase() !== 'articles' && customSlug !== 'articles';
    
    if (!isCustom) {
      setRouteInfo(null);
      return;
    }

    const pathname = location.pathname.toLowerCase();
    const queryString = location.search;

    const customRoutes = {
      [`/${customSlug}`]: '/Articles',
      [`/${customSlug}view`]: '/ArticleView',
      [`/${customSlug}editor`]: '/ArticleEditor',
      [`/my${customSlug}`]: '/Articles',
      [`/public${customSlug}`]: '/PublicArticles'
    };

    for (const [customPath, standardPath] of Object.entries(customRoutes)) {
      if (pathname === customPath) {
        setRouteInfo({
          shouldRedirect: true,
          targetPath: standardPath,
          queryString,
          customSlug
        });
        return;
      }
    }

    setRouteInfo(null);
  }, [articleSettings, location.pathname, location.search]);

  return routeInfo;
}

export function DynamicArticleRedirector({ children }) {
  const routeInfo = useDynamicArticleRouting();
  const navigate = useNavigate();

  useEffect(() => {
    if (routeInfo?.shouldRedirect) {
      navigate(routeInfo.targetPath + routeInfo.queryString, { replace: true });
    }
  }, [routeInfo, navigate]);

  return children;
}
