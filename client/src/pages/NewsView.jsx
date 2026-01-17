import React, { useEffect } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Calendar, Edit, Tag, Linkedin, Mail } from "lucide-react";
import { format } from "date-fns";
import { createPageUrl } from "@/utils";
import { Link } from "react-router-dom";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { useTenantBranding } from "@/contexts/TenantBrandingContext";
import { useNewsPostBySlug } from "@/hooks/useNewsPostData";

export default function NewsViewPage() {
  const { memberInfo, isAdmin } = useMemberAccess();
  const { branding } = useTenantBranding();
  const urlParams = new URLSearchParams(window.location.search);
  const slug = urlParams.get('slug');

  const { data: news, isLoading } = useNewsPostBySlug(slug);

  useEffect(() => {
    if (news) {
      document.title = news.seo_title || news.title || 'News';
      
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

  const handleLinkedInShare = () => {
    const newsUrl = encodeURIComponent(window.location.href);
    const linkedInUrl = `https://www.linkedin.com/sharing/share-offsite/?url=${newsUrl}`;
    window.open(linkedInUrl, '_blank', 'width=600,height=600');
  };

  const handleEmailShare = () => {
    const subject = encodeURIComponent(news?.title || 'Check out this news');
    const body = encodeURIComponent(
      `I thought you might find this news article interesting:\n\n${news?.title || ''}\n\n${news?.summary || ''}\n\n${window.location.href}`
    );
    window.location.href = `mailto:?subject=${subject}&body=${body}`;
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8 flex items-center justify-center">
        <div className="animate-pulse text-slate-600">Loading news...</div>
      </div>
    );
  }

  if (!news) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
        <div className="max-w-4xl mx-auto text-center py-16">
          <h2 className="text-2xl font-bold text-slate-900 mb-4">News not found</h2>
          <Link to={createPageUrl('News')}>
            <Button>Back to News</Button>
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <Link 
            to={createPageUrl('News')} 
            className="inline-flex items-center gap-2 text-slate-600 hover:text-slate-900"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to News
          </Link>
          
          {isAdmin && (
            <Link to={`${createPageUrl('NewsEditor')}?id=${news.id}`}>
              <Button variant="outline" className="gap-2">
                <Edit className="w-4 h-4" />
                Edit
              </Button>
            </Link>
          )}
        </div>

        <Card className="border-slate-200 shadow-lg mb-8">
          {news.feature_image_url && (
            <div className="h-96 overflow-hidden rounded-t-lg">
              <img 
                src={news.feature_image_url} 
                alt={news.title}
                className="w-full h-full object-cover"
              />
            </div>
          )}
          
          <CardContent className="pt-8 pb-12 px-8 md:px-12">
            <h1 className="text-4xl md:text-5xl font-bold text-slate-900 mb-4">
              {news.title}
            </h1>

            <div className="flex flex-wrap items-center gap-4 text-sm text-slate-600 mb-6">
              {news.subcategories && news.subcategories.length > 0 && (
                <>
                  {news.subcategories.slice(0, 3).map((subcat, idx) => (
                    <Badge key={idx} variant="secondary" className="bg-blue-100 text-blue-700">
                      {subcat}
                    </Badge>
                  ))}
                  {news.subcategories.length > 3 && (
                    <Badge variant="secondary" className="bg-slate-100 text-slate-700">
                      +{news.subcategories.length - 3} more
                    </Badge>
                  )}
                </>
              )}
              {news.published_date && (
                <div className="flex items-center gap-2">
                  <Calendar className="w-4 h-4" />
                  <span>{format(new Date(news.published_date), 'MMMM d, yyyy')}</span>
                </div>
              )}
            </div>

            {news.summary && (
              <p className="text-xl text-slate-600 mb-8 leading-relaxed">
                {news.summary}
              </p>
            )}

            <div 
              className="prose prose-lg prose-slate max-w-none"
              dangerouslySetInnerHTML={{ __html: news.content }}
            />

            {news.tags && news.tags.length > 0 && (
              <div className="mt-12 pt-8 border-t border-slate-200">
                <div className="flex items-center gap-2 flex-wrap">
                  <Tag className="w-4 h-4 text-slate-400" />
                  {news.tags.map(tag => (
                    <Badge key={tag} variant="outline" className="text-sm">
                      {tag}
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            <div className="mt-12 pt-8 border-t border-slate-200">
              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                <p className="text-sm text-slate-600">Share this news:</p>
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
          </CardContent>
        </Card>
      </div>
    </div>
  );
}