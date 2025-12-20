import { createContext, useContext, useMemo, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { createPageUrl } from '@/utils';

function slugify(text) {
  if (!text) return '';
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

// Helper to extract author handle and clean slug from an article object
function getArticleUrlParts(article, authorHandles = {}) {
  // Determine author handle
  let authorHandle = "guest"; // Default for guest writers
  if (article.author_id) {
    // Try to get handle from lookup map
    if (authorHandles[article.author_id]) {
      authorHandle = authorHandles[article.author_id];
    } else {
      // Fallback: extract from legacy slug format "-by-{handle}"
      const byHandleMatch = (article.slug || "").match(/-by-([a-z0-9-]+)$/i);
      if (byHandleMatch) {
        authorHandle = byHandleMatch[1];
      }
    }
  }
  
  // Get clean slug without handle suffix
  let cleanSlug = article.slug || "";
  const byHandleMatch = cleanSlug.match(/-by-([a-z0-9-]+)$/i);
  if (byHandleMatch) {
    cleanSlug = cleanSlug.slice(0, -byHandleMatch[0].length);
  }
  
  return { authorHandle, cleanSlug };
}

const ArticleUrlContext = createContext({
  displayName: 'Articles',
  articleDisplayName: 'Articles',
  urlSlug: 'Articles',
  baseUrlPath: '/articles',
  viewSlug: 'ArticleView',
  editorSlug: 'ArticleEditor',
  mySlug: 'MyArticles',
  publicSlug: 'PublicArticles',
  isLoading: true,
  isCustomSlug: false,
  getArticleListUrl: () => createPageUrl('Articles'),
  getArticleViewUrl: (authorHandle, articleSlug) => `/articles/${authorHandle}/${articleSlug}`,
  getArticleViewUrlFromArticle: (article, authorHandles) => {
    const { authorHandle, cleanSlug } = getArticleUrlParts(article, authorHandles);
    return `/articles/${authorHandle}/${cleanSlug}`;
  },
  getArticleEditorUrl: (articleId) => articleId ? `${createPageUrl('ArticleEditor')}?id=${articleId}` : createPageUrl('ArticleEditor'),
  getMyArticlesUrl: () => createPageUrl('MyArticles'),
  getPublicArticlesUrl: () => createPageUrl('PublicArticles')
});

export function ArticleUrlProvider({ children }) {
  const { data: settings, isLoading } = useQuery({
    queryKey: ['article-url-settings'],
    queryFn: async () => {
      try {
        const allSettings = await base44.entities.SystemSettings.list();
        const setting = allSettings.find(s => s.setting_key === 'article_display_name');
        return setting?.setting_value || 'Articles';
      } catch (error) {
        console.error('Error loading article display name:', error);
        return 'Articles';
      }
    },
    staleTime: 5000, // Short stale time to pick up settings changes quickly
    refetchOnWindowFocus: true // Refetch when user returns to tab
  });

  const value = useMemo(() => {
    const displayName = settings || 'Articles';
    const baseSlug = slugify(displayName);
    const isCustomSlug = displayName.toLowerCase() !== 'articles' && baseSlug !== 'articles';
    
    // For custom slugs, use lowercase dynamic routes
    // For default, use canonical createPageUrl routes that match static route definitions
    const urlSlug = isCustomSlug ? baseSlug : 'Articles';
    const viewSlug = isCustomSlug ? `${baseSlug}view` : 'ArticleView';
    const editorSlug = isCustomSlug ? `${baseSlug}editor` : 'ArticleEditor';
    const mySlug = isCustomSlug ? `my${baseSlug}` : 'MyArticles';
    const publicSlug = isCustomSlug ? `public${baseSlug}` : 'PublicArticles';
    
    // Base URL path for article viewing (e.g., /articles or /blogs)
    const baseUrlPath = isCustomSlug ? `/${baseSlug}` : '/articles';

    return {
      displayName,
      articleDisplayName: displayName,
      urlSlug,
      baseUrlPath,
      viewSlug,
      editorSlug,
      mySlug,
      publicSlug,
      isLoading,
      isCustomSlug,
      getArticleListUrl: () => isCustomSlug ? `/${urlSlug}` : createPageUrl('Articles'),
      // New folder-based URL structure: /{basePath}/{authorHandle}/{articleSlug}
      getArticleViewUrl: (authorHandle, articleSlug) => `${baseUrlPath}/${authorHandle}/${articleSlug}`,
      // Helper that constructs URL from article object
      getArticleViewUrlFromArticle: (article, authorHandles = {}) => {
        const { authorHandle, cleanSlug } = getArticleUrlParts(article, authorHandles);
        return `${baseUrlPath}/${authorHandle}/${cleanSlug}`;
      },
      getArticleEditorUrl: (articleId) => isCustomSlug
        ? (articleId ? `/${editorSlug}?id=${articleId}` : `/${editorSlug}`)
        : (articleId ? `${createPageUrl('ArticleEditor')}?id=${articleId}` : createPageUrl('ArticleEditor')),
      getMyArticlesUrl: () => isCustomSlug ? `/${mySlug}` : createPageUrl('MyArticles'),
      getPublicArticlesUrl: () => isCustomSlug ? `/${publicSlug}` : createPageUrl('PublicArticles')
    };
  }, [settings, isLoading]);

  return (
    <ArticleUrlContext.Provider value={value}>
      {children}
    </ArticleUrlContext.Provider>
  );
}

export function useArticleUrl() {
  return useContext(ArticleUrlContext);
}
