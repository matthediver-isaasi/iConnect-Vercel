import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useParams, useSearchParams } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, Lock, Download, ExternalLink, PlayCircle, Calendar, User, Share2, Mail, Copy, Check } from "lucide-react";
import { toast, Toaster } from "sonner";
import { format } from "date-fns";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export default function EmbedResourcePage() {
  const { identifier } = useParams();
  const [searchParams] = useSearchParams();
  const [copied, setCopied] = useState(false);
  
  const tenantParam = searchParams.get('tenant');

  const { data: resource, isLoading, error } = useQuery({
    queryKey: ['embed-resource', identifier, tenantParam],
    queryFn: async () => {
      const url = tenantParam 
        ? `/api/public/resource/${identifier}?tenant=${encodeURIComponent(tenantParam)}`
        : `/api/public/resource/${identifier}`;
      const response = await fetch(url);
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to load resource');
      }
      return response.json();
    },
    enabled: !!identifier
  });

  const notifyParentResize = () => {
    setTimeout(() => {
      const height = document.documentElement.scrollHeight;
      window.parent.postMessage({ type: 'iconn-resource-resize', height }, '*');
    }, 100);
  };

  useEffect(() => {
    notifyParentResize();
  }, [resource]);

  useEffect(() => {
    const resizeObserver = new ResizeObserver(() => {
      notifyParentResize();
    });
    resizeObserver.observe(document.body);
    return () => resizeObserver.disconnect();
  }, []);

  const getResourceIcon = (type) => {
    switch (type) {
      case 'download':
        return <Download className="w-4 h-4" />;
      case 'video':
        return <PlayCircle className="w-4 h-4" />;
      case 'external_link':
        return <ExternalLink className="w-4 h-4" />;
      default:
        return <ExternalLink className="w-4 h-4" />;
    }
  };

  const getResourceLabel = (type) => {
    switch (type) {
      case 'download':
        return 'Download';
      case 'video':
        return 'Watch Video';
      case 'external_link':
        return 'Visit Site';
      default:
        return 'View Resource';
    }
  };

  const handleResourceClick = () => {
    if (resource?.target_url) {
      window.open(resource.target_url, '_blank', 'noopener,noreferrer');
    }
  };

  const handleLockedClick = () => {
    if (resource?.login_redirect_url) {
      window.top.location.href = resource.login_redirect_url;
    }
  };

  const handleShare = async (platform) => {
    const url = encodeURIComponent(resource.target_url || window.location.href);
    const title = encodeURIComponent(resource.title);
    const description = encodeURIComponent(resource.description || '');

    switch (platform) {
      case 'x':
        window.open(`https://twitter.com/intent/tweet?text=${title}&url=${url}`, '_blank', 'noopener,noreferrer');
        break;
      case 'linkedin':
        window.open(`https://www.linkedin.com/sharing/share-offsite/?url=${url}`, '_blank', 'noopener,noreferrer');
        break;
      case 'email':
        window.location.href = `mailto:?subject=${title}&body=${description}%0A%0A${url}`;
        break;
      case 'copy':
        try {
          await navigator.clipboard.writeText(resource.target_url || window.location.href);
          setCopied(true);
          toast.success('Link copied to clipboard');
          setTimeout(() => setCopied(false), 2000);
        } catch (err) {
          toast.error('Failed to copy link');
        }
        break;
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[200px] p-4" data-testid="embed-resource-loading">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error || !resource) {
    return (
      <div className="flex items-center justify-center min-h-[200px] p-4" data-testid="embed-resource-error">
        <Card className="w-full max-w-md">
          <CardContent className="pt-6">
            <p className="text-center text-muted-foreground">
              {error?.message || 'Resource not found or no longer available'}
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-4" data-testid="embed-resource-container">
      <Toaster />
      <Card className="w-full overflow-hidden" data-testid={`embed-resource-${resource.id}`}>
        {resource.image_url && (
          <>
            <div className="h-48 overflow-hidden bg-slate-100 relative">
              <img 
                src={resource.image_url} 
                alt={resource.title}
                className="w-full h-full object-cover"
                data-testid="resource-image"
              />
            </div>
            <div className="w-full h-[3px] bg-purple-800"></div>
          </>
        )}
        
        <CardHeader className="pb-3">
          <CardTitle className="text-lg line-clamp-2" data-testid="resource-title">
            {resource.title}
          </CardTitle>
          
          {resource.release_date && (
            <div className="flex items-center gap-1 text-xs text-slate-500 py-2">
              <Calendar className="w-3 h-3" />
              <span data-testid="resource-date">
                {format(new Date(resource.release_date), 'dd MMM yyyy')}
              </span>
            </div>
          )}
          
          {resource.author_name && (
            <div className="flex items-center gap-1.5 text-xs text-slate-600 mt-1">
              <User className="w-3 h-3" />
              <span data-testid="resource-author">by {resource.author_name}</span>
            </div>
          )}
          
          {resource.description && (
            <p className="text-sm text-slate-600 mt-2" data-testid="resource-description">
              {resource.description}
            </p>
          )}

          {resource.tags && resource.tags.length > 0 && (
            <div className="flex flex-wrap gap-1 pt-3">
              {resource.tags.map((tag, index) => (
                <Badge 
                  key={index}
                  variant="secondary"
                  className="text-xs"
                  data-testid={`resource-tag-${index}`}
                >
                  {tag}
                </Badge>
              ))}
            </div>
          )}
        </CardHeader>

        <CardContent className="pt-0 pb-4">
          {resource.is_locked ? (
            <Button 
              onClick={handleLockedClick}
              className="w-full bg-slate-600 hover:bg-slate-700"
              data-testid="button-login-required"
            >
              <Lock className="w-4 h-4 mr-2" />
              Member login required
            </Button>
          ) : (
            <div className="flex gap-2">
              <Button 
                onClick={handleResourceClick}
                className="flex-1 bg-blue-600 hover:bg-blue-700"
                data-testid="button-resource-cta"
              >
                {getResourceIcon(resource.resource_type)}
                <span className="ml-2">{getResourceLabel(resource.resource_type)}</span>
              </Button>
              
              {resource.is_public && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="icon" data-testid="button-share">
                      <Share2 className="w-4 h-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => handleShare('x')} className="cursor-pointer">
                      <svg className="w-4 h-4 mr-2" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
                      </svg>
                      Share on X
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => handleShare('linkedin')} className="cursor-pointer">
                      <svg className="w-4 h-4 mr-2" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/>
                      </svg>
                      Share on LinkedIn
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => handleShare('email')} className="cursor-pointer">
                      <Mail className="w-4 h-4 mr-2" />
                      Share via Email
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => handleShare('copy')} className="cursor-pointer">
                      {copied ? <Check className="w-4 h-4 mr-2 text-green-600" /> : <Copy className="w-4 h-4 mr-2" />}
                      {copied ? 'Copied!' : 'Copy Link'}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
