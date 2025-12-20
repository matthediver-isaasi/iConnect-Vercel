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
  showImage = true,
  authorHandles = {}, // Map of author_id to handle
  authorNames = {} // Map of author_id (or guest_gwId) to full name
}) {
  const { getArticleViewUrl } = useArticleUrl();
  
  // Use String() for type-safe comparison
  const isAuthor = currentMemberId && String(article.author_id) === String(currentMemberId);
  const isDraft = article.status === 'draft';
  
  // Determine author handle for URL construction
  let authorHandle = "guest"; // Default for guest writers
  if (article.author_id) {
    // Use String() for consistent type matching with authorHandles map keys
    const authorIdStr = String(article.author_id);
    // Try to get handle from props, or extract from legacy slug
    const foundHandle = authorHandles[authorIdStr];
    console.log('[ArticleCard] Looking up handle for author_id:', authorIdStr, 
      'authorHandles keys:', Object.keys(authorHandles).slice(0, 5), 
      'found:', foundHandle,
      'total keys:', Object.keys(authorHandles).length);
    if (foundHandle) {
      authorHandle = foundHandle;
    } else {
      // Fallback: extract from legacy slug format "-by-{handle}"
      const byHandleMatch = (article.slug || "").match(/-by-([a-z0-9-]+)$/i);
      if (byHandleMatch) {
        authorHandle = byHandleMatch[1];
        console.log('[ArticleCard] Using legacy slug fallback:', authorHandle);
      } else {
        console.log('[ArticleCard] No handle found, using guest default');
      }
    }
  }
  
  // Get clean slug without handle suffix
  let cleanSlug = article.slug || "";
  const byHandleMatch = cleanSlug.match(/-by-([a-z0-9-]+)$/i);
  if (byHandleMatch) {
    cleanSlug = cleanSlug.slice(0, -byHandleMatch[0].length);
  }
  
  // For drafts, add preview=true to the URL so the author can view them
  const baseArticleUrl = getArticleViewUrl(authorHandle, cleanSlug);
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
        
        {showActions && (() => {
          // Look up author name from props, falling back to article.author_name for backwards compatibility
          let displayAuthorName = null;
          if (article.author_id) {
            displayAuthorName = authorNames[String(article.author_id)];
          } else if (article.guest_writer_id) {
            displayAuthorName = authorNames[`guest_${article.guest_writer_id}`];
          }
          // Fallback to legacy author_name field
          if (!displayAuthorName) displayAuthorName = article.author_name;
          
          return displayAuthorName ? (
            <div className="flex items-center gap-1.5 text-xs text-slate-600 pb-3">
              <User className="w-3 h-3" />
              <span>by {displayAuthorName}</span>
            </div>
          ) : null;
        })()}
        
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
