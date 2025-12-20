import React, { useState, useEffect, useRef, useMemo } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { ArrowLeft, Save, Eye, Trash2, Upload, X, Loader2, CheckCircle2, Clock, User, Share2, Copy, Check } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { format } from "date-fns";
import ReactQuill from 'react-quill';
import 'react-quill/dist/quill.snow.css';
import TagInput from "../components/blog/TagInput";
import SubcategorySelector from "../components/blog/SubcategorySelector";
import StatusSelector from "../components/blog/StatusSelector";
import SEOSettings from "../components/blog/SEOSettings";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { useArticleUrl } from "@/contexts/ArticleUrlContext";

export default function ArticleEditorPage() {
  const { memberInfo, isFeatureExcluded } = useMemberAccess();
  const { getArticleListUrl, getArticleEditorUrl, getMyArticlesUrl, baseUrlPath } = useArticleUrl();
  const urlParams = new URLSearchParams(window.location.search);
  const articleId = urlParams.get('id');
  const isEditing = !!articleId;
  
  const queryClient = useQueryClient();
  const quillRef = useRef(null);
  
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [summary, setSummary] = useState("");
  const [content, setContent] = useState("");
  const [featureImage, setFeatureImage] = useState("");
  const [subcategories, setSubcategories] = useState([]);
  const [tags, setTags] = useState([]);
  const [status, setStatus] = useState("draft");
  const [seoTitle, setSeoTitle] = useState("");
  const [seoDescription, setSeoDescription] = useState("");
  const [publishedDate, setPublishedDate] = useState(new Date().toISOString());
  const [uploadingImage, setUploadingImage] = useState(false);
  const [autoSaving, setAutoSaving] = useState(false);
  const [lastSaved, setLastSaved] = useState(null);
  const [authorType, setAuthorType] = useState("member"); // "member", "guest", or "other_member"
  const [selectedGuestWriterId, setSelectedGuestWriterId] = useState(null);
  const [originalAuthorId, setOriginalAuthorId] = useState(null);
  const [originalAuthorName, setOriginalAuthorName] = useState(null);
  const [originalAuthorHandle, setOriginalAuthorHandle] = useState(null);
  const [isOtherMemberArticle, setIsOtherMemberArticle] = useState(false);
  // Persisted original_author_id from database - never changes after first set
  const [persistedOriginalAuthorId, setPersistedOriginalAuthorId] = useState(null);
  const [persistedOriginalAuthorName, setPersistedOriginalAuthorName] = useState(null);
  const [slugError, setSlugError] = useState(null);
  const [checkingSlug, setCheckingSlug] = useState(false);
  // Share draft functionality
  const [showShareDialog, setShowShareDialog] = useState(false);
  const [sharePassword, setSharePassword] = useState("");
  const [copiedLink, setCopiedLink] = useState(false);
  const [copiedPassword, setCopiedPassword] = useState(false);

  // Fetch current member's full record to get the handle
  // First check if memberInfo already has handle (from login), otherwise fetch by ID
  const { data: currentMember, isLoading: memberLoading } = useQuery({
    queryKey: ['current-member', memberInfo?.id],
    queryFn: async () => {
      // If memberInfo already has handle, use it directly
      if (memberInfo?.handle) {
        return memberInfo;
      }
      // Otherwise fetch by ID to get the full member record
      if (memberInfo?.id) {
        try {
          const member = await base44.entities.Member.get(memberInfo.id);
          return member || null;
        } catch (error) {
          console.error('Error fetching member by ID:', error);
          return null;
        }
      }
      return null;
    },
    enabled: !!memberInfo?.id || !!memberInfo?.handle
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

  // Get singular form of display name
  const singularDisplayName = articleDisplayName.endsWith('s') 
    ? articleDisplayName.slice(0, -1) 
    : articleDisplayName;

  // Fetch categories from ResourceCategory (shared with Resources)
  const { data: categories = [] } = useQuery({
    queryKey: ['resourceCategories-articles'],
    queryFn: async () => {
      const cats = await base44.entities.ResourceCategory.list();
      const articleCategories = cats.filter(c =>
        c.is_active &&
        c.applies_to_content_types &&
        c.applies_to_content_types.includes("Articles")
      );
      return articleCategories.sort((a, b) => (a.display_order || 0) - (b.display_order || 0));
    }
  });

  // Fetch guest writers
  const { data: guestWriters = [] } = useQuery({
    queryKey: ['guest-writers-active'],
    queryFn: async () => {
      const writers = await base44.entities.GuestWriter.list();
      return writers.filter(w => w.is_active);
    }
  });

  // Fetch existing article if editing
  const { data: article, isLoading: articleLoading } = useQuery({
    queryKey: ['article', articleId],
    queryFn: async () => {
      const articles = await base44.entities.BlogPost.list();
      return articles.find(a => a.id === articleId);
    },
    enabled: isEditing,
  });

  // Load article data into form - only set non-author fields initially
  useEffect(() => {
    if (article) {
      setTitle(article.title || "");
      setSummary(article.summary || "");
      setContent(article.content || "");
      setFeatureImage(article.feature_image_url || "");
      setSubcategories(article.subcategories || []);
      setTags(article.tags || []);
      setStatus(article.status || "draft");
      setPublishedDate(article.published_date || new Date().toISOString());
      setSeoTitle(article.seo_title || "");
      setSeoDescription(article.seo_description || "");
      setSharePassword(article.share_password || "");
      
      // Handle slug - new structure stores clean slugs without handle suffix
      // For legacy articles, extract the base slug from "-by-{handle}" format
      let displaySlug = article.slug || "";
      const byHandleMatch = displaySlug.match(/-by-([a-z0-9-]+)$/i);
      if (byHandleMatch) {
        // Legacy format: extract clean slug and handle
        displaySlug = displaySlug.slice(0, -byHandleMatch[0].length);
        setOriginalAuthorHandle(byHandleMatch[1]);
      }
      setSlug(displaySlug);
    }
  }, [article]);

  // Fetch current author's handle if article has an author_id
  const { data: currentAuthorMember } = useQuery({
    queryKey: ['current-author', article?.author_id],
    queryFn: async () => {
      if (!article?.author_id) return null;
      try {
        const member = await base44.entities.Member.get(article.author_id);
        return member || null;
      } catch (error) {
        console.error('Error fetching current author:', error);
        return null;
      }
    },
    enabled: !!article?.author_id
  });

  // Fetch the persisted original author's details (from original_author_id column)
  const { data: persistedOriginalAuthorMember } = useQuery({
    queryKey: ['persisted-original-author', article?.original_author_id],
    queryFn: async () => {
      if (!article?.original_author_id) return null;
      try {
        const member = await base44.entities.Member.get(article.original_author_id);
        return member || null;
      } catch (error) {
        console.error('Error fetching persisted original author:', error);
        return null;
      }
    },
    enabled: !!article?.original_author_id
  });

  // Set persisted original author ID from article - run when article loads
  useEffect(() => {
    if (!article) return;
    
    // Set persisted original author from database column
    if (article.original_author_id) {
      setPersistedOriginalAuthorId(article.original_author_id);
    }
    
    // Set basic article author data
    if (article.guest_writer_id) {
      setSelectedGuestWriterId(article.guest_writer_id);
      setOriginalAuthorId(null);
      setOriginalAuthorName(null);
      setOriginalAuthorHandle(null);
      setIsOtherMemberArticle(false);
    } else if (article.author_id) {
      setOriginalAuthorId(article.author_id);
      setOriginalAuthorName(null); // Will be set from currentAuthorMember lookup
      setIsOtherMemberArticle(true);
    } else {
      setOriginalAuthorId(null);
      setOriginalAuthorName(null);
      setOriginalAuthorHandle(null);
      setIsOtherMemberArticle(false);
    }
  }, [article]);

  // Determine authorType based on article, currentMember, and original author - runs after all data is loaded
  useEffect(() => {
    if (!article) return;
    
    if (article.guest_writer_id) {
      setAuthorType("guest");
    } else if (article.author_id) {
      // Check if the current author is the logged-in member
      if (currentMember?.id && article.author_id === currentMember.id) {
        setAuthorType("member");
      }
      // Check if the current author is the original author
      else if (article.original_author_id && article.author_id === article.original_author_id) {
        setAuthorType("revert_original");
      }
      // Otherwise it's a different member (takeover happened)
      else {
        setAuthorType("other_member");
      }
    } else {
      // No author - set as member (logged-in user becomes author)
      setAuthorType("member");
    }
  }, [article, currentMember?.id]);

  // Set persisted original author name when query loads
  useEffect(() => {
    if (persistedOriginalAuthorMember) {
      const fullName = `${persistedOriginalAuthorMember.first_name || ''} ${persistedOriginalAuthorMember.last_name || ''}`.trim();
      setPersistedOriginalAuthorName(fullName || "Original Author");
    }
  }, [persistedOriginalAuthorMember]);

  // Set current author details from member query
  useEffect(() => {
    if (currentAuthorMember) {
      if (currentAuthorMember.handle && !originalAuthorHandle) {
        setOriginalAuthorHandle(currentAuthorMember.handle);
      }
      // Set author name from looked-up member data
      const fullName = `${currentAuthorMember.first_name || ''} ${currentAuthorMember.last_name || ''}`.trim();
      if (fullName) {
        setOriginalAuthorName(fullName);
      }
    }
  }, [currentAuthorMember, originalAuthorHandle]);

  // Auto-generate slug from title
  useEffect(() => {
    if (title && !isEditing) {
      const generatedSlug = title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '');
      setSlug(generatedSlug);
    }
  }, [title, isEditing]);

  // Per-author slug uniqueness validation
  useEffect(() => {
    if (!slug) {
      setSlugError(null);
      return;
    }

    // Determine the author ID for uniqueness check
    let authorIdToCheck = null;
    let guestWriterIdToCheck = null;
    
    if (authorType === "guest") {
      guestWriterIdToCheck = selectedGuestWriterId;
    } else if (authorType === "other_member" && originalAuthorId) {
      authorIdToCheck = originalAuthorId;
    } else if (currentMember?.id) {
      authorIdToCheck = currentMember.id;
    }

    const checkSlugUniqueness = async () => {
      setCheckingSlug(true);
      try {
        const allArticles = await base44.entities.BlogPost.list();
        
        // Find articles with the same slug from the same author
        const duplicates = allArticles.filter(a => {
          // Skip the current article when editing
          if (isEditing && a.id === articleId) return false;
          
          // Extract base slug from legacy format if needed
          let articleSlug = a.slug || "";
          const byHandleMatch = articleSlug.match(/-by-([a-z0-9-]+)$/i);
          if (byHandleMatch) {
            articleSlug = articleSlug.slice(0, -byHandleMatch[0].length);
          }
          
          // Check if slug matches
          if (articleSlug !== slug) return false;
          
          // Check if same author
          if (authorType === "guest" && guestWriterIdToCheck) {
            return a.guest_writer_id === guestWriterIdToCheck;
          } else if (authorIdToCheck) {
            return a.author_id === authorIdToCheck;
          }
          
          return false;
        });

        if (duplicates.length > 0) {
          setSlugError("This URL is already in use. Please choose a different title or slug.");
        } else {
          setSlugError(null);
        }
      } catch (error) {
        console.error('Error checking slug uniqueness:', error);
      } finally {
        setCheckingSlug(false);
      }
    };

    // Debounce the check
    const timer = setTimeout(checkSlugUniqueness, 500);
    return () => clearTimeout(timer);
  }, [slug, authorType, originalAuthorId, selectedGuestWriterId, currentMember?.id, isEditing, articleId]);

  // Auto-save functionality
  useEffect(() => {
    if (!memberInfo || !title) return;
    // For member type, require handle. For other types, no handle required.
    if (authorType === "member" && !currentMember?.handle) return;

    const autoSaveTimer = setTimeout(async () => {
      if (isEditing) {
        setAutoSaving(true);
        try {
          let autoSaveData = {
            title,
            summary,
            content,
            feature_image_url: featureImage,
            subcategories,
            tags,
            status,
            published_date: publishedDate,
            seo_title: seoTitle,
            seo_description: seoDescription,
          };

          // New folder-based URL structure: store clean slugs
          autoSaveData.slug = slug;
          
          if (authorType === "guest") {
            autoSaveData.author_id = null;
            autoSaveData.guest_writer_id = selectedGuestWriterId;
          } else if (authorType === "revert_original" && persistedOriginalAuthorId) {
            // Reverting to original author
            autoSaveData.author_id = persistedOriginalAuthorId;
            autoSaveData.guest_writer_id = null;
          } else if (authorType === "other_member" && originalAuthorId) {
            // Keeping current author - no changes to author_id or original_author_id
            autoSaveData.author_id = originalAuthorId;
            autoSaveData.guest_writer_id = null;
          } else {
            // authorType === "member" - takeover
            autoSaveData.author_id = currentMember.id;
            autoSaveData.guest_writer_id = null;
            // Set original_author_id if not already set (first takeover)
            if (!persistedOriginalAuthorId && originalAuthorId) {
              autoSaveData.original_author_id = originalAuthorId;
            }
          }
          
          await base44.entities.BlogPost.update(articleId, autoSaveData);
          setLastSaved(new Date());
        } catch (error) {
          console.error('Auto-save failed:', error);
        } finally {
          setAutoSaving(false);
        }
      }
    }, 3000);

    return () => clearTimeout(autoSaveTimer);
  }, [title, slug, summary, content, featureImage, subcategories, tags, status, publishedDate, seoTitle, seoDescription, isEditing, articleId, memberInfo, currentMember, authorType, selectedGuestWriterId, originalAuthorId, originalAuthorName, persistedOriginalAuthorId, persistedOriginalAuthorName, article]);

  const saveMutation = useMutation({
    mutationFn: async (publishNow = false) => {
      if (!memberInfo) {
        throw new Error('Member information not available');
      }

      if (!currentMember) {
        throw new Error('Member record not found');
      }

      let finalSlug;
      let articleData;

      // New folder-based URL structure: slugs are stored clean (no handle suffix)
      // The URL is constructed as: {basePath}/{authorHandle}/{slug}
      finalSlug = slug; // Always store clean slug

      if (authorType === "guest") {
        if (!selectedGuestWriterId) {
          throw new Error('Please select a guest writer');
        }
        
        const guestWriter = guestWriters.find(w => w.id === selectedGuestWriterId);
        if (!guestWriter) {
          throw new Error('Selected guest writer not found');
        }

        articleData = {
          title,
          slug: finalSlug,
          author_id: null,
          guest_writer_id: selectedGuestWriterId,
          summary,
          content,
          feature_image_url: featureImage,
          subcategories,
          tags,
          status: publishNow ? 'published' : status,
          published_date: publishedDate,
          seo_title: seoTitle,
          seo_description: seoDescription,
        };
        // Guest writers don't have original_author_id
      } else if (authorType === "other_member" && originalAuthorId) {
        // Keep the current author - don't change author_id
        articleData = {
          title,
          slug: finalSlug,
          author_id: originalAuthorId,
          guest_writer_id: null,
          summary,
          content,
          feature_image_url: featureImage,
          subcategories,
          tags,
          status: publishNow ? 'published' : status,
          published_date: publishedDate,
          seo_title: seoTitle,
          seo_description: seoDescription,
        };
        // Preserve existing original_author_id, or set it if this is the first save
        if (!isEditing) {
          articleData.original_author_id = originalAuthorId;
        }
        // When editing, don't change original_author_id - it's already set in DB
      } else if (authorType === "revert_original" && persistedOriginalAuthorId) {
        // Revert to the persisted original author
        articleData = {
          title,
          slug: finalSlug,
          author_id: persistedOriginalAuthorId,
          guest_writer_id: null,
          summary,
          content,
          feature_image_url: featureImage,
          subcategories,
          tags,
          status: publishNow ? 'published' : status,
          published_date: publishedDate,
          seo_title: seoTitle,
          seo_description: seoDescription,
        };
        // original_author_id stays unchanged
      } else {
        // authorType === "member" - set current member as author (TAKEOVER)
        if (!currentMember.handle) {
          throw new Error(`You need a handle to publish ${articleDisplayName.toLowerCase()}. Please contact an administrator.`);
        }

        articleData = {
          title,
          slug: finalSlug,
          author_id: currentMember.id,
          guest_writer_id: null,
          summary,
          content,
          feature_image_url: featureImage,
          subcategories,
          tags,
          status: publishNow ? 'published' : status,
          published_date: publishedDate,
          seo_title: seoTitle,
          seo_description: seoDescription,
        };
        
        // For new articles: set original_author_id to the creating member
        // For takeover (editing): preserve existing original_author_id, or set it if not already set
        if (!isEditing) {
          articleData.original_author_id = currentMember.id;
        } else if (!persistedOriginalAuthorId && originalAuthorId) {
          // Taking over an article that doesn't have original_author_id set yet
          // Set it to the previous author before takeover
          articleData.original_author_id = originalAuthorId;
        }
        // If persistedOriginalAuthorId already exists, don't change it
      }

      if (isEditing) {
        return await base44.entities.BlogPost.update(articleId, articleData);
      } else {
        return await base44.entities.BlogPost.create(articleData);
      }
    },
    onSuccess: (data, publishNow) => {
      queryClient.invalidateQueries({ queryKey: ['articles'] });
      queryClient.invalidateQueries({ queryKey: ['my-articles'] });
      queryClient.invalidateQueries({ queryKey: ['all-articles-admin'] });
      queryClient.invalidateQueries({ queryKey: ['published-articles'] });
      toast.success(publishNow ? `${singularDisplayName} published successfully!` : `${singularDisplayName} saved successfully!`);
      setLastSaved(new Date());
      
      if (!isEditing) {
        window.location.href = getArticleEditorUrl(data.id);
      }
    },
    onError: (error) => {
      toast.error(error.message || `Failed to save ${singularDisplayName.toLowerCase()}`);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => base44.entities.BlogPost.delete(articleId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['articles'] });
      queryClient.invalidateQueries({ queryKey: ['my-articles'] });
      queryClient.invalidateQueries({ queryKey: ['all-articles-admin'] });
      queryClient.invalidateQueries({ queryKey: ['published-articles'] });
      toast.success(`${singularDisplayName} deleted successfully`);
      window.location.href = getArticleListUrl();
    },
    onError: () => {
      toast.error(`Failed to delete ${singularDisplayName.toLowerCase()}`);
    },
  });

  // Generate a random 4-digit password
  const generateSharePassword = () => {
    return Math.floor(1000 + Math.random() * 9000).toString();
  };

  // Share mutation to save password
  const shareMutation = useMutation({
    mutationFn: async (password) => {
      return await base44.entities.BlogPost.update(articleId, { share_password: password });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['article', articleId] });
      toast.success('Share link generated!');
    },
    onError: () => {
      toast.error('Failed to generate share link');
    },
  });

  const handleShare = () => {
    // Generate new password if none exists
    const password = sharePassword || generateSharePassword();
    if (!sharePassword) {
      setSharePassword(password);
      shareMutation.mutate(password);
    }
    setShowShareDialog(true);
    setCopiedLink(false);
    setCopiedPassword(false);
  };

  const regeneratePassword = () => {
    const newPassword = generateSharePassword();
    setSharePassword(newPassword);
    shareMutation.mutate(newPassword);
    setCopiedPassword(false);
  };

  const getShareUrl = () => {
    const baseUrl = window.location.origin;
    return `${baseUrl}/article-preview/${articleId}`;
  };

  const copyToClipboard = async (text, type) => {
    try {
      await navigator.clipboard.writeText(text);
      if (type === 'link') {
        setCopiedLink(true);
        setTimeout(() => setCopiedLink(false), 2000);
      } else {
        setCopiedPassword(true);
        setTimeout(() => setCopiedPassword(false), 2000);
      }
      toast.success(`${type === 'link' ? 'Link' : 'Password'} copied!`);
    } catch (err) {
      toast.error('Failed to copy');
    }
  };

  const handleFeatureImageUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploadingImage(true);
    try {
      const { file_url } = await base44.integrations.Core.UploadFile({ file });
      setFeatureImage(file_url);
      toast.success('Image uploaded successfully');
    } catch (error) {
      toast.error('Failed to upload image');
    } finally {
      setUploadingImage(false);
    }
  };

  const handleContentImageUpload = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;

      try {
        const { file_url } = await base44.integrations.Core.UploadFile({ file });
        const quill = quillRef.current?.getEditor();
        if (quill) {
          const range = quill.getSelection(true);
          quill.insertEmbed(range.index, 'image', file_url);
        }
        toast.success('Image inserted');
      } catch (error) {
        toast.error('Failed to upload image');
      }
    };
    input.click();
  };

  // Memoize modules to prevent re-creation on every render
  const quillModules = useMemo(() => ({
    toolbar: {
      container: [
        [{ 'header': [1, 2, 3, false] }],
        ['bold', 'italic', 'underline', 'strike'],
        [{ 'list': 'ordered'}, { 'list': 'bullet' }],
        [{ 'indent': '-1'}, { 'indent': '+1' }],
        ['blockquote', 'code-block'],
        ['link', 'image'],
        ['clean']
      ],
      handlers: {
        image: handleContentImageUpload
      }
    },
  }), []);

  const handleDelete = () => {
    if (window.confirm(`Are you sure you want to delete this ${singularDisplayName.toLowerCase()}? This action cannot be undone.`)) {
      deleteMutation.mutate();
    }
  };

  if (!memberInfo) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8 flex items-center justify-center">
        <div className="animate-pulse text-slate-600">Loading...</div>
      </div>
    );
  }

  // Show loading while fetching article data or member data
  if (isEditing && (articleLoading || memberLoading)) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8 flex items-center justify-center">
        <div className="animate-pulse text-slate-600">Loading...</div>
      </div>
    );
  }
  
  // Also show loading for new articles if member data is still loading
  if (!isEditing && memberLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8 flex items-center justify-center">
        <div className="animate-pulse text-slate-600">Loading...</div>
      </div>
    );
  }

  // Show warning if member doesn't have a handle
  if (!currentMember?.handle) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
        <div className="max-w-4xl mx-auto">
          <Card className="border-amber-200 shadow-sm">
            <CardContent className="p-12 text-center">
              <h2 className="text-2xl font-bold text-slate-900 mb-4">Handle Required</h2>
              <p className="text-slate-600 mb-6">
                You need a unique handle to create or edit {articleDisplayName.toLowerCase()}. This handle will be part of your {singularDisplayName.toLowerCase()} URLs.
              </p>
              <p className="text-sm text-slate-500">
                Please contact an administrator to get a handle assigned to your account.
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  // Construct the full URL preview based on author type
  // New folder-based structure: {baseUrlPath}/{handle}/{slug}
  // IMPORTANT: Derive handle directly from data to avoid stale state issues
  let authorHandleForUrl;
  if (isEditing && article) {
    // For existing articles, derive from article data directly
    if (article.guest_writer_id) {
      // Guest writers use "guest" folder
      authorHandleForUrl = "guest";
    } else if (authorType === "revert_original" && persistedOriginalAuthorMember?.handle) {
      // User explicitly chose to revert to original author
      authorHandleForUrl = persistedOriginalAuthorMember.handle;
    } else if (authorType === "member" && article.author_id !== currentMember?.id) {
      // User explicitly chose to take over - use current member's handle
      authorHandleForUrl = currentMember?.handle || "unknown";
    } else if (article.author_id && article.author_id !== currentMember?.id && currentAuthorMember?.handle) {
      // Article belongs to another member - use their handle from the query
      authorHandleForUrl = currentAuthorMember.handle;
    } else if (article.author_id === currentMember?.id) {
      // Article belongs to logged-in user
      authorHandleForUrl = currentMember?.handle || "unknown";
    } else {
      // Fallback - use current author's handle if available, otherwise current member
      authorHandleForUrl = currentAuthorMember?.handle || currentMember?.handle || "unknown";
    }
  } else {
    // New articles always use current member's handle
    authorHandleForUrl = currentMember?.handle || "unknown";
  }
  const fullUrlPreview = `${baseUrlPath}/${authorHandleForUrl}/${slug}`;
  const selectedGuestWriter = guestWriters.find(w => w.id === selectedGuestWriterId);

  // Check if current user is the author of this article
  const isOwnArticle = isEditing && article?.author_id && memberInfo?.id && 
    String(article.author_id) === String(memberInfo.id);

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
      <div className="max-w-7xl mx-auto">
        {/* Breadcrumb navigation */}
        <Link 
          to={isOwnArticle ? getMyArticlesUrl() : getArticleListUrl()} 
          className="inline-flex items-center gap-2 text-slate-600 hover:text-slate-900 mb-4"
          data-testid="button-back-to-articles"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to {isOwnArticle ? `My ${articleDisplayName}` : articleDisplayName}
        </Link>

        {/* My Article header card - show when editing own article */}
        {isOwnArticle && (
          <div className="mb-4 p-4 bg-blue-50 border border-blue-200 rounded-lg">
            <h2 className="text-lg font-semibold text-blue-900 flex items-center gap-2">
              <User className="w-5 h-5" />
              My {singularDisplayName}
            </h2>
            <p className="text-sm text-blue-700 mt-1">Editing your authored {singularDisplayName.toLowerCase()}</p>
          </div>
        )}

        {/* Header actions */}
        <div className="flex items-center justify-end mb-6">
          <div className="flex items-center gap-3">
            {autoSaving && (
              <span className="text-sm text-slate-500 flex items-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin" />
                Saving...
              </span>
            )}
            {lastSaved && !autoSaving && (
              <span className="text-sm text-slate-500 flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-green-600" />
                Saved {format(lastSaved, 'h:mm a')}
              </span>
            )}
            
            {isEditing && (
              <Button
                variant="outline"
                onClick={handleShare}
                disabled={shareMutation.isPending}
                className="gap-2"
                data-testid="button-share-article"
              >
                <Share2 className="w-4 h-4" />
                Share Draft
              </Button>
            )}
            
            <Button
              onClick={() => saveMutation.mutate(false)}
              disabled={saveMutation.isPending || !title || !slug || !!slugError}
              className="bg-blue-600 hover:bg-blue-700 gap-2"
              data-testid="button-save-article"
            >
              <Save className="w-4 h-4" />
              Save
            </Button>
          </div>
        </div>

        <div className="grid lg:grid-cols-3 gap-8">
          {/* Main Content Area */}
          <div className="lg:col-span-2 space-y-6">
            <Card className="border-slate-200 shadow-sm">
              <CardContent className="pt-6 space-y-6">
                {/* Title */}
                <div className="space-y-2">
                  <Label htmlFor="title" className="text-base font-semibold">{singularDisplayName} Title</Label>
                  <Input
                    id="title"
                    placeholder={`Enter your ${singularDisplayName.toLowerCase()} title...`}
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    className="text-2xl font-bold border-0 px-0 focus-visible:ring-0"
                  />
                  {/* Original Author Display */}
                  {isEditing && persistedOriginalAuthorName && (
                    <p className="text-sm text-slate-500">
                      Original Author: <span className="font-medium text-slate-700">{persistedOriginalAuthorName}</span>
                    </p>
                  )}
                </div>

                {/* Author Type Selector */}
                <div className="space-y-2">
                  <Label className="text-sm">Show author as</Label>
                  <div className="flex flex-wrap gap-4">
                    {/* Current Author option - shown only when article was taken over (author_id differs from original_author_id) */}
                    {isEditing && originalAuthorId && originalAuthorId !== currentMember?.id && originalAuthorId !== persistedOriginalAuthorId && (
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="radio"
                          name="authorType"
                          value="other_member"
                          checked={authorType === "other_member"}
                          onChange={(e) => setAuthorType(e.target.value)}
                          className="w-4 h-4"
                          data-testid="radio-author-current"
                        />
                        <span className="text-sm">Current Author</span>
                      </label>
                    )}
                    {/* Original Author option - always shown when article has an original_author_id */}
                    {isEditing && persistedOriginalAuthorId && (
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="radio"
                          name="authorType"
                          value="revert_original"
                          checked={authorType === "revert_original"}
                          onChange={(e) => setAuthorType(e.target.value)}
                          className="w-4 h-4"
                          data-testid="radio-author-original"
                        />
                        <span className="text-sm text-green-700">
                          Original Author
                        </span>
                      </label>
                    )}
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio"
                        name="authorType"
                        value="member"
                        checked={authorType === "member"}
                        onChange={(e) => setAuthorType(e.target.value)}
                        className="w-4 h-4"
                        data-testid="radio-author-me"
                      />
                      <span className="text-sm">Myself</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio"
                        name="authorType"
                        value="guest"
                        checked={authorType === "guest"}
                        onChange={(e) => setAuthorType(e.target.value)}
                        className="w-4 h-4"
                        data-testid="radio-author-guest"
                      />
                      <span className="text-sm">Guest Writer</span>
                    </label>
                  </div>
                </div>

                {/* Guest Writer Selector */}
                {authorType === "guest" && (
                  <div className="space-y-2">
                    <Label htmlFor="guestWriter">Select Guest Writer</Label>
                    <select
                      id="guestWriter"
                      value={selectedGuestWriterId || ""}
                      onChange={(e) => setSelectedGuestWriterId(e.target.value)}
                      className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      <option value="">Choose a guest writer...</option>
                      {guestWriters.map(writer => (
                        <option key={writer.id} value={writer.id}>
                          {writer.full_name} {writer.organization ? `(${writer.organization})` : ''}
                        </option>
                      ))}
                    </select>
                    {selectedGuestWriter && (
                      <p className="text-xs text-slate-500">
                        {selectedGuestWriter.email} {selectedGuestWriter.job_title && `• ${selectedGuestWriter.job_title}`}
                      </p>
                    )}
                  </div>
                )}

                {/* Slug */}
                <div className="space-y-2">
                  <Label htmlFor="slug" className="text-sm">
                    URL Slug
                    {authorType !== "guest" && (
                      <span className="text-slate-500 font-normal ml-2">
                        (Author: @{authorHandleForUrl})
                      </span>
                    )}
                  </Label>
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-slate-500 whitespace-nowrap">{baseUrlPath}/{authorHandleForUrl}/</span>
                      <Input
                        id="slug"
                        placeholder="url-slug"
                        value={slug}
                        onChange={(e) => setSlug(e.target.value)}
                        className="flex-1"
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <p className="text-xs text-slate-500">
                        Final URL: <span className="font-mono text-blue-600">{fullUrlPreview}</span>
                      </p>
                      {checkingSlug && (
                        <Loader2 className="w-3 h-3 animate-spin text-slate-400" />
                      )}
                    </div>
                    {slugError && (
                      <p className="text-xs text-red-600">{slugError}</p>
                    )}
                  </div>
                </div>

                {/* Summary */}
                <div className="space-y-2">
                  <Label htmlFor="summary">Summary / Excerpt</Label>
                  <Textarea
                    id="summary"
                    placeholder={`Brief description of the ${singularDisplayName.toLowerCase()} (shown in listings)...`}
                    value={summary}
                    onChange={(e) => setSummary(e.target.value)}
                    rows={3}
                  />
                </div>

                {/* Rich Text Editor */}
                <div className="space-y-2">
                  <Label>Content</Label>
                  <div style={{ height: '500px' }}>
                    <ReactQuill
                      ref={quillRef}
                      theme="snow"
                      value={content}
                      onChange={setContent}
                      modules={quillModules}
                      placeholder={`Start writing your ${singularDisplayName.toLowerCase()} content here...`}
                      style={{ height: '450px' }}
                    />
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Sidebar */}
          <div className="lg:col-span-1 space-y-6">
            {/* Feature Image */}
            <Card className="border-slate-200 shadow-sm">
              <CardHeader>
                <CardTitle className="text-base">Feature Image</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {featureImage ? (
                  <div className="relative">
                    <img 
                      src={featureImage} 
                      alt="Feature" 
                      className="w-full h-48 object-cover rounded-lg"
                    />
                    <Button
                      variant="destructive"
                      size="icon"
                      className="absolute top-2 right-2"
                      onClick={() => setFeatureImage("")}
                    >
                      <X className="w-4 h-4" />
                    </Button>
                  </div>
                ) : (
                  <label className="block">
                    <input
                      type="file"
                      accept="image/*"
                      onChange={handleFeatureImageUpload}
                      className="hidden"
                      disabled={uploadingImage}
                    />
                    <div className="border-2 border-dashed border-slate-300 rounded-lg p-8 text-center cursor-pointer hover:border-slate-400 transition-colors">
                      {uploadingImage ? (
                        <Loader2 className="w-8 h-8 text-slate-400 mx-auto mb-2 animate-spin" />
                      ) : (
                        <Upload className="w-8 h-8 text-slate-400 mx-auto mb-2" />
                      )}
                      <p className="text-sm text-slate-600">
                        {uploadingImage ? 'Uploading...' : 'Click to upload'}
                      </p>
                    </div>
                  </label>
                )}
              </CardContent>
            </Card>

            {/* Categories & Tags */}
            <Card className="border-slate-200 shadow-sm">
              <CardHeader>
                <CardTitle className="text-base">Organisation</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <SubcategorySelector 
                  categories={categories}
                  selectedSubcategories={subcategories}
                  onChange={setSubcategories}
                />
                <TagInput tags={tags} onChange={setTags} />
              </CardContent>
            </Card>

            {/* Status & Publishing */}
            <Card className="border-slate-200 shadow-sm">
              <CardHeader>
                <CardTitle className="text-base">Publishing</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <StatusSelector value={status} onChange={setStatus} />
                
                {/* Published Date Picker */}
                <div className="space-y-2">
                  <Label htmlFor="published-date">Published Date & Time</Label>
                  <Input
                    id="published-date"
                    type="datetime-local"
                    value={publishedDate ? new Date(publishedDate).toISOString().slice(0, 16) : ''}
                    onChange={(e) => {
                      const dateValue = e.target.value ? new Date(e.target.value).toISOString() : new Date().toISOString();
                      setPublishedDate(dateValue);
                    }}
                  />
                  <p className="text-xs text-slate-500">
                    Set a future date to schedule the {singularDisplayName.toLowerCase()}. Past dates show when it was originally published.
                  </p>
                  {publishedDate && new Date(publishedDate) > new Date() && (
                    <div className="flex items-center gap-2 p-3 bg-purple-50 rounded-lg border border-purple-200">
                      <Clock className="w-4 h-4 text-purple-600" />
                      <p className="text-sm text-purple-900">
                        Scheduled for {format(new Date(publishedDate), 'MMM d, yyyy h:mm a')}
                      </p>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>

            {/* SEO Settings */}
            <SEOSettings
              seoTitle={seoTitle}
              seoDescription={seoDescription}
              onSeoTitleChange={setSeoTitle}
              onSeoDescriptionChange={setSeoDescription}
            />

            {/* Delete Button - show if user has admin delete permission OR is the author */}
            {isEditing && (
              !isFeatureExcluded('content.articles.delete') || 
              (memberInfo?.id && article?.author_id && String(article.author_id) === String(memberInfo.id))
            ) && (
              <Button
                variant="destructive"
                onClick={handleDelete}
                disabled={deleteMutation.isPending}
                className="w-full gap-2"
                data-testid="button-delete-article"
              >
                <Trash2 className="w-4 h-4" />
                Delete {singularDisplayName}
              </Button>
            )}
          </div>
        </div>
      </div>

      <Dialog open={showShareDialog} onOpenChange={setShowShareDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Share Draft {singularDisplayName}</DialogTitle>
            <DialogDescription>
              Share this draft with others using the link and password below.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label className="text-sm font-medium">Preview Link</Label>
              <div className="flex items-center gap-2">
                <Input
                  readOnly
                  value={getShareUrl()}
                  className="flex-1 text-sm bg-slate-50"
                  data-testid="input-share-link"
                />
                <Button
                  size="icon"
                  variant="outline"
                  onClick={() => copyToClipboard(getShareUrl(), 'link')}
                  data-testid="button-copy-link"
                >
                  {copiedLink ? <Check className="w-4 h-4 text-green-600" /> : <Copy className="w-4 h-4" />}
                </Button>
              </div>
            </div>
            
            <div className="space-y-2">
              <Label className="text-sm font-medium">Access Password</Label>
              <div className="flex items-center gap-2">
                <Input
                  readOnly
                  value={sharePassword}
                  className="flex-1 text-lg font-mono tracking-widest text-center bg-slate-50"
                  data-testid="input-share-password"
                />
                <Button
                  size="icon"
                  variant="outline"
                  onClick={() => copyToClipboard(sharePassword, 'password')}
                  data-testid="button-copy-password"
                >
                  {copiedPassword ? <Check className="w-4 h-4 text-green-600" /> : <Copy className="w-4 h-4" />}
                </Button>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={regeneratePassword}
                disabled={shareMutation.isPending}
                className="text-xs text-slate-500 hover:text-slate-700"
                data-testid="button-regenerate-password"
              >
                Generate new password
              </Button>
            </div>

            <div className="p-3 bg-amber-50 rounded-lg border border-amber-200">
              <p className="text-sm text-amber-800">
                Anyone with this link and password can view the draft {singularDisplayName.toLowerCase()}.
              </p>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}