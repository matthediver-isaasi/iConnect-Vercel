import React, { useEffect, useState } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Calendar, User, Edit, Tag, Eye, Linkedin, Mail, Trophy, ChevronDown, ChevronUp } from "lucide-react";
import { format } from "date-fns";
import { Link } from "react-router-dom";
import ArticleComments from "../components/blog/ArticleComments";
import ArticleReactions from "../components/blog/ArticleReactions";
import { toast } from "sonner";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { useArticleUrl } from "@/contexts/ArticleUrlContext";

export default function ArticleViewPage() {
  const { memberInfo, isAdmin } = useMemberAccess();
  const { getArticleListUrl, getArticleEditorUrl, getPublicArticlesUrl } = useArticleUrl();
  console.log('[ArticleView] Component initialized');
  console.log('[ArticleView] window.location.href:', window.location.href);
  console.log('[ArticleView] window.location.search:', window.location.search);
  console.log('[ArticleView] window.location.hash:', window.location.hash);
  console.log('[ArticleView] window.location.pathname:', window.location.pathname);
  
  const urlParams = new URLSearchParams(window.location.search);
  console.log('[ArticleView] urlParams created from window.location.search');
  
  const slug = urlParams.get('slug');
  const isPreviewMode = urlParams.get('preview') === 'true';
  console.log('[ArticleView] slug extracted from urlParams:', slug);
  console.log('[ArticleView] isPreviewMode:', isPreviewMode);
  
  const [userIdentifier, setUserIdentifier] = useState("");
  const [viewRecorded, setViewRecorded] = useState(false);
  const [bioExpanded, setBioExpanded] = useState(false);

  // Fetch article settings
  const { data: articleSettings } = useQuery({
    queryKey: ['article-settings'],
    queryFn: async () => {
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
        showThumbsDown: thumbsDownSetting?.setting_value !== 'false'
      };
      console.log('[ArticleView] Parsed settings:', settings);
      return settings;
    },
    staleTime: 0,
    refetchOnMount: true,
  });

  // Fetch article display name
  const { data: articleDisplayName = 'Articles' } = useQuery({
    queryKey: ['article-display-name'],
    queryFn: async () => {
      const allSettings = await base44.entities.SystemSettings.list();
      const setting = allSettings.find(s => s.setting_key === 'article_display_name');
      return setting?.setting_value || 'Articles';
    }
  });

  // Determine if user is logged in by checking session storage
  const isLoggedIn = !!sessionStorage.getItem('agcas_member');

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

  const { data: article, isLoading } = useQuery({
    queryKey: ['article-by-slug', slug],
    queryFn: async () => {
      console.log('[ArticleView] Fetching article for slug:', slug);
      const articles = await base44.entities.BlogPost.list();
      const found = articles.find(a => a.slug === slug);
      console.log('[ArticleView] Article found:', !!found);
      console.log('[ArticleView] Article author_id:', found?.author_id);
      return found;
    },
    enabled: !!slug,
  });

  // Fetch view count
  const { data: viewCount = 0 } = useQuery({
    queryKey: ['article-view-count', article?.id],
    queryFn: async () => {
      const views = await base44.entities.ArticleView.list();
      return views.filter(v => v.article_id === article.id).length;
    },
    enabled: !!article?.id,
    staleTime: 10 * 1000,
  });

  // Fetch author details (either member or guest writer)
  const { data: authorMember } = useQuery({
    queryKey: ['author-member', article?.author_id],
    queryFn: async () => {
      if (!article?.author_id) return null;
      const members = await base44.entities.Member.listAll();
      const found = members.find(m => m.id === article.author_id);
      console.log('[ArticleView] authorMember found:', found);
      console.log('[ArticleView] authorMember.organization_id:', found?.organization_id);
      return found;
    },
    enabled: !!article?.author_id,
  });

  // Fetch guest writer details if applicable
  const { data: guestWriter } = useQuery({
    queryKey: ['guest-writer', article?.guest_writer_id],
    queryFn: async () => {
      if (!article?.guest_writer_id) return null;
      const writers = await base44.entities.GuestWriter.list();
      return writers.find(w => w.id === article.guest_writer_id);
    },
    enabled: !!article?.guest_writer_id,
  });

  // Determine which author to use
  const author = guestWriter || authorMember;
  const isGuestWriter = !!guestWriter;

  // Fetch author organization (only for members)
  const { data: authorOrganization, isLoading: orgLoading, isError: orgError } = useQuery({
    queryKey: ['author-organization', authorMember?.organization_id],
    queryFn: async () => {
      console.log('[ArticleView] Fetching organization for Zoho ID:', authorMember?.organization_id);
      if (!authorMember?.organization_id) {
        console.log('[ArticleView] No organization_id, returning null');
        return null;
      }
      const orgs = await base44.entities.Organization.list();
      console.log('[ArticleView] All organizations:', orgs.length);
      console.log('[ArticleView] Looking for org with zoho_account_id:', authorMember.organization_id);
      const found = orgs.find(o => o.zoho_account_id === authorMember.organization_id);
      console.log('[ArticleView] Found organization:', found);
      return found;
    },
    enabled: !!authorMember?.organization_id && !isGuestWriter,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
  });
  
  console.log('[ArticleView] Query state - orgLoading:', orgLoading, 'orgError:', orgError, 'authorOrganization:', authorOrganization);

  // Get organization name (from member's org or guest writer's organization field)
  const organizationName = isGuestWriter ? guestWriter?.organization : authorOrganization?.name;

  // Fetch author engagement stats (only for members)
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
    enabled: !!authorMember?.id && !isGuestWriter,
  });

  // Fetch online awards
  const { data: awards = [] } = useQuery({
    queryKey: ['awards'],
    queryFn: async () => {
      const allAwards = await base44.entities.Award.list();
      return allAwards.filter(a => a.is_active).sort((a, b) => (a.level || 0) - (b.level || 0));
    },
  });

  // Fetch offline award assignments for author
  const { data: authorOfflineAssignments = [] } = useQuery({
    queryKey: ['author-offline-assignments', authorMember?.id],
    queryFn: async () => {
      if (!authorMember?.id) return [];
      const allAssignments = await base44.entities.OfflineAwardAssignment.list();
      return allAssignments.filter(a => a.member_id === authorMember.id);
    },
    enabled: !!authorMember?.id,
  });

  // Fetch offline awards
  const { data: offlineAwards = [] } = useQuery({
    queryKey: ['offlineAwards'],
    queryFn: async () => {
      const allAwards = await base44.entities.OfflineAward.list();
      return allAwards.filter(a => a.is_active);
    },
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

  // Record view mutation
  const recordViewMutation = useMutation({
    mutationFn: async () => {
      if (!article || !userIdentifier || viewRecorded) return;

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
    if (article && userIdentifier && !viewRecorded && !isPreviewMode) {
      recordViewMutation.mutate();
    }
  }, [article, userIdentifier, viewRecorded, isPreviewMode]);

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
                    <div className="flex items-start justify-between">
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

        {/* Comments Section */}
        <ArticleComments 
          articleId={article.id} 
          memberInfo={memberInfo}
          showThumbsUp={articleSettings?.showThumbsUp}
          showThumbsDown={articleSettings?.showThumbsDown}
        />
      </div>
    </div>
  );
}