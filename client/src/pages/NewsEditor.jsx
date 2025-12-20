import React, { useState, useEffect, useRef, useMemo } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { ArrowLeft, Save, Trash2, Upload, X, Loader2, CheckCircle2, Clock, Share2, Copy, Check } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { createPageUrl } from "@/utils";
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

export default function NewsEditorPage() {
  const { memberInfo, isFeatureExcluded, isAccessReady } = useMemberAccess();
  const urlParams = new URLSearchParams(window.location.search);
  const newsId = urlParams.get('id');
  const isEditing = !!newsId;
  
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
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showShareDialog, setShowShareDialog] = useState(false);
  const [sharePassword, setSharePassword] = useState("");
  const [copiedLink, setCopiedLink] = useState(false);
  const [copiedPassword, setCopiedPassword] = useState(false);

  // Fetch current member by ID (efficient single record fetch)
  const { data: currentMember, isLoading: memberLoading } = useQuery({
    queryKey: ['current-member', memberInfo?.id],
    queryFn: async () => {
      if (memberInfo?.id) {
        return await base44.entities.Member.get(memberInfo.id);
      }
      // Fallback to filter by email if no ID
      const members = await base44.entities.Member.filter({ email: memberInfo.email });
      return members[0] || null;
    },
    enabled: !!memberInfo?.id || !!memberInfo?.email
  });

  // Fetch categories for News content type
  const { data: categories = [], isLoading: categoriesLoading } = useQuery({
    queryKey: ['resourceCategories', 'News'],
    queryFn: async () => {
      const cats = await base44.entities.ResourceCategory.list();
      return cats
        .filter(c => c.is_active && c.applies_to_content_types?.includes("News"))
        .sort((a, b) => (a.display_order || 0) - (b.display_order || 0));
    }
  });
  
  // Check if we have any categories with subcategories
  const hasCategories = categories.length > 0 && categories.some(c => c.subcategories?.length > 0);

  // Fetch existing news if editing
  const { data: news, isLoading: newsLoading } = useQuery({
    queryKey: ['news', newsId],
    queryFn: async () => {
      const allNews = await base44.entities.NewsPost.list();
      return allNews.find(n => n.id === newsId);
    },
    enabled: isEditing,
  });

  // Load news data into form
  useEffect(() => {
    if (news) {
      setTitle(news.title || "");
      setSlug(news.slug || "");
      setSummary(news.summary || "");
      setContent(news.content || "");
      setFeatureImage(news.feature_image_url || "");
      setSubcategories(news.subcategories || []);
      setTags(news.tags || []);
      setStatus(news.status || "draft");
      setPublishedDate(news.published_date || new Date().toISOString());
      setSeoTitle(news.seo_title || "");
      setSeoDescription(news.seo_description || "");
      setSharePassword(news.share_password || "");
    }
  }, [news]);

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

  // Auto-save functionality
  useEffect(() => {
    if (!memberInfo || !title || !currentMember) return;

    const autoSaveTimer = setTimeout(async () => {
      if (isEditing) {
        setAutoSaving(true);
        try {
          await base44.entities.NewsPost.update(newsId, {
            title,
            slug,
            summary,
            content,
            feature_image_url: featureImage,
            subcategories,
            tags,
            status,
            published_date: publishedDate,
            seo_title: seoTitle,
            seo_description: seoDescription,
          });
          setLastSaved(new Date());
        } catch (error) {
          console.error('Auto-save failed:', error);
        } finally {
          setAutoSaving(false);
        }
      }
    }, 3000);

    return () => clearTimeout(autoSaveTimer);
  }, [title, slug, summary, content, featureImage, subcategories, tags, status, publishedDate, seoTitle, seoDescription, isEditing, newsId, memberInfo, currentMember]);

  const saveMutation = useMutation({
    mutationFn: async ({ publishNow }) => {
      if (!memberInfo || !currentMember) {
        throw new Error('Member information not available');
      }

      const newsData = {
        title,
        slug,
        author_id: currentMember.id,
        author_name: `${memberInfo.first_name} ${memberInfo.last_name}`,
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

      if (isEditing) {
        return await base44.entities.NewsPost.update(newsId, newsData);
      } else {
        return await base44.entities.NewsPost.create(newsData);
      }
    },
    onSuccess: (data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['news'] });
      toast.success(variables.publishNow ? 'News published successfully!' : 'News saved successfully!');
      setLastSaved(new Date());
      
      if (!isEditing) {
        window.location.href = createPageUrl('News');
      }
    },
    onError: (error) => {
      toast.error(error.message || 'Failed to save news');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => base44.entities.NewsPost.delete(newsId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['news'] });
      toast.success('News deleted successfully');
      window.location.href = createPageUrl('News');
    },
    onError: () => {
      toast.error('Failed to delete news');
    },
  });

  // Generate a random 4-digit password
  const generateSharePassword = () => {
    return Math.floor(1000 + Math.random() * 9000).toString();
  };

  // Share mutation to save password
  const shareMutation = useMutation({
    mutationFn: async (password) => {
      return await base44.entities.NewsPost.update(newsId, { share_password: password });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['news'] });
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
    return `${baseUrl}/news-preview/${newsId}`;
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
    setShowDeleteConfirm(true);
  };

  const confirmDelete = () => {
    deleteMutation.mutate();
    setShowDeleteConfirm(false);
  };

  if (isFeatureExcluded('content.news-editor')) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8 flex items-center justify-center">
        <Card className="border-red-200">
          <CardContent className="p-8 text-center">
            <p className="text-red-600">Administrator access required</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!memberInfo) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8 flex items-center justify-center">
        <div className="animate-pulse text-slate-600">Loading...</div>
      </div>
    );
  }

  if (isEditing && (newsLoading || memberLoading)) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8 flex items-center justify-center">
        <div className="animate-pulse text-slate-600">Loading news...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
      <div className="max-w-7xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <Link to={createPageUrl('News')} className="inline-flex items-center gap-2 text-slate-600 hover:text-slate-900">
            <ArrowLeft className="w-4 h-4" />
            Back to News
          </Link>
          
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
                data-testid="button-share-news"
              >
                <Share2 className="w-4 h-4" />
                Share Draft
              </Button>
            )}
            
            <Button
              variant="outline"
              onClick={() => saveMutation.mutate({ publishNow: false })}
              disabled={saveMutation.isPending || !title}
              className="gap-2"
            >
              <Save className="w-4 h-4" />
              Save Draft
            </Button>
            
            <Button
              onClick={() => saveMutation.mutate({ publishNow: true })}
              disabled={saveMutation.isPending || !title || !slug}
              className="bg-blue-600 hover:bg-blue-700 gap-2"
            >
              {status === 'published' ? 'Update' : 'Publish'}
            </Button>
          </div>
        </div>

        <div className="grid lg:grid-cols-3 gap-8">
          <div className="lg:col-span-2 space-y-6">
            <Card className="border-slate-200 shadow-sm">
              <CardContent className="pt-6 space-y-6">
                <div className="space-y-2">
                  <Label htmlFor="title" className="text-base font-semibold">News Title</Label>
                  <Input
                    id="title"
                    placeholder="Enter news title..."
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    className="text-xl font-semibold"
                    data-testid="input-news-title"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="slug" className="text-sm">URL Slug</Label>
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-slate-500">/news/</span>
                    <Input
                      id="slug"
                      placeholder="news-url-slug"
                      value={slug}
                      onChange={(e) => setSlug(e.target.value)}
                      className="flex-1"
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="summary">Summary / Excerpt</Label>
                  <Textarea
                    id="summary"
                    placeholder="Brief description (shown in listings)..."
                    value={summary}
                    onChange={(e) => setSummary(e.target.value)}
                    rows={3}
                  />
                </div>

                <div className="space-y-2">
                  <Label>Content</Label>
                  <div style={{ height: '500px' }}>
                    <ReactQuill
                      ref={quillRef}
                      theme="snow"
                      value={content}
                      onChange={setContent}
                      modules={quillModules}
                      placeholder="Start writing your news content here..."
                      style={{ height: '450px' }}
                    />
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          <div className="lg:col-span-1 space-y-6">
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

            {/* Only show Organisation card if there are categories or tags functionality is needed */}
            {(categoriesLoading || hasCategories) && (
              <Card className="border-slate-200 shadow-sm">
                <CardHeader>
                  <CardTitle className="text-base">Organisation</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <SubcategorySelector 
                    categories={categories}
                    selectedSubcategories={subcategories}
                    onChange={setSubcategories}
                    isLoading={categoriesLoading}
                  />
                  <TagInput tags={tags} onChange={setTags} />
                </CardContent>
              </Card>
            )}

            <Card className="border-slate-200 shadow-sm">
              <CardHeader>
                <CardTitle className="text-base">Publishing</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <StatusSelector value={status} onChange={setStatus} />
                
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

            {!isFeatureExcluded('content.news-editor.seo-settings') && (
              <SEOSettings
                seoTitle={seoTitle}
                seoDescription={seoDescription}
                onSeoTitleChange={setSeoTitle}
                onSeoDescriptionChange={setSeoDescription}
              />
            )}

            {isEditing && (
              <Button
                variant="destructive"
                onClick={handleDelete}
                disabled={deleteMutation.isPending}
                className="w-full gap-2"
                data-testid="button-delete-news"
              >
                <Trash2 className="w-4 h-4" />
                Delete News
              </Button>
            )}
          </div>
        </div>
      </div>

      <AlertDialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete News Article</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete this news article? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              className="bg-red-600 hover:bg-red-700"
              data-testid="button-confirm-delete"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={showShareDialog} onOpenChange={setShowShareDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Share Draft Article</DialogTitle>
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
                Anyone with this link and password can view the draft article.
              </p>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}