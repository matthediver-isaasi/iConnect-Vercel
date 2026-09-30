// Shared per-result-type presentation for the search surfaces (the header
// dropdown in `components/layouts/PublicHeader.jsx` and the Canvas Builder
// search block in `components/canvas/blocks/dynamicBlocks.jsx`).
//
// Both surfaces must render each result with the SAME type icon and the SAME
// uppercase type label (including the tenant's custom article naming), so keep
// that logic here in one place to avoid drift.

import { Calendar, BookOpen, Newspaper, FolderOpen, FileText } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { publicClient } from '@/api/publicClient';

// Icon component per result type. Callers fall back to `FileText` for unknown
// types (mirrors the header's `typeIconMap[type] || FileText`).
export const searchResultTypeIconMap = {
  event: Calendar,
  article: BookOpen,
  news: Newspaper,
  resource: FolderOpen,
};

// Resolve the icon component for a result type, with the shared fallback.
export function getSearchResultTypeIcon(type) {
  return searchResultTypeIconMap[type] || FileText;
}

// Human-readable type label. Articles honour the tenant's custom (possibly
// pluralised) article display name, singularised for the per-result label.
export function getSearchResultTypeLabel(type, articleDisplayName) {
  if (type === 'article') {
    const name = articleDisplayName || 'Article';
    return name.endsWith('s') ? name.slice(0, -1) : name;
  }
  const labels = { event: 'Event', news: 'News', resource: 'Resource' };
  return labels[type] || type;
}

// Shared query for the tenant's configured article display name. Both search
// surfaces use the same query key so the setting is fetched once and cached.
export function useArticleDisplayName() {
  const { data } = useQuery({
    queryKey: ['public-article-display-name-setting'],
    queryFn: async () => {
      const setting = await publicClient.getSystemSetting('article_display_name');
      return setting?.setting_value || 'Article';
    },
    staleTime: 5 * 60 * 1000,
  });
  return data;
}
