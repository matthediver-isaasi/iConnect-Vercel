import React, { useEffect, useState } from "react";
import { base44 } from "@/api/base44Client";
import { publicClient } from "@/api/publicClient";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Calendar, User, Edit, Tag, Eye, Linkedin, Mail, Trophy, ChevronDown, ChevronUp, UserPlus, UserMinus } from "lucide-react";
import { format } from "date-fns";
import { Link, useParams } from "react-router-dom";
import ArticleComments from "../components/blog/ArticleComments";
import ArticleReactions from "../components/blog/ArticleReactions";
import { toast } from "sonner";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { useArticleUrl } from "@/contexts/ArticleUrlContext";
import { useLayoutContext } from "@/contexts/LayoutContext";

export default function ArticleViewPage() {
  const queryClient = useQueryClient();
  const { memberInfo, isAdmin, isFeatureExcluded } = useMemberAccess();
  const { getArticleListUrl, getArticleEditorUrl, getPublicArticlesUrl } = useArticleUrl();
  const { sessionValidated } = useLayoutContext();
  
  // Determine authentication state using session validation pattern
  const isAuthenticated = sessionValidated && !!memberInfo;
  
  // Get route params for new folder-based URLs: /articles/:authorHandle/:articleSlug
  const { authorHandle: routeAuthorHandle, articleSlug: routeArticleSlug } = useParams();
  
  console.log('[ArticleView] Component initialized');
  console.log('[ArticleView] Route params - authorHandle:', routeAuthorHandle, 'articleSlug:', routeArticleSlug);
  console.log('[ArticleView] window.location.pathname:', window.location.pathname);
  console.log('[ArticleView] isAuthenticated:', isAuthenticated);
  
  // Legacy query params support
  const urlParams = new URLSearchParams(window.location.search);
  const legacySlug = urlParams.get('slug');
  const isPreviewMode = urlParams.get('preview') === 'true';
  
  // Use route params if available, otherwise fall back to legacy query params
  const authorHandle = routeAuthorHandle || null;
  const slug = routeArticleSlug || legacySlug;
  
  console.log('[ArticleView] Resolved - authorHandle:', authorHandle, 'slug:', slug);
  console.log('[ArticleView] isPreviewMode:', isPreviewMode);
  
  const [userIdentifier, setUserIdentifier] = useState("");
  const [viewRecorded, setViewRecorded] = useState(false);
  const [bioExpanded, setBioExpanded] = useState(false);

  // Default settings for public users (reasonable public-friendly defaults)
  const defaultPublicSettings = {
    showViewCount: false, // Don't show view count for public
    showAuthorBio: true,
    showAwardsLabel: false, // Awards are member-only feature
    showAboutAuthorLabel: true,
    showAuthorOrganization: true,
    showAuthorEmail: false, // Don't expose email publicly
    showAuthorPhoto: true,
    showThumbsUp: false, // Reactions are member-only
    showThumbsDown: false,
    allowPublicComments: false // Will be fetched from public API
  };

  // Fetch article settings - use public API for unauthenticated users
  const { data: articleSettings = defaultPublicSettings } = useQuery({
    queryKey: ['article-settings', isAuthenticated],
    queryFn: async () => {
      if (!isAuthenticated) {
        // Fetch public article settings for unauthenticated users
        try {
          const publicSettings = await publicClient.getArticleSettings();
          return {
            ...defaultPublicSettings,
            showAuthorBio: publicSettings.showAuthorBio ?? true,
            showAboutAuthorLabel: publicSettings.showAboutAuthorLabel ?? true,
            showAuthorPhoto: publicSettings.showAuthorPhoto ?? true,
            allowPublicComments: publicSettings.allowPublicComments ?? false
          };
        } catch (error) {
          console.error('[ArticleView] Failed to fetch public article settings:', error);
          return defaultPublicSettings;
        }
      }
      const allSettings = await base44.entities.SystemSettings.list();
      console.log('[ArticleView] All settings fetched:', allSettings.length);
      const viewCountSetting = allSettings.find(s => s.setting_key === 'article_show_view_count');
      const authorBioSetting = allSettings.find(s => s.setting_key === 'article_show_author_bio');
      const awardsLabelSetting = allSettings.find(s => s.setting_key === 'article_show_awards_label');
      const aboutAuthorLabelSetting = allSettings.find(s => s.setting_key === 'article_show_about_author_label');
      const authorOrganizationSetting = allSettings.find(s => s.setting_key === 'article_show_author_organization');
      const authorEmailSetting = allSettings.find(s => s.setting_key === 'article_show_author_email');
      const authorPhotoSetting = allSettings.find(s => s.setting_key === 'article_show_author_photo');
      const thumbsUpSetting = allSettings.find(s => s.setting_key === 'article_show_thumbs_up');
      const thumbsDownSetting = allSettings.find(s => s.setting_key === 'article_show_thumbs_down');
      const allowPublicCommentsSetting = allSettings.find(s => s.setting_key === 'article_allow_public_comments');
      console.log('[ArticleView] Photo setting found:', authorPhotoSetting);
      const settings = {
        showViewCount: viewCountSetting?.setting_value !== 'false',
        showAuthorBio: authorBioSetting?.setting_value !== 'false',
        showAwardsLabel: awardsLabelSetting?.setting_value !== 'false',
        showAboutAuthorLabel: aboutAuthorLabelSetting?.setting_value !== 'false',
        showAuthorOrganization: authorOrganizationSetting?.setting_value !== 'false',
        showAuthorEmail: authorEmailSetting?.setting_value !== 'false',
        showAuthorPhoto: authorPhotoSetting?.setting_value !== 'false',
        showThumbsUp: thumbsUpSetting?.setting_value !== 'false',
        showThumbsDown: thumbsDownSetting?.setting_value !== 'false',
        allowPublicComments: allowPublicCommentsSetting?.setting_value === 'true'
      };
      console.log('[ArticleView] Parsed settings:', settings);
      return settings;
    },
    staleTime: 0,
    refetchOnMount: true,
  });

  // Fetch article display name - use public API for unauthenticated
  const { data: articleDisplayName = 'Articles' } = useQuery({
    queryKey: ['article-display-name', isAuthenticated],
    queryFn: async () => {
      if (isAuthenticated) {
        const allSettings = await base44.entities.SystemSettings.list();
        const setting = allSettings.find(s => s.setting_key === 'article_display_name');
        return setting?.setting_value || 'Articles';
      } else {
        const setting = await publicClient.getSystemSetting('article_display_name');
        return setting?.setting_value || 'Articles';
      }
    }
  });

  // Determine if user is logged in by checking session storage
  const isLoggedIn = !!localStorage.getItem('agcas_member');

  // Generate or retrieve user identifier
  useEffect(() => {
    if (!memberInfo) {
      let identifier = sessionStorage.getItem('public_user_id');
      if (!identifier) {
        identifier = `public_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        sessionStorage.setItem('public_user_id', identifier);
      }
      setUserIdentifier(identifier);
    } else {
      setUserIdentifier(memberInfo.email);
    }
  }, [memberInfo]);

  // Fetch article with hybrid loading - public API for unauthenticated, authenticated API for logged in
  const { data: articleData = { article: null, author: null, guestWriter: null }, isLoading } = useQuery({
    queryKey: ['article-by-slug', authorHandle, slug, isAuthenticated],
    queryFn: async () => {
      console.log('[ArticleView] Fetching article for authorHandle:', authorHandle, 'slug:', slug, 'isAuthenticated:', isAuthenticated);
      
      // For unauthenticated users, use public API
      if (!isAuthenticated) {
        console.log('[ArticleView] Using public API for article fetch');
        try {
          const result = await publicClient.getArticle(slug, authorHandle);
          console.log('[ArticleView] Public API result:', result);
          return result;
        } catch (e) {
          console.log('[ArticleView] Public API error:', e);
          return { article: null, author: null, guestWriter: null };
        }
      }
      
      // For authenticated users, use the existing authenticated API
      console.log('[ArticleView] Using authenticated API for article fetch');
      const articles = await base44.entities.BlogPost.list();
      
      let found = null;
      
      // Helper to check if article slug matches (handles both clean and legacy formats)
      const slugMatches = (articleSlug, targetSlug) => {
        if (!articleSlug || !targetSlug) return false;
        // Exact match
        if (articleSlug === targetSlug) return true;
        // Legacy format: article slug contains "-by-{handle}" suffix
        // Check if the legacy slug starts with the clean slug
        if (articleSlug.includes('-by-')) {
          const cleanSlug = articleSlug.replace(/-by-[^-]+$/, '');
          return cleanSlug === targetSlug;
        }
        return false;
      };
      
      if (authorHandle && slug) {
        // New folder-based URL: /articles/{authorHandle}/{slug}
        if (authorHandle === 'guest') {
          // Guest writer articles
          found = articles.find(a => slugMatches(a.slug, slug) && a.guest_writer_id);
        } else {
          // Member articles - find by matching handle OR blog_handle
          // First try to find the article directly by checking all articles with member lookup
          for (const a of articles) {
            if (!slugMatches(a.slug, slug) || !a.author_id) continue;
            // Fetch just this one member to check their handle
            try {
              const member = await base44.entities.Member.get(a.author_id);
              if (member && (member.handle === authorHandle || member.blog_handle === authorHandle)) {
                found = a;
                break;
              }
            } catch (e) {
              // Member not found, continue
            }
          }
        }
      } else if (slug) {
        // Legacy query param support - find by slug only (exact match or legacy format)
        found = articles.find(a => a.slug === slug || slugMatches(a.slug, slug));
      }
      
      console.log('[ArticleView] Article found:', !!found);
      console.log('[ArticleView] Article author_id:', found?.author_id);
      return { article: found, author: null, guestWriter: null };
    },
    enabled: !!slug,
  });
  
  // Extract article from response (handles both public and authenticated formats)
  const article = articleData?.article || null;
  const publicAuthorData = articleData?.author || null;
  const publicGuestWriterData = articleData?.guestWriter || null;

  // Fetch view count - only for authenticated users
  const { data: viewCount = 0 } = useQuery({
    queryKey: ['article-view-count', article?.id],
    queryFn: async () => {
      const views = await base44.entities.ArticleView.list();
      return views.filter(v => v.article_id === article.id).length;
    },
    enabled: isAuthenticated && !!article?.id,
    staleTime: 10 * 1000,
  });

  // Fetch author details (either member or guest writer) - only for authenticated users
  // For unauthenticated users, use publicAuthorData from the article fetch
  const { data: authorMember } = useQuery({
    queryKey: ['author-member', article?.author_id],
    queryFn: async () => {
      if (!article?.author_id) return null;
      try {
        const found = await base44.entities.Member.get(article.author_id);
        console.log('[ArticleView] authorMember found:', found);
        console.log('[ArticleView] authorMember.organization_id:', found?.organization_id);
        return found;
      } catch (e) {
        console.log('[ArticleView] Failed to fetch author member:', e);
        return null;
      }
    },
    enabled: isAuthenticated && !!article?.author_id && !publicAuthorData,
  });

  // Fetch guest writer details if applicable - only for authenticated users
  // For unauthenticated users, use publicGuestWriterData from the article fetch
  const { data: guestWriter } = useQuery({
    queryKey: ['guest-writer', article?.guest_writer_id],
    queryFn: async () => {
      if (!article?.guest_writer_id) return null;
      const writers = await base44.entities.GuestWriter.list();
      return writers.find(w => w.id === article.guest_writer_id);
    },
    enabled: isAuthenticated && !!article?.guest_writer_id && !publicGuestWriterData,
  });

  // Determine which author to use - prefer public data for unauthenticated, then authenticated data
  const effectiveAuthorMember = publicAuthorData || authorMember;
  const effectiveGuestWriter = publicGuestWriterData || guestWriter;
  const author = effectiveGuestWriter || effectiveAuthorMember;
  const isGuestWriter = !!effectiveGuestWriter;

  // Fetch author organization (only for authenticated members)
  const { data: authorOrganization, isLoading: orgLoading, isError: orgError } = useQuery({
    queryKey: ['author-organization', authorMember?.organization_id],
    queryFn: async () => {
      if (!authorMember?.organization_id) {
        return null;
      }
      const orgs = await base44.entities.Organization.list();
      const found = orgs.find(o => o.id === authorMember.organization_id);
      return found;
    },
    enabled: isAuthenticated && !!authorMember?.organization_id && !isGuestWriter,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
  });
  
  console.log('[ArticleView] Query state - orgLoading:', orgLoading, 'orgError:', orgError, 'authorOrganization:', authorOrganization);

  // Get organization name (from member's org or guest writer's organization field)
  const organizationName = isGuestWriter ? effectiveGuestWriter?.organization : authorOrganization?.name;

  // Fetch author engagement stats (only for authenticated members)
  const { data: authorStats } = useQuery({
    queryKey: ['author-stats', authorMember?.id],
    queryFn: async () => {
      if (!authorMember?.id) return { eventsAttended: 0, articlesWritten: 0, jobsPosted: 0 };

      const [bookings, articles, jobPostings] = await Promise.all([
        base44.entities.Booking.list(),
        base44.entities.BlogPost.list(),
        base44.entities.JobPosting.list()
      ]);

      const eventsAttended = bookings.filter(b => b.member_id === authorMember.id && b.status === 'confirmed').length;
      const articlesWritten = articles.filter(a => a.author_id === authorMember.id && a.status === 'published').length;
      const jobsPosted = jobPostings.filter(j => j.posted_by_member_id === authorMember.id).length;

      return { eventsAttended, articlesWritten, jobsPosted };
    },
    enabled: isAuthenticated && !!authorMember?.id && !isGuestWriter,
  });

  // Fetch online awards - only for authenticated users
  const { data: awards = [] } = useQuery({
    queryKey: ['awards'],
    queryFn: async () => {
      const allAwards = await base44.entities.Award.list();
      return allAwards.filter(a => a.is_active).sort((a, b) => (a.level || 0) - (b.level || 0));
    },
    enabled: isAuthenticated,
  });

  // Fetch offline award assignments for author - only for authenticated users
  const { data: authorOfflineAssignments = [] } = useQuery({
    queryKey: ['author-offline-assignments', authorMember?.id],
    queryFn: async () => {
      if (!authorMember?.id) return [];
      const allAssignments = await base44.entities.OfflineAwardAssignment.list();
      return allAssignments.filter(a => a.member_id === authorMember.id);
    },
    enabled: isAuthenticated && !!authorMember?.id,
  });

  // Fetch offline awards - only for authenticated users
  const { data: offlineAwards = [] } = useQuery({
    queryKey: ['offlineAwards'],
    queryFn: async () => {
      const allAwards = await base44.entities.OfflineAward.list();
      return allAwards.filter(a => a.is_active);
    },
    enabled: isAuthenticated,
  });

  // Calculate author's earned online awards
  const authorEarnedOnlineAwards = React.useMemo(() => {
    if (!authorStats || !awards || awards.length === 0) return [];

    return awards.filter(award => {
      const stat = award.award_type === 'events_attended' ? authorStats.eventsAttended :
                   award.award_type === 'articles_published' ? authorStats.articlesWritten :
                   award.award_type === 'jobs_posted' ? authorStats.jobsPosted : 0;
      return stat >= award.threshold;
    });
  }, [authorStats, awards]);

  // Get author's earned offline awards
  const authorEarnedOfflineAwards = React.useMemo(() => {
    if (!authorOfflineAssignments || authorOfflineAssignments.length === 0 || !offlineAwards) return [];
    
    return authorOfflineAssignments
      .map(assignment => offlineAwards.find(award => award.id === assignment.offline_award_id))
      .filter(Boolean)
      .sort((a, b) => (a.level || 0) - (b.level || 0));
  }, [authorOfflineAssignments, offlineAwards]);

  // Check if user is following the author
  const authorId = article?.author_id || null;
  const guestWriterId = article?.guest_writer_id || null;
  
  const { data: followStatus = { following: false, followId: null } } = useQuery({
    queryKey: ['follow-status', authorId, guestWriterId],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (authorId) params.set('author_id', authorId);
      if (guestWriterId) params.set('guest_writer_id', guestWriterId);
      const response = await fetch(`/api/article-follows/check?${params.toString()}`, {
        credentials: 'include'
      });
      if (!response.ok) return { following: false, followId: null };
      return response.json();
    },
    // Only check follow status for authenticated users
    enabled: isAuthenticated && (!!authorId || !!guestWriterId),
  });

  // Follow author mutation
  const followMutation = useMutation({
    mutationFn: async () => {
      const response = await fetch('/api/article-follows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          followed_member_id: authorId || null,
          followed_guest_writer_id: guestWriterId || null
        })
      });
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to follow author');
      }
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['follow-status', authorId, guestWriterId] });
      queryClient.invalidateQueries({ queryKey: ['article-follows'] });
      toast.success('Now following this author');
    },
    onError: (error) => {
      toast.error(error.message || 'Failed to follow author');
    }
  });

  // Unfollow author mutation
  const unfollowMutation = useMutation({
    mutationFn: async (followId) => {
      const response = await fetch(`/api/article-follows/${followId}`, {
        method: 'DELETE',
        credentials: 'include'
      });
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to unfollow author');
      }
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['follow-status', authorId, guestWriterId] });
      queryClient.invalidateQueries({ queryKey: ['article-follows'] });
      toast.success('Unfollowed author');
    },
    onError: (error) => {
      toast.error(error.message || 'Failed to unfollow author');
    }
  });

  // Handler for follow/unfollow toggle
  const handleFollowToggle = () => {
    if (followStatus.following && followStatus.followId) {
      unfollowMutation.mutate(followStatus.followId);
    } else {
      followMutation.mutate();
    }
  };

  // Check if current user is the author (can't follow yourself)
  const isCurrentUserAuthor = memberInfo && (authorId === memberInfo.id);

  // Mark as read mutation (for followed authors)
  const markAsReadMutation = useMutation({
    mutationFn: async (followId) => {
      const response = await fetch(`/api/article-follows/${followId}/mark-read`, {
        method: 'PATCH',
        credentials: 'include'
      });
      if (!response.ok) {
        throw new Error('Failed to mark as read');
      }
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['article-follows'] });
    }
  });

  // Track if we've already marked as read for this article view
  const [markedAsRead, setMarkedAsRead] = useState(false);

  // Mark as read when viewing an article from a followed author (only once per page load)
  useEffect(() => {
    if (
      followStatus.following && 
      followStatus.followId && 
      article && 
      !isPreviewMode && 
      !markedAsRead
    ) {
      markAsReadMutation.mutate(followStatus.followId);
      setMarkedAsRead(true);
    }
  }, [followStatus.following, followStatus.followId, article?.id, isPreviewMode, markedAsRead]);

  // Record view mutation - only for authenticated users
  const recordViewMutation = useMutation({
    mutationFn: async () => {
      // Guard: only record views for authenticated users
      if (!isAuthenticated || !article || !userIdentifier || viewRecorded) return;

      // Check if this user has already viewed this article
      const existingViews = await base44.entities.ArticleView.list();
      const hasViewed = existingViews.some(
        v => v.article_id === article.id && v.user_identifier === userIdentifier
      );

      if (!hasViewed) {
        await base44.entities.ArticleView.create({
          article_id: article.id,
          user_identifier: userIdentifier,
          is_member: !!memberInfo
        });
        setViewRecorded(true);
      }
    },
  });

  // Record view when article and user identifier are available (skip in preview mode)
  useEffect(() => {
    // Only record views for authenticated users (view tracking uses authenticated API)
    if (isAuthenticated && article && userIdentifier && !viewRecorded && !isPreviewMode) {
      recordViewMutation.mutate();
    }
  }, [isAuthenticated, article, userIdentifier, viewRecorded, isPreviewMode]);

  // Set SEO meta tags when article loads
  useEffect(() => {
    if (article) {
      document.title = article.seo_title || article.title || 'Article';
      
      let metaDescription = document.querySelector('meta[name="description"]');
      if (!metaDescription) {
        metaDescription = document.createElement('meta');
        metaDescription.name = 'description';
        document.head.appendChild(metaDescription);
      }
      metaDescription.content = article.seo_description || article.summary || '';

      let ogTitle = document.querySelector('meta[property="og:title"]');
      if (!ogTitle) {
        ogTitle = document.createElement('meta');
        ogTitle.setAttribute('property', 'og:title');
        document.head.appendChild(ogTitle);
      }
      ogTitle.content = article.seo_title || article.title || '';

      let ogDescription = document.querySelector('meta[property="og:description"]');
      if (!ogDescription) {
        ogDescription = document.createElement('meta');
        ogDescription.setAttribute('property', 'og:description');
        document.head.appendChild(ogDescription);
      }
      ogDescription.content = article.seo_description || article.summary || '';

      if (article.feature_image_url) {
        let ogImage = document.querySelector('meta[property="og:image"]');
        if (!ogImage) {
          ogImage = document.createElement('meta');
          ogImage.setAttribute('property', 'og:image');
          document.head.appendChild(ogImage);
        }
        ogImage.content = article.feature_image_url;
      }

      let ogType = document.querySelector('meta[property="og:type"]');
      if (!ogType) {
        ogType = document.createElement('meta');
        ogType.setAttribute('property', 'og:type');
        document.head.appendChild(ogType);
      }
      ogType.content = 'article';
    }

    return () => {
      document.title = 'AGCAS';
    };
  }, [article]);

  // Share handlers
  const handleLinkedInShare = () => {
    const articleUrl = encodeURIComponent(window.location.href);
    const linkedInUrl = `https://www.linkedin.com/sharing/share-offsite/?url=${articleUrl}`;
    window.open(linkedInUrl, '_blank', 'width=600,height=600');
  };

  const handleEmailShare = () => {
    const displayName = articleDisplayName.endsWith('s') ? articleDisplayName.slice(0, -1).toLowerCase() : articleDisplayName.toLowerCase();
    const subject = encodeURIComponent(article?.title || `Check out this ${displayName}`);
    const body = encodeURIComponent(
      `I thought you might find this ${displayName} interesting:\n\n${article?.title || ''}\n\n${article?.summary || ''}\n\n${window.location.href}`
    );
    window.location.href = `mailto:?subject=${subject}&body=${body}`;
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8 flex items-center justify-center">
        <div className="animate-pulse text-slate-600">Loading...</div>
      </div>
    );
  }

  // Get singular form of display name for messages
  const singularDisplayName = articleDisplayName.endsWith('s') 
    ? articleDisplayName.slice(0, -1) 
    : articleDisplayName;

  if (!article) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
        <div className="max-w-4xl mx-auto text-center py-16">
          <h2 className="text-2xl font-bold text-slate-900 mb-4">{singularDisplayName} not found</h2>
          <Link to={isLoggedIn ? getArticleListUrl() : getPublicArticlesUrl()}>
            <Button>Back to {articleDisplayName}</Button>
          </Link>
        </div>
      </div>
    );
  }

  // Check if current user is the author
  const isAuthor = memberInfo && article.author_id === memberInfo.id;

  // Check if article is a draft and if user has permission to view it
  const isDraft = article.status !== 'published';
  const canViewDraft = isDraft && isPreviewMode && (isAuthor || isAdmin);

  // If it's a draft and user doesn't have permission, show not found
  if (isDraft && !canViewDraft) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
        <div className="max-w-4xl mx-auto text-center py-16">
          <h2 className="text-2xl font-bold text-slate-900 mb-4">{singularDisplayName} not found</h2>
          <p className="text-slate-600 mb-6">This {singularDisplayName.toLowerCase()} is not available.</p>
          <Link to={isLoggedIn ? getArticleListUrl() : getPublicArticlesUrl()}>
            <Button>Back to {articleDisplayName}</Button>
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
      <div className="max-w-4xl mx-auto">
        {/* Preview Mode Banner */}
        {isDraft && canViewDraft && (
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 mb-6 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-amber-100 rounded-full">
                <Eye className="w-5 h-5 text-amber-600" />
              </div>
              <div>
                <p className="font-medium text-amber-800">Preview Mode</p>
                <p className="text-sm text-amber-600">This {singularDisplayName.toLowerCase()} is in {article.status} status and not visible to the public.</p>
              </div>
            </div>
            <Link to={getArticleEditorUrl(article.id)}>
              <Button size="sm" className="bg-amber-600 hover:bg-amber-700 gap-2">
                <Edit className="w-4 h-4" />
                Edit
              </Button>
            </Link>
          </div>
        )}

        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <Link 
            to={isLoggedIn ? getArticleListUrl() : getPublicArticlesUrl()} 
            className="inline-flex items-center gap-2 text-slate-600 hover:text-slate-900"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to {articleDisplayName}
          </Link>
          
          {isAuthor && (
            <Link to={getArticleEditorUrl(article.id)}>
              <Button variant="outline" className="gap-2">
                <Edit className="w-4 h-4" />
                Edit
              </Button>
            </Link>
          )}
        </div>

        {/* Article Content */}
        <Card className="border-slate-200 shadow-lg mb-8">
          {article.feature_image_url && (
            <div className="h-96 overflow-hidden rounded-t-lg">
              <img 
                src={article.feature_image_url} 
                alt={article.title}
                className="w-full h-full object-cover"
              />
            </div>
          )}
          
          <CardContent className="pt-8 pb-12 px-8 md:px-12">
            {/* Meta Info */}
            <div className="flex flex-wrap items-center gap-4 text-sm text-slate-600 mb-6">
              {article.subcategories && article.subcategories.length > 0 && (
                <>
                  {article.subcategories.slice(0, 3).map((subcat, idx) => (
                    <Badge key={idx} variant="secondary" className="bg-blue-100 text-blue-700">
                      {subcat}
                    </Badge>
                  ))}
                  {article.subcategories.length > 3 && (
                    <Badge variant="secondary" className="bg-slate-100 text-slate-700">
                      +{article.subcategories.length - 3} more
                    </Badge>
                  )}
                </>
              )}
              {articleSettings?.showViewCount && (
                <div className="flex items-center gap-1">
                  <Eye className="w-4 h-4 text-purple-600" />
                  <span className="font-medium">{viewCount} {viewCount === 1 ? 'view' : 'views'}</span>
                </div>
              )}
              {article.published_date && (
                <div className="flex items-center gap-2">
                  <Calendar className="w-4 h-4" />
                  <span>{format(new Date(article.published_date), 'MMMM d, yyyy')}</span>
                </div>
              )}
            </div>

            {/* Title */}
            <h1 className="text-4xl md:text-5xl font-bold text-slate-900 mb-6">
              {article.title}
            </h1>

            {/* Summary */}
            {article.summary && (
              <p className="text-xl text-slate-600 mb-8 leading-relaxed">
                {article.summary}
              </p>
            )}

            {/* Author Profile Section */}
            {author && (
              <div className="mb-8 p-6 bg-gradient-to-br from-slate-50 to-blue-50 rounded-lg border border-slate-200">
                {articleSettings?.showAboutAuthorLabel && (
                  <h4 className="text-sm font-semibold text-slate-700 mb-4">About the author</h4>
                )}
                <div className="flex items-start gap-4">
                  {/* Profile Picture */}
                  {articleSettings?.showAuthorPhoto && (
                    <div className="flex-shrink-0">
                      {author.profile_photo_url ? (
                        <img 
                          src={author.profile_photo_url} 
                          alt={isGuestWriter ? author.full_name : `${author.first_name} ${author.last_name}`}
                          className="w-20 h-20 rounded-full object-cover border-2 border-slate-200"
                        />
                      ) : (
                        <div className="w-20 h-20 rounded-full bg-slate-200 flex items-center justify-center">
                          <User className="w-10 h-10 text-slate-400" />
                        </div>
                      )}
                    </div>
                  )}

                  {/* Author Info */}
                  <div className="flex-1">
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <h3 className="text-lg font-semibold text-slate-900">
                          {isGuestWriter ? author.full_name : `${author.first_name} ${author.last_name}`}
                        </h3>
                        {articleSettings?.showAuthorOrganization && organizationName && (
                          <p className="text-sm text-blue-700 font-medium mt-0.5">{organizationName}</p>
                        )}
                        {author.job_title && (
                          <p className="text-sm text-slate-600 mt-1">{author.job_title}</p>
                        )}
                        {articleSettings?.showAuthorEmail && author.email && (
                          <p className="text-sm text-slate-600 mt-1">{author.email}</p>
                        )}
                      </div>
                      
                      {memberInfo && !isCurrentUserAuthor && !isFeatureExcluded('content.articles.follow-author') && (
                        <Button
                          variant={followStatus.following ? "outline" : "default"}
                          size="sm"
                          onClick={handleFollowToggle}
                          disabled={followMutation.isPending || unfollowMutation.isPending}
                          className="gap-2 flex-shrink-0"
                          data-testid="button-follow-author"
                        >
                          {followMutation.isPending || unfollowMutation.isPending ? (
                            <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                          ) : followStatus.following ? (
                            <>
                              <UserMinus className="w-4 h-4" />
                              Unfollow
                            </>
                          ) : (
                            <>
                              <UserPlus className="w-4 h-4" />
                              Follow
                            </>
                          )}
                        </Button>
                      )}
                    </div>

                    {/* Biography */}
                    {articleSettings?.showAuthorBio && author.biography && (
                      <div className="mt-3">
                        <p className={`text-sm text-slate-700 leading-relaxed ${!bioExpanded ? 'line-clamp-3' : ''}`}>
                          {author.biography}
                        </p>
                        <button
                          onClick={() => setBioExpanded(!bioExpanded)}
                          className="flex items-center gap-1 text-sm text-blue-600 hover:text-blue-700 mt-2 font-medium"
                        >
                          {bioExpanded ? (
                            <>
                              Hide <ChevronUp className="w-4 h-4" />
                            </>
                          ) : (
                            <>
                              Read More <ChevronDown className="w-4 h-4" />
                            </>
                          )}
                        </button>
                      </div>
                    )}

                    {/* Awards (only for member authors) */}
                    {!isGuestWriter && (authorEarnedOnlineAwards.length > 0 || authorEarnedOfflineAwards.length > 0) && (
                      <div className="mt-4">
                        {articleSettings?.showAwardsLabel && (
                          <div className="flex items-center gap-2 mb-2">
                            <Trophy className="w-4 h-4 text-amber-600" />
                            <span className="text-xs font-semibold text-slate-700">Awards</span>
                          </div>
                        )}
                        <div className="flex flex-wrap gap-2">
                          {authorEarnedOnlineAwards.slice(0, 4).map(award => (
                            <div 
                              key={award.id} 
                              className="flex items-center gap-2 px-3 py-1.5 bg-gradient-to-br from-amber-50 to-amber-100 rounded-lg border border-amber-200"
                              title={award.description}
                            >
                              {award.image_url ? (
                                <img src={award.image_url} alt={award.name} className="w-5 h-5 object-contain" />
                              ) : (
                                <Trophy className="w-4 h-4 text-amber-600" />
                              )}
                              <span className="text-xs font-medium text-slate-900">{award.name}</span>
                            </div>
                          ))}
                          {authorEarnedOfflineAwards.slice(0, 4).map(award => (
                            <div 
                              key={award.id} 
                              className="flex items-center gap-2 px-3 py-1.5 bg-gradient-to-br from-purple-50 to-purple-100 rounded-lg border border-purple-200"
                              title={award.description}
                            >
                              {award.image_url ? (
                                <img src={award.image_url} alt={award.name} className="w-5 h-5 object-contain" />
                              ) : (
                                <Trophy className="w-4 h-4 text-purple-600" />
                              )}
                              <span className="text-xs font-medium text-slate-900">{award.name}</span>
                            </div>
                          ))}
                          {(authorEarnedOnlineAwards.length + authorEarnedOfflineAwards.length > 4) && (
                            <div className="px-3 py-1.5 bg-slate-100 rounded-lg border border-slate-200">
                              <span className="text-xs font-medium text-slate-600">
                                +{(authorEarnedOnlineAwards.length + authorEarnedOfflineAwards.length) - 4} more
                              </span>
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Content */}
            <div 
              className="prose prose-lg prose-slate max-w-none"
              dangerouslySetInnerHTML={{ __html: article.content }}
            />

            {/* Tags */}
            {article.tags && article.tags.length > 0 && (
              <div className="mt-12 pt-8 border-t border-slate-200">
                <div className="flex items-center gap-2 flex-wrap">
                  <Tag className="w-4 h-4 text-slate-400" />
                  {article.tags.map(tag => (
                    <Badge key={tag} variant="outline" className="text-sm">
                      {tag}
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            {/* Article Reactions and Share */}
            <div className="mt-12 pt-8 border-t border-slate-200">
              <div className="flex flex-col gap-6">
                {/* Reactions Section */}
                {(articleSettings?.showThumbsUp || articleSettings?.showThumbsDown) && (
                  <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                    <p className="text-sm text-slate-600">Was this {singularDisplayName.toLowerCase()} helpful?</p>
                    <ArticleReactions 
                      articleId={article.id} 
                      memberInfo={memberInfo}
                      showThumbsUp={articleSettings?.showThumbsUp}
                      showThumbsDown={articleSettings?.showThumbsDown}
                    />
                  </div>
                )}
                
                {/* Share Section */}
                <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 pt-4 border-t border-slate-200">
                  <p className="text-sm text-slate-600">Share this {singularDisplayName.toLowerCase()}:</p>
                  <div className="flex items-center gap-3">
                    <Button
                      variant="outline"
                      size="lg"
                      onClick={handleLinkedInShare}
                      className="gap-2 hover:bg-[#0077B5] hover:text-white hover:border-[#0077B5] transition-all"
                    >
                      <Linkedin className="w-5 h-5" />
                      <span>LinkedIn</span>
                    </Button>
                    <Button
                      variant="outline"
                      size="lg"
                      onClick={handleEmailShare}
                      className="gap-2 hover:bg-slate-700 hover:text-white hover:border-slate-700 transition-all"
                    >
                      <Mail className="w-5 h-5" />
                      <span>Email</span>
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Comments Section - shown if authenticated OR public comments are allowed */}
        {(isAuthenticated || articleSettings?.allowPublicComments) && !isFeatureExcluded('content.articles.comments') && (
          <ArticleComments 
            articleId={article.id} 
            memberInfo={memberInfo}
            showThumbsUp={articleSettings?.showThumbsUp}
            showThumbsDown={articleSettings?.showThumbsDown}
          />
        )}
      </div>
    </div>
  );
}