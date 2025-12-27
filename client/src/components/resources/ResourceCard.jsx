import React, { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Download, ExternalLink, PlayCircle, Calendar, User, Share2, Mail, Lock, ArrowUpRight, Eye, FileText, Plus, Copy, Check } from "lucide-react";
import { toast } from "sonner";
import { format } from "date-fns";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { createPageUrl } from "@/utils";
import AGCASButton from "../ui/AGCASButton";
import AGCASSquareButton from "../ui/AGCASSquareButton";

const iconMap = {
  ArrowUpRight,
  Download,
  ExternalLink,
  PlayCircle,
  Eye,
  FileText,
  Mail,
  Plus,
};

export default function ResourceCard({ resource, isLocked = false, buttonStyles = [], enabledSocialIcons = ['x', 'linkedin', 'email'], isAuthenticated = true }) {
  const [copied, setCopied] = useState(false);
  
  // Get button style from props instead of fetching
  const buttonStyle = buttonStyles.find(s => s.resource_type === resource.resource_type) || null;
  
  // Check if this resource requires login (non-public resource and user not authenticated)
  const requiresLogin = !isAuthenticated && !resource.is_public;
  
  const handleLoginClick = () => {
    // Include resourceId so after login we can filter to show this specific resource
    window.location.href = `/login?returnTo=/resources&resourceId=${resource.id}`;
  };

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
    window.open(resource.target_url, '_blank', 'noopener,noreferrer');
  };

  const handleShare = async (platform) => {
    const url = encodeURIComponent(resource.target_url);
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
          await navigator.clipboard.writeText(resource.target_url);
          setCopied(true);
          toast.success('Link copied to clipboard');
          setTimeout(() => setCopied(false), 2000);
        } catch (err) {
          toast.error('Failed to copy link');
        }
        break;
    }
  };

  const renderButton = () => {
    // Show "Member login required" button for non-public resources when user is not authenticated
    if (requiresLogin) {
      return (
        <Button 
          onClick={handleLoginClick}
          className="w-full bg-slate-600 hover:bg-slate-700"
          data-testid={`button-login-required-${resource.id}`}
        >
          <Lock className="w-4 h-4 mr-2" />
          Member login required
        </Button>
      );
    }
    
    if (!buttonStyle) {
      // Default fallback
      return (
        <div className="flex gap-2">
          <Button 
            onClick={handleResourceClick}
            className={`bg-blue-600 hover:bg-blue-700 ${resource.is_public ? 'flex-1' : 'w-full'}`}
          >
            {getResourceIcon(resource.resource_type)}
            <span className="ml-2">{getResourceLabel(resource.resource_type)}</span>
          </Button>
          
          {resource.is_public && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="shrink-0 w-10 self-stretch inline-flex items-center justify-center bg-transparent rounded-none transition-all duration-300 hover:text-white agcas-share-button">
                  <Share2 className="w-4 h-4" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {enabledSocialIcons.includes('x') && (
                  <DropdownMenuItem onClick={() => handleShare('x')} className="cursor-pointer">
                    <svg className="w-4 h-4 mr-2" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
                    </svg>
                    Share on X
                  </DropdownMenuItem>
                )}
                {enabledSocialIcons.includes('linkedin') && (
                  <DropdownMenuItem onClick={() => handleShare('linkedin')} className="cursor-pointer">
                    <svg className="w-4 h-4 mr-2" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/>
                    </svg>
                    Share on LinkedIn
                  </DropdownMenuItem>
                )}
                {enabledSocialIcons.includes('email') && (
                  <DropdownMenuItem onClick={() => handleShare('email')} className="cursor-pointer">
                    <Mail className="w-4 h-4 mr-2" />
                    Share via Email
                  </DropdownMenuItem>
                )}
                {enabledSocialIcons.includes('copy') && (
                  <DropdownMenuItem onClick={() => handleShare('copy')} className="cursor-pointer">
                    {copied ? <Check className="w-4 h-4 mr-2 text-green-600" /> : <Copy className="w-4 h-4 mr-2" />}
                    {copied ? 'Copied!' : 'Copy Link'}
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      );
    }

    const buttonText = buttonStyle.button_text || getResourceLabel(resource.resource_type);
    const buttonType = buttonStyle.button_type;
    const IconComponent = buttonStyle.icon_name && iconMap[buttonStyle.icon_name];

    if (buttonType === "square_agcas") {
      return (
        <div className="flex gap-2">
          <AGCASSquareButton onClick={handleResourceClick} className="shrink-0" />
          {resource.is_public && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="shrink-0 w-10 self-stretch inline-flex items-center justify-center bg-transparent rounded-none transition-all duration-300 hover:text-white agcas-share-button">
                  <Share2 className="w-4 h-4" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {enabledSocialIcons.includes('x') && (
                  <DropdownMenuItem onClick={() => handleShare('x')} className="cursor-pointer">
                    <svg className="w-4 h-4 mr-2" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
                    </svg>
                    Share on X
                  </DropdownMenuItem>
                )}
                {enabledSocialIcons.includes('linkedin') && (
                  <DropdownMenuItem onClick={() => handleShare('linkedin')} className="cursor-pointer">
                    <svg className="w-4 h-4 mr-2" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/>
                    </svg>
                    Share on LinkedIn
                  </DropdownMenuItem>
                )}
                {enabledSocialIcons.includes('email') && (
                  <DropdownMenuItem onClick={() => handleShare('email')} className="cursor-pointer">
                    <Mail className="w-4 h-4 mr-2" />
                    Share via Email
                  </DropdownMenuItem>
                )}
                {enabledSocialIcons.includes('copy') && (
                  <DropdownMenuItem onClick={() => handleShare('copy')} className="cursor-pointer">
                    {copied ? <Check className="w-4 h-4 mr-2 text-green-600" /> : <Copy className="w-4 h-4 mr-2" />}
                    {copied ? 'Copied!' : 'Copy Link'}
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      );
    } else if (buttonType === "rectangular_agcas") {
      return (
        <div className="flex gap-2">
          <AGCASButton 
            onClick={handleResourceClick}
            icon={IconComponent && buttonStyle.icon_name !== 'none' ? IconComponent : undefined}
            className={resource.is_public ? 'flex-1' : 'w-full'}
          >
            {buttonText}
          </AGCASButton>
          
          {resource.is_public && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="shrink-0 w-10 self-stretch inline-flex items-center justify-center bg-transparent rounded-none transition-all duration-300 hover:text-white agcas-share-button">
                  <Share2 className="w-4 h-4" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {enabledSocialIcons.includes('x') && (
                  <DropdownMenuItem onClick={() => handleShare('x')} className="cursor-pointer">
                    <svg className="w-4 h-4 mr-2" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
                    </svg>
                    Share on X
                  </DropdownMenuItem>
                )}
                {enabledSocialIcons.includes('linkedin') && (
                  <DropdownMenuItem onClick={() => handleShare('linkedin')} className="cursor-pointer">
                    <svg className="w-4 h-4 mr-2" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/>
                    </svg>
                    Share on LinkedIn
                  </DropdownMenuItem>
                )}
                {enabledSocialIcons.includes('email') && (
                  <DropdownMenuItem onClick={() => handleShare('email')} className="cursor-pointer">
                    <Mail className="w-4 h-4 mr-2" />
                    Share via Email
                  </DropdownMenuItem>
                )}
                {enabledSocialIcons.includes('copy') && (
                  <DropdownMenuItem onClick={() => handleShare('copy')} className="cursor-pointer">
                    {copied ? <Check className="w-4 h-4 mr-2 text-green-600" /> : <Copy className="w-4 h-4 mr-2" />}
                    {copied ? 'Copied!' : 'Copy Link'}
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      );
    } else {
      // Standard button
      return (
        <div className="flex gap-2">
          <Button 
            onClick={handleResourceClick}
            className={`bg-blue-600 hover:bg-blue-700 ${resource.is_public ? 'flex-1' : 'w-full'}`}
          >
            {IconComponent && buttonStyle.icon_name !== 'none' ? <IconComponent className="w-4 h-4 mr-2" /> : getResourceIcon(resource.resource_type)}
            {buttonText}
          </Button>
          
          {resource.is_public && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="shrink-0 w-10 self-stretch inline-flex items-center justify-center bg-transparent rounded-none transition-all duration-300 hover:text-white agcas-share-button">
                  <Share2 className="w-4 h-4" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {enabledSocialIcons.includes('x') && (
                  <DropdownMenuItem onClick={() => handleShare('x')} className="cursor-pointer">
                    <svg className="w-4 h-4 mr-2" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
                    </svg>
                    Share on X
                  </DropdownMenuItem>
                )}
                {enabledSocialIcons.includes('linkedin') && (
                  <DropdownMenuItem onClick={() => handleShare('linkedin')} className="cursor-pointer">
                    <svg className="w-4 h-4 mr-2" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/>
                    </svg>
                    Share on LinkedIn
                  </DropdownMenuItem>
                )}
                {enabledSocialIcons.includes('email') && (
                  <DropdownMenuItem onClick={() => handleShare('email')} className="cursor-pointer">
                    <Mail className="w-4 h-4 mr-2" />
                    Share via Email
                  </DropdownMenuItem>
                )}
                {enabledSocialIcons.includes('copy') && (
                  <DropdownMenuItem onClick={() => handleShare('copy')} className="cursor-pointer">
                    {copied ? <Check className="w-4 h-4 mr-2 text-green-600" /> : <Copy className="w-4 h-4 mr-2" />}
                    {copied ? 'Copied!' : 'Copy Link'}
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      );
    }
  };

  return (
    <Card className="border-slate-200 hover:shadow-lg transition-shadow duration-300 overflow-hidden h-full flex flex-col rounded-none relative">
      <style>{`
        .agcas-share-button {
          box-shadow: inset 0 0 0 2px black;
        }
        .agcas-share-button:hover {
          background: linear-gradient(to right top, rgb(92, 0, 133), rgb(186, 0, 135), rgb(238, 0, 195), rgb(255, 66, 41), rgb(255, 176, 0));
          box-shadow: none !important;
        }
      `}</style>
      
      {isLocked && (
        <div className="absolute top-0 right-0 z-10 bg-slate-900 p-2 shadow-lg">
          <Lock className="w-5 h-5 text-white" />
        </div>
      )}
      
      {resource.image_url && (
        <>
          <div className="h-48 overflow-hidden bg-slate-100 relative">
            <img 
              src={resource.image_url} 
              alt={resource.title}
              className="w-full h-full object-cover hover:scale-105 transition-transform duration-300"
            />
          </div>
          <div className="w-full h-[3px]" style={{ backgroundColor: '#5d0d77' }}></div>
        </>
      )}
      
      <CardHeader className="pb-3 flex-grow">
        <CardTitle className="text-lg line-clamp-2">{resource.title}</CardTitle>
        
        {(resource.published_date || resource.created_date) && (
          <div className="flex items-center gap-1 text-xs text-slate-500 py-3">
            <Calendar className="w-3 h-3" />
            <span>{format(new Date(resource.published_date || resource.created_date), 'dd MMM yyyy')}</span>
          </div>
        )}
        
        {resource.author_name && (
          <div className="flex items-center gap-1.5 text-xs text-slate-600 mt-2">
            <User className="w-3 h-3" />
            <span>by {resource.author_name}</span>
          </div>
        )}
        
        {resource.description && (
          <p className="text-sm text-slate-600">
            {resource.description}
          </p>
        )}

        {resource.tags && resource.tags.length > 0 && (
          <div className="flex flex-wrap gap-1 pt-4">
            {resource.tags.map((tag, index) => (
              <span 
                key={index}
                className="text-xs bg-slate-100 text-slate-600 px-2 py-1 rounded-none"
              >
                {tag}
              </span>
            ))}
          </div>
        )}
      </CardHeader>

      <CardContent className="pt-0 pb-4 mt-auto">
        {isLocked ? (
          <Button 
            onClick={() => window.location.href = createPageUrl('Home')}
            variant="outline"
            className="w-full border-slate-300 hover:bg-slate-50 rounded-none"
          >
            <Lock className="w-4 h-4 mr-2 text-slate-600" />
            <span className="text-slate-700">Member only content - click to login</span>
          </Button>
        ) : (
          renderButton()
        )}
      </CardContent>
    </Card>
  );
}