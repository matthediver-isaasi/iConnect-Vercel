import { useQuery } from '@tanstack/react-query';
import { base44 } from '../api/base44Client';
import { publicClient } from '../api/publicClient';
import { useLayoutContext } from '../contexts/LayoutContext';

/**
 * Hybrid hook for fetching news posts data.
 * 
 * This hook automatically detects whether the user is authenticated and routes
 * to the appropriate data source:
 * - Authenticated users: base44.entities.NewsPost (full data)
 * - Public visitors: publicClient.listNews() (public-safe data only)
 * 
 * SECURITY: Only trusts memberInfo from LayoutContext (validated via /api/auth/me).
 * Does NOT trust localStorage directly to prevent stale session attacks.
 * 
 * @param {Object} options - Query options
 * @param {boolean} options.forcePublic - Force using public API even if authenticated
 * @returns {Object} Query result with news posts data
 */
export function useNewsPostsData({ forcePublic = false } = {}) {
  const { memberInfo, forcePublicLayout, sessionValidated } = useLayoutContext();
  
  const isAuthenticated = !!memberInfo && !!sessionValidated && !forcePublicLayout && !forcePublic;
  
  return useQuery({
    queryKey: ['news-posts', isAuthenticated ? 'authenticated' : 'public'],
    queryFn: async () => {
      try {
        if (isAuthenticated) {
          const data = await base44.entities.NewsPost.list('-published_date');
          const now = new Date();
          return (data || []).filter(n => 
            n.status === 'published' && 
            (!n.published_date || new Date(n.published_date) <= now)
          );
        } else {
          const data = await publicClient.listNews();
          return data || [];
        }
      } catch (error) {
        console.error('[useNewsPostsData] Error loading news posts:', error);
        if (isAuthenticated) {
          console.log('[useNewsPostsData] Falling back to public API');
          try {
            const publicData = await publicClient.listNews();
            return publicData || [];
          } catch (fallbackError) {
            console.error('[useNewsPostsData] Fallback also failed:', fallbackError);
            throw fallbackError;
          }
        }
        throw error;
      }
    },
    staleTime: 0,
    refetchOnMount: true,
  });
}

/**
 * Hybrid hook for fetching a single news post by slug.
 * 
 * SECURITY: Only trusts memberInfo from LayoutContext (validated via /api/auth/me).
 * Does NOT trust localStorage directly to prevent stale session attacks.
 * 
 * @param {string} slug - The news post slug to fetch
 * @param {Object} options - Query options  
 * @param {boolean} options.forcePublic - Force using public API even if authenticated
 * @returns {Object} Query result with news post data
 */
export function useNewsPostBySlug(slug, { forcePublic = false } = {}) {
  const { memberInfo, forcePublicLayout, sessionValidated } = useLayoutContext();
  
  const isAuthenticated = !!memberInfo && !!sessionValidated && !forcePublicLayout && !forcePublic;
  
  return useQuery({
    queryKey: ['news-post', slug, isAuthenticated ? 'authenticated' : 'public'],
    enabled: !!slug,
    queryFn: async () => {
      try {
        if (isAuthenticated) {
          const allNews = await base44.entities.NewsPost.list();
          const post = allNews.find(n => n.slug === slug);
          if (!post) return null;
          const now = new Date();
          if (post.status !== 'published' || (post.published_date && new Date(post.published_date) > now)) {
            return null;
          }
          return post;
        } else {
          const data = await publicClient.getNewsPostBySlug(slug);
          return data;
        }
      } catch (error) {
        console.error('[useNewsPostBySlug] Error loading news post:', error);
        if (isAuthenticated) {
          console.log('[useNewsPostBySlug] Falling back to public API');
          try {
            return await publicClient.getNewsPostBySlug(slug);
          } catch (fallbackError) {
            console.error('[useNewsPostBySlug] Fallback also failed:', fallbackError);
            throw fallbackError;
          }
        }
        throw error;
      }
    },
    staleTime: 30 * 1000,
  });
}

/**
 * Hybrid hook for fetching a single news post by ID.
 * 
 * SECURITY: Only trusts memberInfo from LayoutContext (validated via /api/auth/me).
 * Does NOT trust localStorage directly to prevent stale session attacks.
 * 
 * @param {string} newsId - The news post ID to fetch
 * @param {Object} options - Query options  
 * @param {boolean} options.forcePublic - Force using public API even if authenticated
 * @returns {Object} Query result with news post data
 */
export function useNewsPostData(newsId, { forcePublic = false } = {}) {
  const { memberInfo, forcePublicLayout, sessionValidated } = useLayoutContext();
  
  const isAuthenticated = !!memberInfo && !!sessionValidated && !forcePublicLayout && !forcePublic;
  
  return useQuery({
    queryKey: ['news-post', newsId, isAuthenticated ? 'authenticated' : 'public'],
    enabled: !!newsId,
    queryFn: async () => {
      try {
        if (isAuthenticated) {
          const post = await base44.entities.NewsPost.get(newsId);
          if (!post) return null;
          const now = new Date();
          if (post.status !== 'published' || (post.published_date && new Date(post.published_date) > now)) {
            return null;
          }
          return post;
        } else {
          const data = await publicClient.getNewsPost(newsId);
          return data;
        }
      } catch (error) {
        console.error('[useNewsPostData] Error loading news post:', error);
        if (isAuthenticated) {
          console.log('[useNewsPostData] Falling back to public API');
          try {
            return await publicClient.getNewsPost(newsId);
          } catch (fallbackError) {
            console.error('[useNewsPostData] Fallback also failed:', fallbackError);
            throw fallbackError;
          }
        }
        throw error;
      }
    },
    staleTime: 30 * 1000,
  });
}
