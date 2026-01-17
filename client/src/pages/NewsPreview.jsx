import { useState, useEffect } from "react";
import { useParams } from "react-router-dom";
import { base44 } from "@/api/base44Client";
import { useQuery } from "@tanstack/react-query";
import { useTenantBranding } from "@/contexts/TenantBrandingContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Calendar, User, Lock, AlertCircle, Eye } from "lucide-react";
import { format } from "date-fns";
import DOMPurify from "dompurify";

export default function NewsPreview() {
  const { id } = useParams();
  const { branding } = useTenantBranding();
  const [enteredPassword, setEnteredPassword] = useState("");
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [authError, setAuthError] = useState("");

  const { data: news, isLoading, error } = useQuery({
    queryKey: ['news-preview', id],
    queryFn: async () => {
      const allNews = await base44.entities.NewsPost.list();
      return allNews.find(n => n.id === id);
    },
    enabled: !!id,
  });

  useEffect(() => {
    if (news) {
      document.title = news.seo_title || news.title || 'News Preview';
      
      let metaDescription = document.querySelector('meta[name="description"]');
      if (!metaDescription) {
        metaDescription = document.createElement('meta');
        metaDescription.name = 'description';
        document.head.appendChild(metaDescription);
      }
      metaDescription.content = news.seo_description || news.summary || '';

      let ogTitle = document.querySelector('meta[property="og:title"]');
      if (!ogTitle) {
        ogTitle = document.createElement('meta');
        ogTitle.setAttribute('property', 'og:title');
        document.head.appendChild(ogTitle);
      }
      ogTitle.content = news.seo_title || news.title || '';

      let ogDescription = document.querySelector('meta[property="og:description"]');
      if (!ogDescription) {
        ogDescription = document.createElement('meta');
        ogDescription.setAttribute('property', 'og:description');
        document.head.appendChild(ogDescription);
      }
      ogDescription.content = news.seo_description || news.summary || '';

      if (news.feature_image_url) {
        let ogImage = document.querySelector('meta[property="og:image"]');
        if (!ogImage) {
          ogImage = document.createElement('meta');
          ogImage.setAttribute('property', 'og:image');
          document.head.appendChild(ogImage);
        }
        ogImage.content = news.feature_image_url;
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
      document.title = branding?.name || 'Portal';
    };
  }, [news, branding?.name]);

  const handlePasswordSubmit = (e) => {
    e.preventDefault();
    
    if (!news) {
      setAuthError("Article not found");
      return;
    }

    if (!news.share_password) {
      setAuthError("This article is not available for preview");
      return;
    }

    if (enteredPassword === news.share_password) {
      setIsAuthenticated(true);
      setAuthError("");
    } else {
      setAuthError("Incorrect password");
      setEnteredPassword("");
    }
  };

  if (isLoading) {
    return (
      <div className="bg-gradient-to-br from-slate-50 to-blue-50 flex items-start justify-center pt-12 px-4 pb-12">
        <div className="max-w-md w-full">
          <div className="animate-pulse text-slate-600 text-center">Loading...</div>
        </div>
      </div>
    );
  }

  if (error || !news) {
    return (
      <div className="bg-gradient-to-br from-slate-50 to-blue-50 flex items-start justify-center pt-12 px-4 pb-12">
        <Card className="max-w-md w-full border-red-200">
          <CardContent className="p-8 text-center">
            <AlertCircle className="w-12 h-12 text-red-500 mx-auto mb-4" />
            <h2 className="text-xl font-semibold text-slate-900 mb-2">Article Not Found</h2>
            <p className="text-slate-600">The article you're looking for doesn't exist or has been removed.</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="bg-gradient-to-br from-slate-50 to-blue-50 flex items-start justify-center pt-12 px-4 pb-12">
        <Card className="max-w-md w-full">
          <CardHeader className="text-center">
            <div className="w-16 h-16 bg-slate-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <Lock className="w-8 h-8 text-slate-600" />
            </div>
            <CardTitle className="text-xl">Password Required</CardTitle>
            <p className="text-slate-600 text-sm mt-2">
              This is a draft article. Enter the password to view it.
            </p>
          </CardHeader>
          <CardContent>
            <form onSubmit={handlePasswordSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="password">Access Password</Label>
                <Input
                  id="password"
                  type="text"
                  placeholder="Enter 4-digit password"
                  value={enteredPassword}
                  onChange={(e) => setEnteredPassword(e.target.value)}
                  className="text-center text-lg font-mono tracking-widest"
                  maxLength={4}
                  autoFocus
                  data-testid="input-preview-password"
                />
              </div>
              
              {authError && (
                <div className="p-3 bg-red-50 rounded-lg border border-red-200">
                  <p className="text-sm text-red-600 text-center">{authError}</p>
                </div>
              )}
              
              <Button 
                type="submit" 
                className="w-full gap-2"
                disabled={enteredPassword.length !== 4}
                data-testid="button-submit-password"
              >
                <Eye className="w-4 h-4" />
                View Article
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
      <div className="max-w-4xl mx-auto">
        <div className="mb-6">
          <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200">
            Draft Preview
          </Badge>
        </div>

        <article className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
          {news.feature_image_url && (
            <div className="w-full h-64 md:h-96 overflow-hidden">
              <img
                src={news.feature_image_url}
                alt={news.title}
                className="w-full h-full object-cover"
              />
            </div>
          )}
          
          <div className="p-6 md:p-10">
            <h1 className="text-3xl md:text-4xl font-bold text-slate-900 mb-4">
              {news.title}
            </h1>
            
            <div className="flex flex-wrap items-center gap-4 text-sm text-slate-600 mb-6 pb-6 border-b border-slate-200">
              {news.author_name && (
                <div className="flex items-center gap-2">
                  <User className="w-4 h-4" />
                  <span>{news.author_name}</span>
                </div>
              )}
              {news.published_date && (
                <div className="flex items-center gap-2">
                  <Calendar className="w-4 h-4" />
                  <span>{format(new Date(news.published_date), 'MMMM d, yyyy')}</span>
                </div>
              )}
            </div>

            {news.summary && (
              <p className="text-lg text-slate-700 mb-8 font-medium leading-relaxed">
                {news.summary}
              </p>
            )}
            
            <div 
              className="prose prose-slate max-w-none"
              dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(news.content || '') }}
            />

            {news.subcategories && news.subcategories.length > 0 && (
              <div className="mt-8 pt-6 border-t border-slate-200">
                <div className="flex flex-wrap gap-2">
                  {news.subcategories.map((sub, idx) => (
                    <Badge key={idx} variant="secondary">
                      {sub}
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            {news.tags && news.tags.length > 0 && (
              <div className="mt-4">
                <div className="flex flex-wrap gap-2">
                  {news.tags.map((tag, idx) => (
                    <span key={idx} className="text-sm text-slate-500">
                      #{tag}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </article>

        <div className="mt-6 p-4 bg-amber-50 rounded-lg border border-amber-200 text-center">
          <p className="text-sm text-amber-800">
            This is a draft preview. The article is not publicly published yet.
          </p>
        </div>
      </div>
    </div>
  );
}
