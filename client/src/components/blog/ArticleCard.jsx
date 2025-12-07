import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Calendar, User, ArrowUpRight, Pencil, Trash2 } from "lucide-react";
import { format } from "date-fns";
import { useArticleUrl } from "@/contexts/ArticleUrlContext";
import { Link } from "react-router-dom";

export default function ArticleCard({ 
  article, 
  viewPageUrl = 'ArticleView', 
  showActions = true, 
  displayName = 'Articles',
  onEdit,
  onDelete,
  hasAdminEditPermission = false,
  hasAdminDeletePermission = false,
  currentMemberId = null,
  showImage = true
}) {
  const { getArticleViewUrl } = useArticleUrl();
  
  // Use String() for type-safe comparison
  const isAuthor = currentMemberId && String(article.author_id) === String(currentMemberId);
  const isDraft = article.status === 'draft';
  
  // For drafts, add preview=true to the URL so the author can view them
  const baseArticleUrl = getArticleViewUrl(article.slug);
  const articleUrl = isDraft ? `${baseArticleUrl}${baseArticleUrl.includes('?') ? '&' : '?'}preview=true` : baseArticleUrl;
  
  const canEdit = hasAdminEditPermission || isAuthor;
  const canDelete = hasAdminDeletePermission || isAuthor;

  const ActionButtons = () => {
    if (!canEdit && !canDelete) return null;
    
    return (
      <div className="flex gap-1">
        {canEdit && (
          <Button
            size="icon"
            variant="ghost"
            className="h-8 w-8 hover:bg-slate-100"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onEdit?.(article);
            }}
            data-testid={`button-edit-article-${article.id}`}
          >
            <Pencil className="h-4 w-4" />
          </Button>
        )}
        {canDelete && (
          <Button
            size="icon"
            variant="ghost"
            className="h-8 w-8 hover:bg-red-100 text-red-600"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onDelete?.(article);
            }}
            data-testid={`button-delete-article-${article.id}`}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        )}
      </div>
    );
  };

  return (
    <Card 
      className="border-slate-200 hover:shadow-lg transition-shadow duration-300 overflow-hidden h-full flex flex-col relative"
      data-testid={`card-article-${article.id}`}
    >
      {showImage && article.feature_image_url && (
        <>
          <div className="h-48 overflow-hidden bg-slate-100">
            <img 
              src={article.feature_image_url} 
              alt={article.title}
              className="w-full h-full object-cover hover:scale-105 transition-transform duration-300"
            />
          </div>
          <div className="w-full h-[3px]" style={{ backgroundColor: '#5d0d77' }}></div>
        </>
      )}
      
      <CardHeader className="pb-3 flex-grow">
        <CardTitle className="text-lg line-clamp-2">{article.title}</CardTitle>
        
        {article.published_date && (
          <div className="flex items-center gap-1 text-xs text-slate-500 py-2">
            <Calendar className="w-3 h-3" />
            <span>{format(new Date(article.published_date), 'MMM d, yyyy')}</span>
          </div>
        )}
        
        {showActions && article.author_name && (
          <div className="flex items-center gap-1.5 text-xs text-slate-600 pb-3">
            <User className="w-3 h-3" />
            <span>by {article.author_name}</span>
          </div>
        )}
        
        {article.summary && (
          <p className="text-sm text-slate-600 line-clamp-3">
            {article.summary}
          </p>
        )}

        {article.subcategories && article.subcategories.length > 0 && (
          <div className="flex flex-wrap gap-1 pt-4">
            {article.subcategories.slice(0, 3).map((sub, index) => (
              <Badge key={index} variant="secondary" className="text-xs">
                {sub}
              </Badge>
            ))}
            {article.subcategories.length > 3 && (
              <Badge variant="secondary" className="text-xs">
                +{article.subcategories.length - 3}
              </Badge>
            )}
          </div>
        )}
      </CardHeader>

      <div className="mt-auto flex items-end justify-end">
        <div className="mr-auto flex items-center gap-2">
          <ActionButtons />
          {isDraft && (
            <Badge variant="secondary" className="bg-amber-100 text-amber-800 border-amber-300">
              Draft
            </Badge>
          )}
        </div>
        <Link 
          to={articleUrl}
          className="inline-flex items-center justify-center w-12 h-12 bg-black hover:bg-gray-800 transition-colors duration-200"
          data-testid={`button-read-article-${article.id}`}
        >
          <ArrowUpRight className="w-6 h-6 text-white" strokeWidth={2} />
        </Link>
      </div>
    </Card>
  );
}
