import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useSearchParams, Link } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  Heart, Loader2, Users, Target, Copy, Check,
  ExternalLink, AlertCircle, ImagePlus, MessageSquare,
  ChevronDown, ChevronUp, X, Clock, ArrowLeft, DollarSign,
  TrendingUp, TrendingDown, Send, Mail, Globe, Sparkles,
  Trophy, Medal, Star, Flame, Zap, Award, Minus, Building2,
  Megaphone, Lock, Pencil, Trash2, Camera, Save, Image, FileText, Download,
  CornerDownRight
} from "lucide-react";
import {
  Tooltip, TooltipContent, TooltipTrigger, TooltipProvider
} from "@/components/ui/tooltip";
import { getTenantSlugFromLocation } from "@/api/publicClient";
import PostImageGallery from "@/components/PostImageGallery";

function getSessionKey() {
  const slug = getTenantSlugFromLocation();
  return slug ? `fundraiser_session_${slug}` : 'fundraiser_session_token';
}

function useProfileUpload(tenantSlug) {
  const sessionToken = localStorage.getItem(
    tenantSlug ? `fundraiser_session_${tenantSlug}` : 'fundraiser_session_token'
  );

  const uploadImage = async (teamMemberId, field, file) => {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('team_member_id', teamMemberId);
    formData.append('field', field);
    let url = `/api/public/fundraising/update-profile?session_token=${encodeURIComponent(sessionToken)}`;
    if (tenantSlug) url += `&tenant=${tenantSlug}`;
    const res = await fetch(url, { method: 'PUT', body: formData });
    if (!res.ok) throw new Error('Upload failed');
    return res.json();
  };

  const updateText = async (teamMemberId, field, value) => {
    let url = `/api/public/fundraising/update-profile?session_token=${encodeURIComponent(sessionToken)}`;
    if (tenantSlug) url += `&tenant=${tenantSlug}`;
    const res = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ team_member_id: teamMemberId, field, value })
    });
    if (!res.ok) throw new Error('Update failed');
    return res.json();
  };

  const removeImage = async (teamMemberId, field) => {
    let url = `/api/public/fundraising/update-profile?session_token=${encodeURIComponent(sessionToken)}`;
    if (tenantSlug) url += `&tenant=${tenantSlug}`;
    const res = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ team_member_id: teamMemberId, field, value: 'remove' })
    });
    if (!res.ok) throw new Error('Remove failed');
    return res.json();
  };

  return { uploadImage, updateText, removeImage };
}

function formatCurrency(amount, currency) {
  const symbols = { GBP: '\u00a3', USD: '$', EUR: '\u20ac' };
  const symbol = symbols[currency] || currency + ' ';
  return `${symbol}${parseFloat(amount || 0).toFixed(2)}`;
}

function ProgressBar({ percent }) {
  const clamped = Math.min(100, Math.max(0, percent));
  return (
    <div className="relative w-full rounded-full h-3 overflow-hidden"
         style={{ background: 'linear-gradient(90deg, #ef4444 0%, #f59e0b 40%, #22c55e 100%)' }}>
      <div
        className="absolute top-0 right-0 h-full bg-muted/80 rounded-r-full transition-all duration-700"
        style={{ width: `${100 - clamped}%` }}
      />
      {clamped > 0 && clamped < 100 && (
        <div
          className="absolute top-1/2 -translate-y-1/2 w-1 rounded-full bg-foreground shadow-sm transition-all duration-700"
          style={{ left: `calc(${clamped}% - 2px)`, height: 'calc(100% + 4px)' }}
        />
      )}
    </div>
  );
}

function CopyLinkButton({ url }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  };

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={handleCopy}
      data-testid="button-copy-link"
    >
      {copied ? <Check className="w-4 h-4 mr-1" /> : <Copy className="w-4 h-4 mr-1" />}
      {copied ? 'Copied' : 'Copy Link'}
    </Button>
  );
}

function formatTimeAgo(dateStr) {
  const now = new Date();
  const date = new Date(dateStr);
  const diff = Math.floor((now - date) / 1000);
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

const ACHIEVEMENT_ICONS = {
  heart: Heart,
  users: Users,
  star: Star,
  target: Target,
  trophy: Trophy,
  flame: Flame,
  zap: Zap,
};

function RankBadge({ rank }) {
  if (rank === 1) return <Trophy className="w-5 h-5 text-yellow-500" />;
  if (rank === 2) return <Medal className="w-5 h-5 text-gray-400" />;
  if (rank === 3) return <Medal className="w-5 h-5 text-amber-600" />;
  return <span className="text-lg font-bold">#{rank}</span>;
}

function GamificationSection({ campaignId, teamMemberId, currency }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [leaderboardOpen, setLeaderboardOpen] = useState(false);

  useEffect(() => {
    const tenantSlug = getTenantSlugFromLocation();
    const sessionToken = localStorage.getItem(getSessionKey());
    if (!sessionToken || !campaignId || !teamMemberId) return;

    let url = `/api/public/fundraising/gamification?campaign_id=${campaignId}&team_member_id=${teamMemberId}&session_token=${encodeURIComponent(sessionToken)}`;
    if (tenantSlug) url += `&tenant=${tenantSlug}`;

    fetch(url)
      .then(res => res.ok ? res.json() : null)
      .then(d => { if (d) setData(d); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [campaignId, teamMemberId]);

  if (loading) return null;
  if (!data || data.rank === null || data.total <= 1) return null;

  const earnedCount = data.achievements.filter(a => a.earned).length;
  const TrendIcon = data.trend?.direction === 'up' ? TrendingUp : data.trend?.direction === 'down' ? TrendingDown : Minus;
  const trendColor = data.trend?.direction === 'up' ? 'text-green-600 dark:text-green-400' : data.trend?.direction === 'down' ? 'text-red-500 dark:text-red-400' : 'text-muted-foreground';

  return (
    <div className="space-y-3" data-testid="section-gamification">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Card data-testid="card-rank">
          <CardContent className="pt-4 pb-4">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-md bg-primary/10 flex items-center justify-center shrink-0">
                <RankBadge rank={data.rank} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="text-xs text-muted-foreground">Campaign Rank</p>
                  {data.rank <= 3 && (
                    <Badge variant="secondary" className="text-xs" data-testid="badge-top-rank">
                      {data.rank === 1 ? '1st Place' : data.rank === 2 ? '2nd Place' : '3rd Place'}
                    </Badge>
                  )}
                </div>
                <p className="text-lg font-semibold" data-testid="text-rank">
                  #{data.rank} <span className="text-sm font-normal text-muted-foreground">of {data.total}</span>
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card data-testid="card-percentile">
          <CardContent className="pt-4 pb-4">
            <div className="flex items-center gap-3">
              <div className={`w-12 h-12 rounded-md flex items-center justify-center shrink-0 ${data.percentile >= 90 ? 'bg-green-500/10' : 'bg-primary/10'}`}>
                <TrendIcon className={`w-5 h-5 ${trendColor}`} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="text-xs text-muted-foreground">Percentile</p>
                  {data.trend?.direction === 'up' && (
                    <Badge variant="secondary" className="text-xs" data-testid="badge-trending">
                      Trending Up
                    </Badge>
                  )}
                </div>
                <p className="text-lg font-semibold" data-testid="text-percentile">
                  Top {Math.max(1, 100 - (data.percentile || 0))}%
                </p>
                {data.trend?.recentDonations > 0 && (
                  <p className="text-xs text-muted-foreground" data-testid="text-recent-activity">
                    {data.trend.recentDonations} donation{data.trend.recentDonations !== 1 ? 's' : ''} in last 24h
                  </p>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <TooltipProvider delayDuration={200}>
        <div className="flex items-center gap-1.5 flex-wrap px-1" data-testid="section-achievements">
          <span className="text-xs text-muted-foreground mr-1">
            <Award className="w-3.5 h-3.5 inline mr-0.5" />
            {earnedCount}/{data.achievements.length}
          </span>
          {data.achievements.map(a => {
            const IconComp = ACHIEVEMENT_ICONS[a.icon] || Star;
            return (
              <Tooltip key={a.id}>
                <TooltipTrigger asChild>
                  <div
                    className={`w-8 h-8 rounded-full flex items-center justify-center transition-colors ${
                      a.earned
                        ? 'bg-primary/15 text-primary'
                        : 'bg-muted/50 text-muted-foreground/30'
                    }`}
                    data-testid={`achievement-${a.id}`}
                  >
                    <IconComp className="w-4 h-4" />
                  </div>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="text-center max-w-[180px]">
                  <p className="font-medium text-xs">{a.label}</p>
                  <p className="text-xs text-muted-foreground">{a.description}</p>
                  {!a.earned && <p className="text-xs italic mt-0.5">Not yet earned</p>}
                </TooltipContent>
              </Tooltip>
            );
          })}
        </div>
      </TooltipProvider>

      {data.nearby.length > 1 && (
        <div>
          <button
            className="flex items-center justify-between w-full text-left px-1"
            onClick={() => setLeaderboardOpen(!leaderboardOpen)}
            data-testid="button-toggle-leaderboard"
          >
            <span className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
              <Users className="w-3.5 h-3.5" />
              Nearby Fundraisers
            </span>
            {leaderboardOpen ? <ChevronUp className="w-3.5 h-3.5 text-muted-foreground" /> : <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />}
          </button>

          {leaderboardOpen && (
            <div className="mt-2 space-y-1" data-testid="section-mini-leaderboard">
              {data.nearby.map((entry) => (
                <div
                  key={entry.rank}
                  className={`flex items-center gap-3 px-3 py-2 rounded-md text-sm ${
                    entry.isYou ? 'bg-primary/5 border border-primary/20' : ''
                  }`}
                  data-testid={`leaderboard-row-${entry.rank}`}
                >
                  <div className="w-7 shrink-0 text-center">
                    {entry.rank <= 3 ? (
                      <RankBadge rank={entry.rank} />
                    ) : (
                      <span className="text-sm font-medium text-muted-foreground">#{entry.rank}</span>
                    )}
                  </div>
                  <span className={`flex-1 truncate ${entry.isYou ? 'font-semibold' : ''}`}>
                    {entry.name} {entry.isYou ? '(You)' : ''}
                  </span>
                  <span className="text-sm font-medium shrink-0">
                    {formatCurrency(entry.raised, currency)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function CampaignUpdates({ campaignId, teamMemberId }) {
  const [expanded, setExpanded] = useState(false);
  const [updates, setUpdates] = useState([]);
  const [loadingUpdates, setLoadingUpdates] = useState(false);
  const [content, setContent] = useState('');
  const [imageFiles, setImageFiles] = useState([]);
  const [imagePreviews, setImagePreviews] = useState([]);
  const [posting, setPosting] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [editContent, setEditContent] = useState('');
  const [editExistingImages, setEditExistingImages] = useState([]);
  const [editNewFiles, setEditNewFiles] = useState([]);
  const [editNewPreviews, setEditNewPreviews] = useState([]);
  const [savingEdit, setSavingEdit] = useState(false);
  const [deletingId, setDeletingId] = useState(null);
  const fileInputRef = useRef(null);
  const editFileInputRef = useRef(null);

  const tenantSlug = getTenantSlugFromLocation();
  const sessionToken = localStorage.getItem(getSessionKey());

  const fetchUpdates = useCallback(async () => {
    setLoadingUpdates(true);
    try {
      let url = `/api/public/fundraising/updates?campaign_id=${campaignId}&context=dashboard`;
      if (sessionToken) url += `&session_token=${encodeURIComponent(sessionToken)}`;
      if (tenantSlug) url += `&tenant=${tenantSlug}`;
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        setUpdates(data);
      }
    } catch {} finally {
      setLoadingUpdates(false);
    }
  }, [campaignId, tenantSlug, sessionToken]);

  useEffect(() => {
    fetchUpdates();
  }, [fetchUpdates]);

  const handleImageSelect = (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    const newFiles = [...imageFiles, ...files];
    setImageFiles(newFiles);
    files.forEach(file => {
      const reader = new FileReader();
      reader.onload = (ev) => setImagePreviews(prev => [...prev, ev.target.result]);
      reader.readAsDataURL(file);
    });
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const removeImage = (index) => {
    setImageFiles(prev => prev.filter((_, i) => i !== index));
    setImagePreviews(prev => prev.filter((_, i) => i !== index));
  };

  const clearImages = () => {
    setImageFiles([]);
    setImagePreviews([]);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleEditImageSelect = (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    setEditNewFiles(prev => [...prev, ...files]);
    files.forEach(file => {
      const reader = new FileReader();
      reader.onload = (ev) => setEditNewPreviews(prev => [...prev, ev.target.result]);
      reader.readAsDataURL(file);
    });
    if (editFileInputRef.current) editFileInputRef.current.value = '';
  };

  const uploadImage = async (file) => {
    const formData = new FormData();
    formData.append('file', file);
    let uploadUrl = `/api/public/fundraising/upload-update-image?session_token=${encodeURIComponent(sessionToken)}`;
    if (tenantSlug) uploadUrl += `&tenant=${tenantSlug}`;
    const uploadRes = await fetch(uploadUrl, { method: 'POST', body: formData });
    if (!uploadRes.ok) throw new Error('Image upload failed');
    const uploadData = await uploadRes.json();
    return uploadData.url;
  };

  const handlePost = async () => {
    if (!content.trim() || !sessionToken) return;
    setPosting(true);
    try {
      let uploadedUrls = [];
      if (imageFiles.length > 0) {
        uploadedUrls = await Promise.all(imageFiles.map(f => uploadImage(f)));
      }

      let postUrl = `/api/public/fundraising/updates?session_token=${encodeURIComponent(sessionToken)}`;
      if (tenantSlug) postUrl += `&tenant=${tenantSlug}`;
      const postRes = await fetch(postUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          team_member_id: teamMemberId,
          campaign_id: campaignId,
          content: content.trim(),
          image_urls: uploadedUrls.length > 0 ? uploadedUrls : undefined
        })
      });

      if (!postRes.ok) throw new Error('Failed to post update');

      setContent('');
      clearImages();
      fetchUpdates();
    } catch {} finally {
      setPosting(false);
    }
  };

  const handleEdit = async (updateId) => {
    if (!editContent.trim() || !sessionToken) return;
    setSavingEdit(true);
    try {
      let newUploadedUrls = [];
      if (editNewFiles.length > 0) {
        newUploadedUrls = await Promise.all(editNewFiles.map(f => uploadImage(f)));
      }

      const allImages = [...editExistingImages, ...newUploadedUrls];

      let url = `/api/public/fundraising/updates?session_token=${encodeURIComponent(sessionToken)}`;
      if (tenantSlug) url += `&tenant=${tenantSlug}`;
      const res = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          update_id: updateId,
          content: editContent.trim(),
          image_urls: allImages
        })
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to save');
      }
      setEditingId(null);
      setEditContent('');
      setEditExistingImages([]);
      setEditNewFiles([]);
      setEditNewPreviews([]);
      fetchUpdates();
    } catch {} finally {
      setSavingEdit(false);
    }
  };

  const handleDelete = async (updateId) => {
    if (!sessionToken) return;
    setDeletingId(updateId);
    try {
      let url = `/api/public/fundraising/updates?session_token=${encodeURIComponent(sessionToken)}&update_id=${updateId}`;
      if (tenantSlug) url += `&tenant=${tenantSlug}`;
      const res = await fetch(url, { method: 'DELETE' });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to delete');
      }
      fetchUpdates();
    } catch {} finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="border-t pt-4 space-y-3">
      <button
        className="flex items-center justify-between w-full text-left"
        onClick={() => setExpanded(!expanded)}
        data-testid="button-toggle-updates"
      >
        <span className="text-sm font-medium flex items-center gap-2">
          <div className="w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center">
            <MessageSquare className="w-3 h-3 text-primary" />
          </div>
          <span className="text-primary">Post an Update</span>
          {updates.length > 0 && (
            <Badge variant="secondary" className="text-xs">{updates.length}</Badge>
          )}
        </span>
        {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
      </button>

      {expanded && (
        <div className="space-y-4">
          <div className="space-y-3">
            <Textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="Share an update with your supporters..."
              className="resize-none"
              rows={3}
              data-testid="textarea-update-content"
            />

            {imagePreviews.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {imagePreviews.map((preview, idx) => (
                  <div key={idx} className="relative inline-block">
                    <img
                      src={preview}
                      alt="Preview"
                      className="w-20 h-20 object-cover rounded-md"
                      data-testid={`img-update-preview-${idx}`}
                    />
                    <Button
                      size="icon"
                      variant="secondary"
                      className="absolute -top-2 -right-2 rounded-full"
                      onClick={() => removeImage(idx)}
                      data-testid={`button-remove-image-${idx}`}
                    >
                      <X className="w-3 h-3" />
                    </Button>
                  </div>
                ))}
              </div>
            )}

            <div className="flex items-center gap-2 flex-wrap">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                onChange={handleImageSelect}
                className="hidden"
                data-testid="input-update-image"
              />
              <Button
                variant="outline"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
                data-testid="button-add-image"
              >
                <ImagePlus className="w-4 h-4 mr-1" />
                Add Photo{imagePreviews.length > 0 ? 's' : ''}
              </Button>
              <Button
                size="sm"
                disabled={!content.trim() || posting}
                onClick={handlePost}
                data-testid="button-post-update"
              >
                {posting && <Loader2 className="w-4 h-4 animate-spin mr-1" />}
                Post Update
              </Button>
            </div>
          </div>

          {loadingUpdates ? (
            <div className="flex justify-center py-4">
              <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
            </div>
          ) : updates.length > 0 ? (
            <ThreadedUpdates
              updates={updates}
              teamMemberId={teamMemberId}
              editingId={editingId}
              setEditingId={setEditingId}
              editContent={editContent}
              setEditContent={setEditContent}
              editExistingImages={editExistingImages}
              setEditExistingImages={setEditExistingImages}
              editNewFiles={editNewFiles}
              setEditNewFiles={setEditNewFiles}
              editNewPreviews={editNewPreviews}
              setEditNewPreviews={setEditNewPreviews}
              savingEdit={savingEdit}
              deletingId={deletingId}
              handleEdit={handleEdit}
              handleDelete={handleDelete}
              handleEditImageSelect={handleEditImageSelect}
              editFileInputRef={editFileInputRef}
              formatTimeAgo={formatTimeAgo}
            />
          ) : (
            <p className="text-xs text-muted-foreground text-center py-2" data-testid="text-no-updates">
              No updates yet. Share your first update with supporters.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function ThreadedUpdates({
  updates, teamMemberId, editingId, setEditingId,
  editContent, setEditContent, editExistingImages, setEditExistingImages,
  editNewFiles, setEditNewFiles, editNewPreviews, setEditNewPreviews,
  savingEdit, deletingId, handleEdit, handleDelete,
  handleEditImageSelect, editFileInputRef, formatTimeAgo
}) {
  const topLevelUpdates = useMemo(() => {
    if (!updates) return [];
    return updates.filter(u => !u.parent_id);
  }, [updates]);

  const repliesByParent = useMemo(() => {
    if (!updates) return {};
    const map = {};
    updates.filter(u => u.parent_id).forEach(u => {
      if (!map[u.parent_id]) map[u.parent_id] = [];
      map[u.parent_id].push(u);
    });
    Object.values(map).forEach(arr => arr.sort((a, b) => new Date(a.created_at) - new Date(b.created_at)));
    return map;
  }, [updates]);

  const renderUpdateItem = (u, isReply = false) => {
    const isOwn = u.posted_by !== 'tenant' && u.team_member_id === teamMemberId;
    const isEditing = editingId === u.id;

    return (
      <div
        key={u.id}
        className={`${isReply
          ? 'ml-6 border-l-2 border-primary/20 pl-3 py-2'
          : `border rounded-md p-3 ${u.posted_by === 'tenant' ? 'border-primary/20 bg-primary/5' : ''}`
        } space-y-2`}
        data-testid={`update-${u.id}`}
      >
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium flex items-center gap-1.5" data-testid={`text-update-author-${u.id}`}>
            {isReply && <CornerDownRight className="w-3 h-3 text-muted-foreground shrink-0" />}
            {u.posted_by === 'tenant' && <Megaphone className="w-3.5 h-3.5 text-primary" />}
            {u.author_name}
            {u.posted_by === 'tenant' && u.visibility === 'private' && (
              <Badge variant="secondary" className="text-xs">
                <Lock className="w-3 h-3 mr-0.5" />Private
              </Badge>
            )}
          </span>
          <div className="flex items-center gap-1">
            {isOwn && !isEditing && (
              <>
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => {
                    setEditingId(u.id);
                    setEditContent(u.content);
                    setEditExistingImages(u.image_urls || (u.image_url ? [u.image_url] : []));
                    setEditNewFiles([]);
                    setEditNewPreviews([]);
                  }}
                  data-testid={`button-edit-update-${u.id}`}
                >
                  <Pencil className="w-3.5 h-3.5" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  disabled={deletingId === u.id}
                  onClick={() => {
                    if (window.confirm('Delete this update?')) {
                      handleDelete(u.id);
                    }
                  }}
                  data-testid={`button-delete-update-${u.id}`}
                >
                  {deletingId === u.id
                    ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    : <Trash2 className="w-3.5 h-3.5" />}
                </Button>
              </>
            )}
            <span className="text-xs text-muted-foreground flex items-center gap-1">
              <Clock className="w-3 h-3" />
              {formatTimeAgo(u.created_at)}
            </span>
          </div>
        </div>
        {isEditing ? (
          <div className="space-y-2">
            <Textarea
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              className="resize-none"
              rows={3}
              data-testid={`textarea-edit-update-${u.id}`}
            />
            {(editExistingImages.length > 0 || editNewPreviews.length > 0) && (
              <div className="flex flex-wrap gap-2">
                {editExistingImages.map((imgUrl, idx) => (
                  <div key={`existing-${idx}`} className="relative inline-block">
                    <img
                      src={imgUrl}
                      alt=""
                      className="w-20 h-20 object-cover rounded-md"
                      data-testid={`img-edit-existing-${idx}`}
                    />
                    <Button
                      size="icon"
                      variant="secondary"
                      className="absolute -top-2 -right-2 rounded-full"
                      onClick={() => setEditExistingImages(prev => prev.filter((_, i) => i !== idx))}
                      data-testid={`button-remove-edit-existing-${idx}`}
                    >
                      <X className="w-3 h-3" />
                    </Button>
                  </div>
                ))}
                {editNewPreviews.map((preview, idx) => (
                  <div key={`new-${idx}`} className="relative inline-block">
                    <img
                      src={preview}
                      alt=""
                      className="w-20 h-20 object-cover rounded-md"
                      data-testid={`img-edit-new-${idx}`}
                    />
                    <Button
                      size="icon"
                      variant="secondary"
                      className="absolute -top-2 -right-2 rounded-full"
                      onClick={() => {
                        setEditNewFiles(prev => prev.filter((_, i) => i !== idx));
                        setEditNewPreviews(prev => prev.filter((_, i) => i !== idx));
                      }}
                      data-testid={`button-remove-edit-new-${idx}`}
                    >
                      <X className="w-3 h-3" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
            <div className="flex items-center gap-2 flex-wrap">
              <input
                ref={editFileInputRef}
                type="file"
                accept="image/*"
                multiple
                onChange={handleEditImageSelect}
                className="hidden"
                data-testid={`input-edit-image-${u.id}`}
              />
              <Button
                variant="outline"
                size="sm"
                onClick={() => editFileInputRef.current?.click()}
                data-testid={`button-add-edit-image-${u.id}`}
              >
                <ImagePlus className="w-4 h-4 mr-1" />
                Add Photo
              </Button>
              <Button
                size="sm"
                disabled={!editContent.trim() || savingEdit}
                onClick={() => handleEdit(u.id)}
                data-testid={`button-save-update-${u.id}`}
              >
                {savingEdit && <Loader2 className="w-4 h-4 animate-spin mr-1" />}
                Save
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setEditingId(null);
                  setEditContent('');
                  setEditExistingImages([]);
                  setEditNewFiles([]);
                  setEditNewPreviews([]);
                }}
                data-testid={`button-cancel-edit-${u.id}`}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <>
            <p className="text-sm" data-testid={`text-update-content-${u.id}`}>{u.content}</p>
            <PostImageGallery
              images={(u.image_urls && u.image_urls.length > 0) ? u.image_urls : (u.image_url ? [u.image_url] : [])}
              updateId={u.id}
            />
            {u.attachment_urls && u.attachment_urls.length > 0 && (
              <div className="space-y-1">
                {u.attachment_urls.map((att, idx) => (
                  <a
                    key={idx}
                    href={att.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-2 text-sm text-muted-foreground hover-elevate rounded-md p-1.5"
                    data-testid={`link-attachment-${u.id}-${idx}`}
                  >
                    <FileText className="w-4 h-4 shrink-0" />
                    <span className="truncate">{att.filename}</span>
                    <Download className="w-3.5 h-3.5 ml-auto shrink-0" />
                  </a>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-3">
      {topLevelUpdates.map((u) => (
        <div key={u.id} className="space-y-0">
          {renderUpdateItem(u, false)}
          {repliesByParent[u.id] && repliesByParent[u.id].length > 0 && (
            <div className="space-y-0 mt-1">
              {repliesByParent[u.id].map(reply => renderUpdateItem(reply, true))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function DonorsList({ donors, teamMemberId, currency }) {
  const [expanded, setExpanded] = useState(false);
  const [replyingTo, setReplyingTo] = useState(null);
  const [replyType, setReplyType] = useState('public');
  const [replyMessage, setReplyMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [sentDonations, setSentDonations] = useState({});

  const tenantSlug = getTenantSlugFromLocation();
  const sessionToken = localStorage.getItem(getSessionKey());

  const handleSendResponse = async (donationId) => {
    if (!replyMessage.trim() || !sessionToken) return;
    setSending(true);
    try {
      let url = `/api/public/fundraising/donor-response?session_token=${encodeURIComponent(sessionToken)}`;
      if (tenantSlug) url += `&tenant=${tenantSlug}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          donation_id: donationId,
          team_member_id: teamMemberId,
          response_type: replyType,
          message: replyMessage.trim()
        })
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to send');
      }
      setSentDonations(prev => ({
        ...prev,
        [donationId]: [...(prev[donationId] || []), { response_type: replyType, message: replyMessage.trim(), created_at: new Date().toISOString() }]
      }));
      setReplyingTo(null);
      setReplyMessage('');
      setReplyType('public');
    } catch {} finally {
      setSending(false);
    }
  };

  if (!donors || donors.length === 0) return null;

  const getAllResponses = (donor) => {
    const existing = donor.responses || [];
    const newOnes = sentDonations[donor.id] || [];
    return [...existing, ...newOnes];
  };

  return (
    <div className="border-t pt-4 space-y-3">
      <button
        className="flex items-center justify-between w-full text-left"
        onClick={() => setExpanded(!expanded)}
        data-testid="button-toggle-donors"
      >
        <span className="text-sm font-medium flex items-center gap-2">
          <Heart className="w-4 h-4" />
          Your Donors
          <Badge variant="secondary" className="text-xs">{donors.length}</Badge>
        </span>
        {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
      </button>

      {expanded && (
        <div className="space-y-3">
          {donors.map((donor) => {
            const responses = getAllResponses(donor);
            const hasPublicResponse = responses.some(r => r.response_type === 'public');
            const hasPrivateResponse = responses.some(r => r.response_type === 'private');

            return (
              <div key={donor.id} className="border rounded-md p-3 space-y-2" data-testid={`donor-${donor.id}`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center text-xs font-medium shrink-0">
                      {donor.is_anonymous ? '?' : donor.donor_name?.[0]?.toUpperCase()}
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate" data-testid={`text-donor-name-${donor.id}`}>
                        {donor.donor_name}
                      </p>
                      <p className="text-xs text-muted-foreground" data-testid={`text-donor-amount-${donor.id}`}>
                        {formatCurrency(donor.amount, currency)} · {formatTimeAgo(donor.created_at)}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {hasPublicResponse && (
                      <Badge variant="outline" className="text-xs">
                        <Globe className="w-3 h-3 mr-0.5" />
                        Thanked
                      </Badge>
                    )}
                    {hasPrivateResponse && (
                      <Badge variant="outline" className="text-xs">
                        <Mail className="w-3 h-3 mr-0.5" />
                        Messaged
                      </Badge>
                    )}
                  </div>
                </div>

                {donor.donor_message && (
                  <p className="text-xs text-muted-foreground italic pl-10" data-testid={`text-donor-message-${donor.id}`}>
                    "{donor.donor_message}"
                  </p>
                )}

                {responses.length > 0 && (
                  <div className="pl-10 space-y-1">
                    {responses.map((r, i) => (
                      <div key={i} className="text-xs bg-muted/50 rounded-md px-2 py-1.5 flex items-start gap-1.5" data-testid={`response-${donor.id}-${i}`}>
                        {r.response_type === 'public' ? <Globe className="w-3 h-3 mt-0.5 shrink-0 text-muted-foreground" /> : <Mail className="w-3 h-3 mt-0.5 shrink-0 text-muted-foreground" />}
                        <span>{r.message}</span>
                      </div>
                    ))}
                  </div>
                )}

                {replyingTo === donor.id ? (
                  <div className="pl-10 space-y-2">
                    <div className="flex items-center gap-2">
                      <Button
                        variant={replyType === 'public' ? 'default' : 'outline'}
                        size="sm"
                        onClick={() => setReplyType('public')}
                        data-testid="button-reply-public"
                      >
                        <Globe className="w-3 h-3 mr-1" />
                        Public Thank You
                      </Button>
                      <Button
                        variant={replyType === 'private' ? 'default' : 'outline'}
                        size="sm"
                        onClick={() => setReplyType('private')}
                        disabled={!donor.donor_email || donor.is_anonymous}
                        data-testid="button-reply-private"
                      >
                        <Mail className="w-3 h-3 mr-1" />
                        Private Message
                      </Button>
                    </div>
                    <Textarea
                      value={replyMessage}
                      onChange={(e) => setReplyMessage(e.target.value)}
                      placeholder={replyType === 'public' ? 'Write a public thank you...' : 'Write a private message to the donor...'}
                      className="resize-none text-sm"
                      rows={2}
                      data-testid="textarea-donor-reply"
                    />
                    <div className="flex items-center gap-2 flex-wrap">
                      <Button
                        size="sm"
                        disabled={!replyMessage.trim() || sending}
                        onClick={() => handleSendResponse(donor.id)}
                        data-testid="button-send-reply"
                      >
                        {sending ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Send className="w-3 h-3 mr-1" />}
                        {replyType === 'public' ? 'Post Thank You' : 'Send Message'}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => { setReplyingTo(null); setReplyMessage(''); }}
                        data-testid="button-cancel-reply"
                      >
                        Cancel
                      </Button>
                    </div>
                    {replyType === 'private' && (!donor.donor_email || donor.is_anonymous) && (
                      <p className="text-xs text-muted-foreground">
                        Private messaging is not available for anonymous donors or donors without an email address.
                      </p>
                    )}
                  </div>
                ) : (
                  <div className="pl-10">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => { setReplyingTo(donor.id); setReplyMessage(''); }}
                      data-testid={`button-reply-${donor.id}`}
                    >
                      <MessageSquare className="w-3 h-3 mr-1" />
                      Reply
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function WellwishersList({ wellwishers, teamMemberId }) {
  const [expanded, setExpanded] = useState(false);
  const [replyingTo, setReplyingTo] = useState(null);
  const [replyMessage, setReplyMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [sentResponses, setSentResponses] = useState({});

  const tenantSlug = getTenantSlugFromLocation();
  const sessionToken = localStorage.getItem(getSessionKey());

  const handleSendResponse = async (wellwisherId) => {
    if (!replyMessage.trim() || !sessionToken) return;
    setSending(true);
    try {
      let url = `/api/public/fundraising/donor-response?session_token=${encodeURIComponent(sessionToken)}`;
      if (tenantSlug) url += `&tenant=${tenantSlug}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wellwisher_id: wellwisherId,
          team_member_id: teamMemberId,
          response_type: 'public',
          message: replyMessage.trim()
        })
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to send');
      }
      setSentResponses(prev => ({
        ...prev,
        [wellwisherId]: [...(prev[wellwisherId] || []), { response_type: 'public', message: replyMessage.trim(), created_at: new Date().toISOString() }]
      }));
      setReplyingTo(null);
      setReplyMessage('');
    } catch {} finally {
      setSending(false);
    }
  };

  if (!wellwishers || wellwishers.length === 0) return null;

  const getAllResponses = (w) => {
    const existing = w.responses || [];
    const newOnes = sentResponses[w.id] || [];
    return [...existing, ...newOnes];
  };

  return (
    <div className="border-t pt-4 space-y-3">
      <button
        className="flex items-center justify-between w-full text-left"
        onClick={() => setExpanded(!expanded)}
        data-testid="button-toggle-wellwishers"
      >
        <span className="text-sm font-medium flex items-center gap-2">
          <Sparkles className="w-4 h-4" />
          Well-Wishers
          <Badge variant="secondary" className="text-xs">{wellwishers.length}</Badge>
        </span>
        {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
      </button>

      {expanded && (
        <div className="space-y-3">
          {wellwishers.map((w) => {
            const responses = getAllResponses(w);
            const hasResponse = responses.length > 0;

            return (
              <div key={w.id} className="border rounded-md p-3 space-y-2" data-testid={`wellwisher-dashboard-${w.id}`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center text-xs font-medium shrink-0">
                      {w.name?.[0]?.toUpperCase() || '?'}
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate" data-testid={`text-wellwisher-name-${w.id}`}>
                        {w.name}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {formatTimeAgo(w.created_at)}
                      </p>
                    </div>
                  </div>
                  {hasResponse && (
                    <Badge variant="outline" className="text-xs shrink-0">
                      <Globe className="w-3 h-3 mr-0.5" />
                      Replied
                    </Badge>
                  )}
                </div>

                {w.message && (
                  <p className="text-xs text-muted-foreground italic pl-10" data-testid={`text-wellwisher-message-${w.id}`}>
                    "{w.message}"
                  </p>
                )}

                {responses.length > 0 && (
                  <div className="pl-10 space-y-1">
                    {responses.map((r, i) => (
                      <div key={i} className="text-xs bg-muted/50 rounded-md px-2 py-1.5 flex items-start gap-1.5">
                        <Globe className="w-3 h-3 mt-0.5 shrink-0 text-muted-foreground" />
                        <span>{r.message}</span>
                      </div>
                    ))}
                  </div>
                )}

                {replyingTo === w.id ? (
                  <div className="pl-10 space-y-2">
                    <Textarea
                      value={replyMessage}
                      onChange={(e) => setReplyMessage(e.target.value)}
                      placeholder="Write a public reply..."
                      className="resize-none text-sm"
                      rows={2}
                      data-testid="textarea-wellwisher-reply"
                    />
                    <div className="flex items-center gap-2 flex-wrap">
                      <Button
                        size="sm"
                        disabled={!replyMessage.trim() || sending}
                        onClick={() => handleSendResponse(w.id)}
                        data-testid="button-send-wellwisher-reply"
                      >
                        {sending ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Send className="w-3 h-3 mr-1" />}
                        Post Reply
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => { setReplyingTo(null); setReplyMessage(''); }}
                        data-testid="button-cancel-wellwisher-reply"
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="pl-10">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => { setReplyingTo(w.id); setReplyMessage(''); }}
                      data-testid={`button-reply-wellwisher-${w.id}`}
                    >
                      <MessageSquare className="w-3 h-3 mr-1" />
                      Reply
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }) {
  const variants = {
    active: 'default',
    draft: 'secondary',
    completed: 'outline',
    paused: 'secondary'
  };
  return (
    <Badge variant={variants[status] || 'secondary'} data-testid="badge-campaign-status">
      {status ? status.charAt(0).toUpperCase() + status.slice(1) : 'Unknown'}
    </Badge>
  );
}

function SummaryCards({ campaigns }) {
  const totalRaised = campaigns.reduce((sum, c) => sum + parseFloat(c.individual_raised || 0), 0);
  const totalDonations = campaigns.reduce((sum, c) => sum + (c.donation_count || 0), 0);
  const activeCampaigns = campaigns.filter(c => c.campaign_status === 'active').length;
  const currency = campaigns[0]?.currency || 'USD';

  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
      <Card data-testid="card-summary-total-raised">
        <CardContent className="pt-5 pb-5">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-md bg-primary/10 flex items-center justify-center shrink-0">
              <DollarSign className="w-5 h-5 text-primary" />
            </div>
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">Total Raised</p>
              <p className="text-lg font-semibold truncate" data-testid="text-total-raised">
                {formatCurrency(totalRaised, currency)}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card data-testid="card-summary-total-donations">
        <CardContent className="pt-5 pb-5">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-md bg-primary/10 flex items-center justify-center shrink-0">
              <Heart className="w-5 h-5 text-primary" />
            </div>
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">Total Donations</p>
              <p className="text-lg font-semibold" data-testid="text-total-donations">
                {totalDonations}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card data-testid="card-summary-active-campaigns">
        <CardContent className="pt-5 pb-5">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-md bg-primary/10 flex items-center justify-center shrink-0">
              <TrendingUp className="w-5 h-5 text-primary" />
            </div>
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">Active Campaigns</p>
              <p className="text-lg font-semibold" data-testid="text-active-campaigns">
                {activeCampaigns}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function CampaignTile({ campaign, onClick, hasNewUpdates }) {
  const individualPercent = campaign.individual_goal > 0
    ? Math.round((campaign.individual_raised / campaign.individual_goal) * 100)
    : 0;

  return (
    <Card
      className="hover-elevate cursor-pointer overflow-visible"
      onClick={onClick}
      data-testid={`card-campaign-tile-${campaign.campaign_id}`}
    >
      <CardContent className="pt-4 pb-4">
        <div className="flex items-center gap-4">
          {campaign.campaign_cover_image_url ? (
            <img
              src={campaign.campaign_cover_image_url}
              alt={campaign.campaign_name}
              className="w-16 h-16 rounded-md object-cover shrink-0"
              data-testid={`img-campaign-thumb-${campaign.campaign_id}`}
            />
          ) : (
            <div className="w-16 h-16 rounded-md bg-muted flex items-center justify-center shrink-0">
              <Heart className="w-6 h-6 text-muted-foreground" />
            </div>
          )}

          <div className="flex-1 min-w-0 space-y-2">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <h3 className="text-sm font-semibold truncate flex items-center gap-2" data-testid={`text-tile-name-${campaign.campaign_id}`}>
                {campaign.campaign_name}
                {hasNewUpdates && (
                  <Badge variant="default" className="text-xs" data-testid={`badge-new-updates-${campaign.campaign_id}`}>
                    <MessageSquare className="w-3 h-3 mr-1" />
                    New
                  </Badge>
                )}
              </h3>
              <StatusBadge status={campaign.campaign_status} />
            </div>

            {campaign.individual_goal > 0 && (
              <ProgressBar percent={individualPercent} />
            )}

            <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground flex-wrap">
              <span data-testid={`text-tile-raised-${campaign.campaign_id}`}>
                {formatCurrency(campaign.individual_raised, campaign.currency)}
                {campaign.individual_goal > 0 && ` of ${formatCurrency(campaign.individual_goal, campaign.currency)}`}
              </span>
              <span className="flex items-center gap-1" data-testid={`text-tile-donations-${campaign.campaign_id}`}>
                <Heart className="w-3 h-3" />
                {campaign.donation_count} donation{campaign.donation_count !== 1 ? 's' : ''}
              </span>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function CampaignDetailView({ campaign, onBack, getDonatePageUrl, onRefresh }) {
  const individualPercent = campaign.individual_goal > 0
    ? Math.round((campaign.individual_raised / campaign.individual_goal) * 100)
    : 0;
  const donateUrl = getDonatePageUrl(campaign.participant_token, campaign);
  const tenantSlug = getTenantSlugFromLocation();
  const { uploadImage: profileUploadImage, updateText, removeImage: profileRemoveImage } = useProfileUpload(tenantSlug);

  const [editingMessage, setEditingMessage] = useState(false);
  const [messageText, setMessageText] = useState(campaign.personal_message || '');
  const [savingMessage, setSavingMessage] = useState(false);
  const [uploadingHeader, setUploadingHeader] = useState(false);
  const headerInputRef = useRef(null);

  const handleSaveMessage = async () => {
    setSavingMessage(true);
    try {
      await updateText(campaign.team_member_id, 'personal_message', messageText);
      setEditingMessage(false);
      if (onRefresh) onRefresh();
    } catch {} finally {
      setSavingMessage(false);
    }
  };

  const handleHeaderUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingHeader(true);
    try {
      await profileUploadImage(campaign.team_member_id, 'custom_header_image_url', file);
      if (onRefresh) onRefresh();
    } catch {} finally {
      setUploadingHeader(false);
      if (headerInputRef.current) headerInputRef.current.value = '';
    }
  };

  const handleRemoveHeader = async () => {
    setUploadingHeader(true);
    try {
      await profileRemoveImage(campaign.team_member_id, 'custom_header_image_url');
      if (onRefresh) onRefresh();
    } catch {} finally {
      setUploadingHeader(false);
    }
  };

  const headerImage = campaign.custom_header_image_url || campaign.campaign_cover_image_url;

  return (
    <div className="space-y-4">
      <Button
        variant="ghost"
        size="sm"
        onClick={onBack}
        data-testid="button-back-to-list"
      >
        <ArrowLeft className="w-4 h-4 mr-1" />
        Back to campaigns
      </Button>

      <Card data-testid={`card-campaign-detail-${campaign.campaign_id}`}>
        <CardContent className="pt-6 space-y-4">
          {headerImage && (
            <div className="relative h-40 -mt-6 -mx-6 mb-4 overflow-hidden rounded-t-lg group">
              <img
                src={headerImage}
                alt={campaign.campaign_name}
                className="w-full h-full object-cover"
                data-testid="img-campaign-cover"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-black/50 to-transparent" />
              <div className="absolute top-2 right-2 flex gap-1 invisible group-hover:visible">
                <input
                  ref={headerInputRef}
                  type="file"
                  accept="image/*"
                  onChange={handleHeaderUpload}
                  className="hidden"
                  data-testid="input-header-image"
                />
                <Button
                  size="icon"
                  variant="secondary"
                  disabled={uploadingHeader}
                  onClick={() => headerInputRef.current?.click()}
                  data-testid="button-change-header"
                >
                  {uploadingHeader ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Camera className="w-3.5 h-3.5" />}
                </Button>
                {campaign.custom_header_image_url && (
                  <Button
                    size="icon"
                    variant="secondary"
                    disabled={uploadingHeader}
                    onClick={handleRemoveHeader}
                    data-testid="button-remove-header"
                  >
                    <X className="w-3.5 h-3.5" />
                  </Button>
                )}
              </div>
            </div>
          )}
          {!headerImage && (
            <div className="relative -mt-6 -mx-6 mb-4 overflow-hidden rounded-t-lg">
              <div className="h-24 bg-muted flex items-center justify-center">
                <input
                  ref={headerInputRef}
                  type="file"
                  accept="image/*"
                  onChange={handleHeaderUpload}
                  className="hidden"
                  data-testid="input-header-image"
                />
                <Button
                  variant="outline"
                  size="sm"
                  disabled={uploadingHeader}
                  onClick={() => headerInputRef.current?.click()}
                  data-testid="button-add-header"
                >
                  {uploadingHeader ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <Image className="w-4 h-4 mr-1" />}
                  Add Cover Photo
                </Button>
              </div>
            </div>
          )}

          <div className="flex items-start justify-between gap-2 flex-wrap">
            <div className="space-y-1">
              <h3 className="text-lg font-semibold" data-testid="text-campaign-name">
                {campaign.campaign_name}
              </h3>
              {campaign.tenant_name && (
                <p className="text-xs text-muted-foreground flex items-center gap-1" data-testid="text-tenant-name">
                  <Building2 className="w-3 h-3" />
                  {campaign.tenant_name}
                </p>
              )}
              {campaign.organization_name && (
                <p className="text-sm text-muted-foreground" data-testid="text-org-name">
                  Raising funds on behalf of: {campaign.organization_name}
                </p>
              )}
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <StatusBadge status={campaign.campaign_status} />
              <Badge variant="outline" data-testid="badge-role">
                {campaign.role === 'lead' ? 'Lead' : 'Member'}
              </Badge>
            </div>
          </div>

          <div className="border rounded-md p-3 space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium text-muted-foreground">Why I'm fundraising</p>
              {!editingMessage && (
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => { setEditingMessage(true); setMessageText(campaign.personal_message || ''); }}
                  data-testid="button-edit-message"
                >
                  <Pencil className="w-3.5 h-3.5" />
                </Button>
              )}
            </div>
            {editingMessage ? (
              <div className="space-y-2">
                <Textarea
                  value={messageText}
                  onChange={(e) => setMessageText(e.target.value)}
                  placeholder="Tell supporters why this cause matters to you..."
                  className="resize-none"
                  rows={3}
                  data-testid="textarea-personal-message"
                />
                <div className="flex items-center gap-2 flex-wrap">
                  <Button
                    size="sm"
                    disabled={savingMessage}
                    onClick={handleSaveMessage}
                    data-testid="button-save-message"
                  >
                    {savingMessage && <Loader2 className="w-4 h-4 animate-spin mr-1" />}
                    Save
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setEditingMessage(false)}
                    data-testid="button-cancel-message"
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <p className="text-sm" data-testid="text-personal-message">
                {campaign.personal_message || (
                  <span className="text-muted-foreground italic">Add a personal message to show on your donation page</span>
                )}
              </p>
            )}
          </div>

          {campaign.individual_goal > 0 && (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground flex items-center gap-1">
                  <Target className="w-3 h-3" />
                  Your progress
                </span>
                <span className="font-medium">
                  {individualPercent}%
                </span>
              </div>
              <ProgressBar percent={individualPercent} />
              <div className="flex items-center justify-between text-sm">
                <span className="font-semibold" data-testid="text-individual-raised">
                  {formatCurrency(campaign.individual_raised, campaign.currency)}
                </span>
                <span className="text-muted-foreground" data-testid="text-individual-goal">
                  of {formatCurrency(campaign.individual_goal, campaign.currency)} goal
                </span>
              </div>
            </div>
          )}

          <div className="flex items-center gap-4 text-sm">
            <div className="flex items-center gap-1.5">
              <Heart className="w-4 h-4 text-muted-foreground" />
              <span data-testid="text-donation-count">
                {campaign.donation_count} donation{campaign.donation_count !== 1 ? 's' : ''}
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <Users className="w-4 h-4 text-muted-foreground" />
              <span data-testid="text-amount-raised">
                {formatCurrency(campaign.individual_raised, campaign.currency)} raised
              </span>
            </div>
          </div>

          <GamificationSection
            campaignId={campaign.campaign_id}
            teamMemberId={campaign.team_member_id}
            currency={campaign.currency}
          />

          <div className="border-t pt-4 space-y-3">
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">Your Donation Page</p>
              <div className="flex items-center gap-2">
                <Input
                  readOnly
                  value={donateUrl}
                  className="text-xs bg-muted/50"
                  data-testid="input-donate-url"
                />
                <CopyLinkButton url={donateUrl} />
              </div>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <a href={donateUrl} target="_blank" rel="noopener noreferrer">
                <Button variant="outline" size="sm" data-testid="button-view-donate-page">
                  <ExternalLink className="w-4 h-4 mr-1" />
                  View Page
                </Button>
              </a>
              {campaign.campaign_slug && (
                campaign.tenant_base_url ? (
                  <a href={`${campaign.tenant_base_url}/fundraise/${campaign.campaign_slug}`} target="_blank" rel="noopener noreferrer">
                    <Button variant="outline" size="sm" data-testid="button-view-campaign">
                      Campaign Page
                    </Button>
                  </a>
                ) : (
                  <Link to={`/fundraise/${campaign.campaign_slug}`}>
                    <Button variant="outline" size="sm" data-testid="button-view-campaign">
                      Campaign Page
                    </Button>
                  </Link>
                )
              )}
            </div>
          </div>

          <DonorsList
            donors={campaign.donors}
            teamMemberId={campaign.team_member_id}
            currency={campaign.currency}
          />

          <WellwishersList
            wellwishers={campaign.wellwishers}
            teamMemberId={campaign.team_member_id}
          />

          <CampaignUpdates
            campaignId={campaign.campaign_id}
            teamMemberId={campaign.team_member_id}
          />
        </CardContent>
      </Card>
    </div>
  );
}

export default function FundraiserDashboardPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [dashboardData, setDashboardData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [tenantBranding, setTenantBranding] = useState(null);
  const [selectedCampaignId, setSelectedCampaignId] = useState(null);

  const getLastViewedKey = (campaignId) => `fundraiser_last_viewed_${campaignId}`;

  const hasNewUpdates = useCallback((campaign) => {
    if (!campaign.latest_update_at) return false;
    const lastViewed = localStorage.getItem(getLastViewedKey(campaign.campaign_id));
    if (!lastViewed) return true;
    return new Date(campaign.latest_update_at) > new Date(lastViewed);
  }, []);

  const handleSelectCampaign = useCallback((campaignId) => {
    localStorage.setItem(getLastViewedKey(campaignId), new Date().toISOString());
    setSelectedCampaignId(campaignId);
  }, []);

  useEffect(() => {
    const tenantSlug = getTenantSlugFromLocation();
    if (tenantSlug) {
      fetch(`/api/public/tenant-branding?tenant=${tenantSlug}`)
        .then(res => res.ok ? res.json() : null)
        .then(data => { if (data) setTenantBranding(data); })
        .catch(() => {});
    }
  }, []);

  const avatarInputRef = useRef(null);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const tenantSlugForAvatar = getTenantSlugFromLocation();
  const { uploadImage: avatarUpload } = useProfileUpload(tenantSlugForAvatar);

  const handleLogout = useCallback(() => {
    localStorage.removeItem(getSessionKey());
    setDashboardData(null);
    setError(null);
  }, []);

  useEffect(() => {
    const urlToken = searchParams.get('token');
    const sessionKey = getSessionKey();
    const storedSession = localStorage.getItem(sessionKey);
    const tenantSlug = getTenantSlugFromLocation();

    if (urlToken) {
      let url = `/api/public/fundraising/verify-login?token=${encodeURIComponent(urlToken)}`;
      if (tenantSlug) url += `&tenant=${tenantSlug}`;

      fetch(url)
        .then(res => {
          if (!res.ok) return res.json().then(err => { throw new Error(err.error || 'Invalid login link'); });
          return res.json();
        })
        .then(data => {
          if (data.session_token) {
            localStorage.setItem(sessionKey, data.session_token);
          }
          setDashboardData(data);
          setLoading(false);
          setSearchParams({}, { replace: true });
        })
        .catch(err => {
          setError(err.message);
          setLoading(false);
        });
    } else if (storedSession) {
      let url = `/api/public/fundraising/verify-session?session_token=${encodeURIComponent(storedSession)}`;
      if (tenantSlug) url += `&tenant=${tenantSlug}`;

      fetch(url)
        .then(res => {
          if (!res.ok) {
            localStorage.removeItem(sessionKey);
            return res.json().then(err => { throw new Error(err.error || 'Session expired'); });
          }
          return res.json();
        })
        .then(data => {
          setDashboardData(data);
          setLoading(false);
        })
        .catch(err => {
          setError(err.message);
          setLoading(false);
        });
    } else {
      setError('No login token provided. Please request a login link.');
      setLoading(false);
    }
  }, [searchParams, setSearchParams]);

  const refreshData = useCallback(() => {
    const tenantSlug = getTenantSlugFromLocation();
    const sessionKey = tenantSlug ? `fundraiser_session_${tenantSlug}` : 'fundraiser_session_token';
    const storedSession = localStorage.getItem(sessionKey);
    if (!storedSession) return;
    let url = `/api/public/fundraising/verify-session?session_token=${encodeURIComponent(storedSession)}`;
    if (tenantSlug) url += `&tenant=${tenantSlug}`;
    fetch(url)
      .then(res => res.ok ? res.json() : null)
      .then(data => { if (data) setDashboardData(data); })
      .catch(() => {});
  }, []);

  const getDonatePageUrl = (participantToken, campaign) => {
    const baseUrl = campaign?.tenant_base_url || window.location.origin;
    return `${baseUrl}/donate/${participantToken}`;
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-b from-background to-muted/30">
        <div className="text-center space-y-3">
          <Loader2 className="w-8 h-8 animate-spin text-primary mx-auto" />
          <p className="text-sm text-muted-foreground" data-testid="text-loading">Loading your dashboard...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-b from-background to-muted/30 p-4">
        <div className="max-w-md w-full space-y-6">
          {tenantBranding?.logo_url && (
            <div className="flex justify-center">
              <img
                src={tenantBranding.logo_url}
                alt={tenantBranding.name || 'Logo'}
                className="h-12 object-contain"
                data-testid="img-tenant-logo"
              />
            </div>
          )}
          <Card>
            <CardContent className="pt-8 pb-8 text-center space-y-4">
              <div className="w-14 h-14 rounded-full bg-destructive/10 flex items-center justify-center mx-auto">
                <AlertCircle className="w-7 h-7 text-destructive" />
              </div>
              <h2 className="text-xl font-semibold" data-testid="text-error-heading">Login Link Invalid</h2>
              <p className="text-muted-foreground text-sm" data-testid="text-error-message">{error}</p>
              <Link to="/fundraiser/login">
                <Button data-testid="button-go-to-login">Request New Login Link</Button>
              </Link>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  if (!dashboardData) return null;

  const { first_name, last_name, avatar_url, campaigns } = dashboardData;
  const selectedCampaign = selectedCampaignId
    ? campaigns.find(c => c.campaign_id === selectedCampaignId)
    : null;

  const handleAvatarUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file || campaigns.length === 0) return;
    setUploadingAvatar(true);
    try {
      await avatarUpload(campaigns[0].team_member_id, 'avatar_url', file);
      refreshData();
    } catch {} finally {
      setUploadingAvatar(false);
      if (avatarInputRef.current) avatarInputRef.current.value = '';
    }
  };

  const uniqueTenants = [...new Set(campaigns.map(c => c.tenant_name).filter(Boolean))];
  const isMultiTenant = uniqueTenants.length > 1;

  const campaignsByTenant = isMultiTenant
    ? campaigns.reduce((groups, campaign) => {
        const tenantName = campaign.tenant_name || 'Other';
        if (!groups[tenantName]) groups[tenantName] = [];
        groups[tenantName].push(campaign);
        return groups;
      }, {})
    : null;

  return (
    <div className="min-h-screen bg-gradient-to-b from-background to-muted/30">
      <div className="max-w-3xl mx-auto px-4 py-8 space-y-6">
        {tenantBranding?.logo_url && (
          <div className="flex justify-center">
            <img
              src={tenantBranding.logo_url}
              alt={tenantBranding.name || 'Logo'}
              className="h-12 object-contain"
              data-testid="img-tenant-logo"
            />
          </div>
        )}

        <div className="text-center space-y-2">
          <input
            ref={avatarInputRef}
            type="file"
            accept="image/*"
            onChange={handleAvatarUpload}
            className="hidden"
            data-testid="input-avatar-upload"
          />
          <button
            className="relative w-14 h-14 rounded-full mx-auto group cursor-pointer"
            onClick={() => avatarInputRef.current?.click()}
            disabled={uploadingAvatar}
            data-testid="button-avatar-upload"
          >
            {avatar_url ? (
              <img
                src={avatar_url}
                alt={`${first_name} ${last_name}`}
                className="w-14 h-14 rounded-full object-cover"
                data-testid="img-avatar"
              />
            ) : (
              <div className="w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center text-lg font-bold text-primary">
                {first_name?.[0]}{last_name?.[0]}
              </div>
            )}
            <div className="absolute inset-0 rounded-full bg-black/40 flex items-center justify-center invisible group-hover:visible">
              {uploadingAvatar
                ? <Loader2 className="w-5 h-5 text-white animate-spin" />
                : <Pencil className="w-4 h-4 text-white" />}
            </div>
          </button>
          <h1 className="text-2xl font-bold" data-testid="text-welcome">
            Welcome back, {first_name}
          </h1>
          <p className="text-muted-foreground text-sm">
            {isMultiTenant
              ? `Your fundraising campaigns across ${uniqueTenants.length} organisations`
              : 'Here are your fundraising campaigns'
            }
          </p>
        </div>

        {campaigns.length === 0 ? (
          <Card>
            <CardContent className="pt-8 pb-8 text-center space-y-3">
              <Heart className="w-10 h-10 text-muted-foreground mx-auto" />
              <h3 className="font-medium" data-testid="text-no-campaigns">No Active Campaigns</h3>
              <p className="text-sm text-muted-foreground">
                You don't have any active fundraising campaigns at the moment.
              </p>
            </CardContent>
          </Card>
        ) : selectedCampaign ? (
          <CampaignDetailView
            campaign={selectedCampaign}
            onBack={() => setSelectedCampaignId(null)}
            getDonatePageUrl={getDonatePageUrl}
            onRefresh={refreshData}
          />
        ) : (
          <div className="space-y-4">
            <SummaryCards campaigns={campaigns} />

            {isMultiTenant ? (
              <div className="space-y-6" data-testid="campaign-list">
                {Object.entries(campaignsByTenant).map(([tenantName, tenantCampaigns]) => (
                  <div key={tenantName} className="space-y-3">
                    <div className="flex items-center gap-2 px-1">
                      <Building2 className="w-4 h-4 text-muted-foreground" />
                      <h2 className="text-sm font-semibold text-muted-foreground" data-testid={`text-tenant-group-${tenantName}`}>
                        {tenantName}
                      </h2>
                      <Badge variant="secondary" className="text-xs">{tenantCampaigns.length}</Badge>
                    </div>
                    {tenantCampaigns.map((campaign) => (
                      <CampaignTile
                        key={campaign.campaign_id}
                        campaign={campaign}
                        hasNewUpdates={hasNewUpdates(campaign)}
                        onClick={() => handleSelectCampaign(campaign.campaign_id)}
                      />
                    ))}
                  </div>
                ))}
              </div>
            ) : (
              <div className="space-y-3" data-testid="campaign-list">
                {campaigns.map((campaign) => (
                  <CampaignTile
                    key={campaign.campaign_id}
                    campaign={campaign}
                    hasNewUpdates={hasNewUpdates(campaign)}
                    onClick={() => handleSelectCampaign(campaign.campaign_id)}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        <div className="text-center pt-4">
          <Link to="/fundraiser/login" onClick={handleLogout}>
            <Button variant="ghost" size="sm" data-testid="button-logout">
              Sign in with a different email
            </Button>
          </Link>
        </div>

        {campaigns.length > 0 && campaigns[0]?.tenant_name && (
          <div className="text-center py-4 text-xs text-muted-foreground">
            <p>
              Fundraising by {campaigns[0].tenant_name} powered by{' '}
              <a
                href="https://www.isaasi.co.uk"
                target="_blank"
                rel="noopener noreferrer"
                className="hover:underline"
                data-testid="link-isupporter"
              >
                <span style={{ color: '#FF00FF' }}>i</span>supporter
              </a>
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
