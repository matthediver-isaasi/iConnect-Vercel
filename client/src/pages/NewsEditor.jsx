import React, { useState, useEffect, useRef, useMemo } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { ArrowLeft, Save, Trash2, Upload, X, Loader2, CheckCircle2, Clock } from "lucide-react";
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

  // Fetch categories
  const { data: categories = [] } = useQuery({
    queryKey: ['resourceCategories'],
    queryFn: async () => {
      const cats = await base44.entities.ResourceCategory.list();
      return cats
        .filter(c => c.is_active && c.applies_to_content_types?.includes("News"))
        .sort((a, b) => (a.display_order || 0) - (b.display_order || 0));
    }
  });

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
    if (window.confirm('Are you sure you want to delete this news article? This action cannot be undone.')) {
      deleteMutation.mutate();
    }
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
                    className="text-2xl font-bold border-0 px-0 focus-visible:ring-0"
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

            <SEOSettings
              seoTitle={seoTitle}
              seoDescription={seoDescription}
              onSeoTitleChange={setSeoTitle}
              onSeoDescriptionChange={setSeoDescription}
            />

            {isEditing && (
              <Button
                variant="destructive"
                onClick={handleDelete}
                disabled={deleteMutation.isPending}
                className="w-full gap-2"
              >
                <Trash2 className="w-4 h-4" />
                Delete News
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}