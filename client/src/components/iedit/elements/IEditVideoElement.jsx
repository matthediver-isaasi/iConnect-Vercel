import { useState, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Video, AlertCircle, Play } from "lucide-react";

const ALLOWED_VIDEO_DOMAINS = [
  'youtube.com',
  'www.youtube.com',
  'youtu.be',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
  'vimeo.com',
  'player.vimeo.com',
  'wistia.com',
  'fast.wistia.net',
  'fast.wistia.com',
  'dailymotion.com',
  'www.dailymotion.com',
  'loom.com',
  'www.loom.com',
  'streamable.com',
  'www.streamable.com',
  'vidyard.com',
  'video.vidyard.com',
  'play.vidyard.com'
];

function isAllowedVideoUrl(url) {
  if (!url) return false;
  
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    
    const hostname = parsed.hostname.toLowerCase();
    return ALLOWED_VIDEO_DOMAINS.some(domain => 
      hostname === domain || hostname.endsWith('.' + domain)
    );
  } catch {
    return false;
  }
}

function extractVideoSrc(embedCode) {
  if (!embedCode) return null;
  
  const trimmed = embedCode.trim();
  
  if (trimmed.startsWith('https://')) {
    return isAllowedVideoUrl(trimmed) ? trimmed : null;
  }
  
  const iframeMatch = trimmed.match(/<iframe[^>]+src=["']([^"']+)["']/i);
  if (iframeMatch && iframeMatch[1]) {
    const src = iframeMatch[1];
    return isAllowedVideoUrl(src) ? src : null;
  }
  
  const srcMatch = trimmed.match(/src=["']([^"']+)["']/i);
  if (srcMatch && srcMatch[1]) {
    const src = srcMatch[1];
    return isAllowedVideoUrl(src) ? src : null;
  }
  
  return null;
}

function getAspectRatioClass(aspectRatio) {
  const ratios = {
    '16:9': 'aspect-video',
    '4:3': 'aspect-[4/3]',
    '1:1': 'aspect-square',
    '9:16': 'aspect-[9/16]',
    '21:9': 'aspect-[21/9]'
  };
  return ratios[aspectRatio] || 'aspect-video';
}

export default function IEditVideoElement({ content, variant, settings }) {
  const embedCode = content?.embed_code || '';
  const aspectRatio = content?.aspect_ratio || '16:9';
  const maxWidth = content?.max_width || 100;
  const alignment = content?.alignment || 'center';
  const title = content?.title || '';
  const caption = content?.caption || '';
  const borderRadius = content?.border_radius ?? 8;
  const showBorder = content?.show_border || false;
  const borderColor = content?.border_color || '#e2e8f0';
  
  const videoSrc = useMemo(() => extractVideoSrc(embedCode), [embedCode]);
  
  const getContainerStyles = () => {
    const alignments = {
      left: 'flex-start',
      center: 'center',
      right: 'flex-end'
    };
    
    return {
      display: 'flex',
      justifyContent: alignments[alignment] || 'center',
      width: '100%'
    };
  };
  
  const getVideoWrapperStyles = () => {
    const styles = {
      width: `${maxWidth}%`,
      borderRadius: `${borderRadius}px`,
      overflow: 'hidden'
    };
    
    if (showBorder) {
      styles.border = `2px solid ${borderColor}`;
    }
    
    return styles;
  };
  
  if (!embedCode) {
    return (
      <div className="bg-slate-100 aspect-video rounded-lg flex flex-col items-center justify-center gap-2">
        <Video className="w-12 h-12 text-slate-400" />
        <p className="text-slate-400">No video embed code provided</p>
      </div>
    );
  }
  
  if (!videoSrc) {
    return (
      <div className="bg-amber-50 border border-amber-200 aspect-video rounded-lg flex flex-col items-center justify-center gap-2 p-4">
        <AlertCircle className="w-12 h-12 text-amber-500" />
        <p className="text-amber-700 text-center">Could not extract video URL from embed code</p>
        <p className="text-amber-600 text-sm text-center">
          Supported platforms: YouTube, Vimeo, Wistia, Loom, Dailymotion, Streamable, Vidyard
        </p>
      </div>
    );
  }
  
  return (
    <div style={getContainerStyles()}>
      <div style={getVideoWrapperStyles()}>
        {title && (
          <h3 className="text-lg font-semibold text-slate-900 mb-3">{title}</h3>
        )}
        
        <div className={`relative ${getAspectRatioClass(aspectRatio)} bg-black`}>
          <iframe
            src={videoSrc}
            className="absolute inset-0 w-full h-full"
            frameBorder="0"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            allowFullScreen
            referrerPolicy="strict-origin-when-cross-origin"
            title={title || "Embedded video"}
          />
        </div>
        
        {caption && (
          <p className="text-sm text-slate-600 mt-3 text-center">{caption}</p>
        )}
      </div>
    </div>
  );
}

export function IEditVideoElementRenderer(props) {
  return <IEditVideoElement {...props} />;
}

export function IEditVideoElementEditor({ element, onSave, editedContent, setEditedContent, editedSettings, setEditedSettings, updateContent, updateSetting }) {
  const embedCode = editedContent?.embed_code || '';
  const aspectRatio = editedContent?.aspect_ratio || '16:9';
  const maxWidth = editedContent?.max_width ?? 100;
  const alignment = editedContent?.alignment || 'center';
  const title = editedContent?.title || '';
  const caption = editedContent?.caption || '';
  const borderRadius = editedContent?.border_radius ?? 8;
  const showBorder = editedContent?.show_border || false;
  const borderColor = editedContent?.border_color || '#e2e8f0';
  
  const videoSrc = useMemo(() => extractVideoSrc(embedCode), [embedCode]);
  
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Video className="w-4 h-4" />
            Video Embed
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label htmlFor="embed_code">Embed Code or URL</Label>
            <Textarea
              id="embed_code"
              value={embedCode}
              onChange={(e) => updateContent('embed_code', e.target.value)}
              placeholder="Paste iframe embed code from YouTube, Vimeo, etc. or a direct video URL"
              className="min-h-[100px] font-mono text-sm mt-1"
              data-testid="input-video-embed-code"
            />
            <p className="text-xs text-slate-500 mt-1">
              Supports YouTube, Vimeo, Wistia, and other video platforms
            </p>
          </div>
          
          {videoSrc && (
            <div className="bg-green-50 border border-green-200 rounded-lg p-3">
              <p className="text-sm text-green-700 flex items-center gap-2">
                <Play className="w-4 h-4" />
                Video URL detected
              </p>
              <p className="text-xs text-green-600 mt-1 truncate">{videoSrc}</p>
            </div>
          )}
          
          {embedCode && !videoSrc && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
              <p className="text-sm text-amber-700 flex items-center gap-2">
                <AlertCircle className="w-4 h-4" />
                Could not extract video URL
              </p>
              <p className="text-xs text-amber-600 mt-1">Please check your embed code format</p>
            </div>
          )}
        </CardContent>
      </Card>
      
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Display Settings</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label htmlFor="title">Title (optional)</Label>
            <Input
              id="title"
              value={title}
              onChange={(e) => updateContent('title', e.target.value)}
              placeholder="Video title"
              className="mt-1"
              data-testid="input-video-title"
            />
          </div>
          
          <div>
            <Label htmlFor="caption">Caption (optional)</Label>
            <Input
              id="caption"
              value={caption}
              onChange={(e) => updateContent('caption', e.target.value)}
              placeholder="Video caption"
              className="mt-1"
              data-testid="input-video-caption"
            />
          </div>
          
          <div>
            <Label>Aspect Ratio</Label>
            <Select value={aspectRatio} onValueChange={(v) => updateContent('aspect_ratio', v)}>
              <SelectTrigger className="mt-1" data-testid="select-video-aspect-ratio">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="16:9">16:9 (Widescreen)</SelectItem>
                <SelectItem value="4:3">4:3 (Standard)</SelectItem>
                <SelectItem value="1:1">1:1 (Square)</SelectItem>
                <SelectItem value="9:16">9:16 (Vertical)</SelectItem>
                <SelectItem value="21:9">21:9 (Ultrawide)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          
          <div>
            <Label>Alignment</Label>
            <Select value={alignment} onValueChange={(v) => updateContent('alignment', v)}>
              <SelectTrigger className="mt-1" data-testid="select-video-alignment">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="left">Left</SelectItem>
                <SelectItem value="center">Center</SelectItem>
                <SelectItem value="right">Right</SelectItem>
              </SelectContent>
            </Select>
          </div>
          
          <div>
            <Label>Max Width: {maxWidth}%</Label>
            <Slider
              value={[maxWidth]}
              onValueChange={([v]) => updateContent('max_width', v)}
              min={25}
              max={100}
              step={5}
              className="mt-2"
              data-testid="slider-video-max-width"
            />
          </div>
          
          <div>
            <Label>Border Radius: {borderRadius}px</Label>
            <Slider
              value={[borderRadius]}
              onValueChange={([v]) => updateContent('border_radius', v)}
              min={0}
              max={32}
              step={1}
              className="mt-2"
              data-testid="slider-video-border-radius"
            />
          </div>
          
          <div className="flex items-center justify-between">
            <Label htmlFor="show_border">Show Border</Label>
            <Switch
              id="show_border"
              checked={showBorder}
              onCheckedChange={(v) => updateContent('show_border', v)}
              data-testid="switch-video-show-border"
            />
          </div>
          
          {showBorder && (
            <div>
              <Label htmlFor="border_color">Border Color</Label>
              <div className="flex gap-2 mt-1">
                <Input
                  type="color"
                  id="border_color"
                  value={borderColor}
                  onChange={(e) => updateContent('border_color', e.target.value)}
                  className="w-12 h-10 p-1 cursor-pointer"
                  data-testid="input-video-border-color"
                />
                <Input
                  value={borderColor}
                  onChange={(e) => updateContent('border_color', e.target.value)}
                  className="flex-1"
                  data-testid="input-video-border-color-text"
                />
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
