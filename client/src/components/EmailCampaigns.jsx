import { useState, useMemo, useEffect, useRef, useCallback, Fragment } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { 
  Mail, Plus, Pencil, Trash2, Send, Eye, BarChart3, Copy,
  Loader2, Calendar, Clock, Users, MousePointerClick,
  CheckCircle2, TrendingUp, TestTube2, Target, MailOpen, Link2, Search,
  ChevronDown, ChevronRight, ExternalLink, Download, Square, AlertTriangle,
  RefreshCw, Monitor, Smartphone, Reply, Forward, Archive, MoreHorizontal, Star, Paperclip,
  Flame
} from "lucide-react";
import { toast } from "sonner";
import { base44 } from "@/api/base44Client";
import { ReadOnlyBlockPreview } from '@/components/email-builder/BlockRenderer';
import { defaultEmailDesign } from '@/components/email-builder/types';
import DOMPurify from 'dompurify';

export default function EmailCampaigns() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [campaignToDelete, setCampaignToDelete] = useState(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [showPreviewDialog, setShowPreviewDialog] = useState(false);
  const [previewData, setPreviewData] = useState(null);
  const [showStatsDialog, setShowStatsDialog] = useState(false);
  const [statsData, setStatsData] = useState(null);
  const [sending, setSending] = useState(false);
  const [testSending, setTestSending] = useState(false);
  const [scheduleMode, setScheduleMode] = useState(false);
  const [scheduleDateTime, setScheduleDateTime] = useState('');
  const [showTestEmailDialog, setShowTestEmailDialog] = useState(false);
  const [testEmailAddress, setTestEmailAddress] = useState('');
  const [testEmailCampaign, setTestEmailCampaign] = useState(null);
  const [testEmailMode, setTestEmailMode] = useState('manual');
  const [memberSearchQuery, setMemberSearchQuery] = useState('');
  const [memberSearchResults, setMemberSearchResults] = useState([]);
  const [searchingMembers, setSearchingMembers] = useState(false);
  const [selectedMember, setSelectedMember] = useState(null);
  const [duplicating, setDuplicating] = useState(null);
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [campaignToCancel, setCampaignToCancel] = useState(null);
  const [cancelPreviewStats, setCancelPreviewStats] = useState(null);
  const [loadingCancelPreview, setLoadingCancelPreview] = useState(false);
  const [cancelling, setCancelling] = useState(null);
  const [statsDetailView, setStatsDetailView] = useState(false);
  const [statsRecipients, setStatsRecipients] = useState([]);
  const [loadingRecipients, setLoadingRecipients] = useState(false);
  const [statsFilter, setStatsFilter] = useState(null);
  const [statsCampaignId, setStatsCampaignId] = useState(null);
  const [expandedRecipients, setExpandedRecipients] = useState(new Set());
  const [statsLinkFilter, setStatsLinkFilter] = useState(null);
  const [syncingStats, setSyncingStats] = useState(false);
  const [showEmailPreview, setShowEmailPreview] = useState(false);
  const [emailPreviewData, setEmailPreviewData] = useState(null);
  const [emailPreviewLoading, setEmailPreviewLoading] = useState(false);
  const [emailPreviewMode, setEmailPreviewMode] = useState('desktop');
  const [emailPreviewFooter, setEmailPreviewFooter] = useState(null);
  const [emailPreviewHeatmap, setEmailPreviewHeatmap] = useState(null);
  const heatmapPreviewRef = useRef(null);

  const { data: campaigns = [], isLoading: campaignsLoading } = useQuery({
    queryKey: ['email-campaigns'],
    queryFn: async () => {
      const response = await fetch('/api/email-campaigns', { credentials: 'include' });
      if (!response.ok) throw new Error('Failed to fetch campaigns');
      return response.json();
    },
    staleTime: 30000,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (Array.isArray(data) && data.some(c => c.status === 'sending')) {
        return 5000;
      }
      return false;
    }
  });

  const { data: categories = [] } = useQuery({
    queryKey: ['communication-categories'],
    queryFn: async () => {
      try {
        return await base44.entities.CommunicationCategory.list();
      } catch (e) {
        return [];
      }
    }
  });

  const { data: memberGroups = [] } = useQuery({
    queryKey: ['member-groups'],
    queryFn: async () => {
      try {
        return await base44.entities.MemberGroup.list();
      } catch (e) {
        return [];
      }
    }
  });

  const { data: roles = [] } = useQuery({
    queryKey: ['roles'],
    queryFn: async () => {
      try {
        return await base44.entities.Role.list();
      } catch (e) {
        return [];
      }
    }
  });

  const stats = useMemo(() => {
    const sentCampaigns = campaigns.filter(c => c.status === 'sent');
    const totalSent = sentCampaigns.reduce((sum, c) => sum + (c.sent_count || 0), 0);
    const totalOpened = sentCampaigns.reduce((sum, c) => sum + (c.opened_count || 0), 0);
    const totalClicked = sentCampaigns.reduce((sum, c) => sum + (c.clicked_count || 0), 0);
    const avgOpenRate = totalSent > 0 ? ((totalOpened / totalSent) * 100).toFixed(1) : 0;
    const avgClickRate = totalSent > 0 ? ((totalClicked / totalSent) * 100).toFixed(1) : 0;
    const draftCount = campaigns.filter(c => c.status === 'draft').length;
    const scheduledCount = campaigns.filter(c => c.status === 'scheduled').length;

    return {
      totalCampaigns: campaigns.length,
      sentCampaigns: sentCampaigns.length,
      totalSent,
      totalOpened,
      totalClicked,
      avgOpenRate,
      avgClickRate,
      draftCount,
      scheduledCount
    };
  }, [campaigns]);

  // Member search for test emails with debouncing
  useEffect(() => {
    if (!memberSearchQuery || memberSearchQuery.length < 2) {
      setMemberSearchResults([]);
      return;
    }

    const searchController = new AbortController();
    const debounceTimer = setTimeout(async () => {
      setSearchingMembers(true);
      try {
        const response = await fetch(`/api/members/search?q=${encodeURIComponent(memberSearchQuery)}&limit=10`, {
          credentials: 'include',
          signal: searchController.signal
        });
        
        if (response.ok) {
          const results = await response.json();
          setMemberSearchResults(results);
        }
      } catch (e) {
        if (e.name !== 'AbortError') {
          console.error('Failed to search members:', e);
          setMemberSearchResults([]);
        }
      } finally {
        setSearchingMembers(false);
      }
    }, 300);

    return () => {
      clearTimeout(debounceTimer);
      searchController.abort();
    };
  }, [memberSearchQuery]);

  const handleMemberSearchInput = (query) => {
    setMemberSearchQuery(query);
    setSelectedMember(null);
  };

  const handleSelectMember = (member) => {
    setSelectedMember(member);
    setTestEmailAddress(member.email);
    setMemberSearchQuery(`${member.first_name || ''} ${member.last_name || ''} <${member.email}>`);
    setMemberSearchResults([]);
  };

  const handleDeleteCampaign = async () => {
    if (!campaignToDelete || isDeleting) return;

    setIsDeleting(true);
    try {
      const response = await fetch(`/api/email-campaigns/${campaignToDelete.id}`, {
        method: 'DELETE',
        credentials: 'include'
      });

      if (!response.ok) throw new Error('Failed to delete campaign');

      toast.success('Campaign deleted');
      queryClient.invalidateQueries({ queryKey: ['email-campaigns'] });
      setShowDeleteConfirm(false);
      setCampaignToDelete(null);
    } catch (error) {
      toast.error(error.message);
    } finally {
      setIsDeleting(false);
    }
  };

  const handleDuplicateCampaign = async (campaign) => {
    setDuplicating(campaign.id);
    try {
      const response = await fetch(`/api/email-campaigns/${campaign.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ action: 'duplicate' })
      });

      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || 'Failed to duplicate campaign');
      }

      const newCampaign = await response.json();
      toast.success('Campaign duplicated');
      queryClient.invalidateQueries({ queryKey: ['email-campaigns'] });
      navigate(`/EmailCampaignEdit/${newCampaign.id}`);
    } catch (error) {
      toast.error(error.message);
    } finally {
      setDuplicating(null);
    }
  };

  const handleOpenCancelDialog = async (campaign) => {
    setCampaignToCancel(campaign);
    setCancelPreviewStats(null);
    setShowCancelConfirm(true);

    if (campaign.status === 'sending') {
      setLoadingCancelPreview(true);
      try {
        const response = await fetch(`/api/email-campaigns/${campaign.id}?stats=true`, {
          credentials: 'include'
        });
        if (response.ok) {
          const data = await response.json();
          const sent = data.stats?.sent || 0;
          const total = data.stats?.total || 0;
          const pending = total - sent - (data.stats?.bounced || 0) - (data.stats?.failed || 0);
          setCancelPreviewStats({ sent, pending: Math.max(0, pending), total });
        }
      } catch (e) {
        // Stats are informational — dialog still works without them
      } finally {
        setLoadingCancelPreview(false);
      }
    }
  };

  const handleCancelCampaign = async () => {
    if (!campaignToCancel) return;
    setCancelling(campaignToCancel.id);
    setShowCancelConfirm(false);
    try {
      const response = await fetch(`/api/email-campaigns/${campaignToCancel.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ action: 'cancel' })
      });

      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || 'Failed to cancel campaign');
      }

      const result = await response.json();
      toast.success(`Campaign stopped. ${result.alreadySent} emails already sent, ${result.cancelledRecipients} cancelled.`);
      queryClient.invalidateQueries({ queryKey: ['email-campaigns'] });
    } catch (error) {
      toast.error(error.message);
    } finally {
      setCancelling(null);
      setCampaignToCancel(null);
      setCancelPreviewStats(null);
    }
  };

  const handlePreviewRecipients = async (campaign) => {
    try {
      const response = await fetch('/api/email-campaigns/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ campaignId: campaign.id, preview: true })
      });

      if (!response.ok) throw new Error('Failed to preview recipients');

      const data = await response.json();
      setPreviewData({ campaign, ...data });
      setShowPreviewDialog(true);
    } catch (error) {
      toast.error(error.message);
    }
  };

  const handleTestSend = async (campaign, testEmail) => {
    if (testSending) return;
    setTestSending(true);

    try {
      const response = await fetch('/api/email-campaigns/test-send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ campaignId: campaign.id, testEmail })
      });

      const data = await response.json();
      
      if (!response.ok) {
        throw new Error(data.error || 'Failed to send test email');
      }

      toast.success(data.message || `Test email sent to ${testEmail}`);
    } catch (error) {
      toast.error(error.message);
    } finally {
      setTestSending(false);
    }
  };

  const handleSendCampaign = async (campaign) => {
    if (sending) return;
    setSending(true);

    try {
      const response = await fetch('/api/email-campaigns/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ campaignId: campaign.id })
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to send campaign');
      }

      const result = await response.json();
      if (result.status === 'sending') {
        toast.success(`Campaign sending started — ${result.sent} of ${result.totalRecipients} sent so far. The rest will be sent automatically.`);
      } else {
        toast.success(`Campaign sent to ${result.sent || result.totalRecipients} recipients`);
      }
      queryClient.invalidateQueries({ queryKey: ['email-campaigns'] });
      setShowPreviewDialog(false);
    } catch (error) {
      toast.error(error.message);
    } finally {
      setSending(false);
    }
  };

  const handleScheduleCampaign = async (campaign, scheduledAtLocal) => {
    if (sending) return;
    setSending(true);

    try {
      const scheduledAtUTC = new Date(scheduledAtLocal).toISOString();
      
      const response = await fetch('/api/email-campaigns/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ campaignId: campaign.id, scheduledAt: scheduledAtUTC })
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to schedule campaign');
      }

      toast.success(`Campaign scheduled for ${new Date(scheduledAtLocal).toLocaleString()}`);
      queryClient.invalidateQueries({ queryKey: ['email-campaigns'] });
      setShowPreviewDialog(false);
      setScheduleMode(false);
      setScheduleDateTime('');
    } catch (error) {
      toast.error(error.message);
    } finally {
      setSending(false);
    }
  };

  const handleEmailPreview = async (campaign) => {
    setShowEmailPreview(true);
    setEmailPreviewLoading(true);
    setEmailPreviewData(null);
    setEmailPreviewFooter(null);
    setEmailPreviewHeatmap(null);
    setEmailPreviewMode('desktop');
    try {
      const [campaignRes, footerRes] = await Promise.all([
        fetch(`/api/email-campaigns/${campaign.id}`, { credentials: 'include' }),
        fetch('/api/email-campaigns/preview-footer', { credentials: 'include' })
      ]);
      if (!campaignRes.ok) throw new Error('Failed to fetch campaign');
      const campaignData = await campaignRes.json();
      let parsedDesign = campaignData.design_json;
      if (typeof parsedDesign === 'string') {
        try {
          parsedDesign = JSON.parse(parsedDesign);
        } catch (e) {
          parsedDesign = null;
        }
      }
      const hasDesign = parsedDesign && typeof parsedDesign === 'object' &&
        (parsedDesign.type === 'custom-email-builder' || Array.isArray(parsedDesign.blocks));
      if (hasDesign) {
        parsedDesign = {
          ...parsedDesign,
          globalStyles: {
            ...defaultEmailDesign.globalStyles,
            ...(parsedDesign.globalStyles || {}),
          },
        };
      }
      campaignData.design_json = hasDesign ? parsedDesign : null;
      setEmailPreviewData(campaignData);
      if (footerRes.ok) {
        const footerData = await footerRes.json();
        setEmailPreviewFooter(footerData);
      }
    } catch (error) {
      toast.error('Failed to load email preview');
      setShowEmailPreview(false);
    } finally {
      setEmailPreviewLoading(false);
    }
  };

  const handleHeatmapPreview = async () => {
    if (!statsCampaignId || !statsData?.heatmapData) return;
    setShowEmailPreview(true);
    setEmailPreviewLoading(true);
    setEmailPreviewData(null);
    setEmailPreviewFooter(null);
    setEmailPreviewHeatmap(statsData.heatmapData);
    setEmailPreviewMode('desktop');
    try {
      const [campaignRes, footerRes] = await Promise.all([
        fetch(`/api/email-campaigns/${statsCampaignId}`, { credentials: 'include' }),
        fetch('/api/email-campaigns/preview-footer', { credentials: 'include' })
      ]);
      if (!campaignRes.ok) throw new Error('Failed to fetch campaign');
      const campaignData = await campaignRes.json();
      let parsedDesign = campaignData.design_json;
      if (typeof parsedDesign === 'string') {
        try { parsedDesign = JSON.parse(parsedDesign); } catch (e) { parsedDesign = null; }
      }
      const hasDesign = parsedDesign && typeof parsedDesign === 'object' &&
        (parsedDesign.type === 'custom-email-builder' || Array.isArray(parsedDesign.blocks));
      if (hasDesign) {
        parsedDesign = {
          ...parsedDesign,
          globalStyles: { ...defaultEmailDesign.globalStyles, ...(parsedDesign.globalStyles || {}) },
        };
      }
      campaignData.design_json = hasDesign ? parsedDesign : null;
      setEmailPreviewData(campaignData);
      if (footerRes.ok) {
        const footerData = await footerRes.json();
        setEmailPreviewFooter(footerData);
      }
    } catch (error) {
      toast.error('Failed to load email preview');
      setShowEmailPreview(false);
      setEmailPreviewHeatmap(null);
    } finally {
      setEmailPreviewLoading(false);
    }
  };

  const normalizeUrl = useCallback((rawUrl) => {
    if (!rawUrl || typeof rawUrl !== 'string') return '';
    try {
      const parsed = new URL(rawUrl);
      return (parsed.origin + parsed.pathname).replace(/\/+$/, '').toLowerCase();
    } catch {
      return rawUrl.replace(/\/+$/, '').toLowerCase();
    }
  }, []);

  const heatmapClickMap = useMemo(() => {
    if (!emailPreviewHeatmap || emailPreviewHeatmap.length === 0) return null;
    const map = {};
    emailPreviewHeatmap.forEach(item => {
      if (!item || typeof item.url !== 'string') return;
      const clicks = typeof item.clicks === 'number' ? item.clicks : 0;
      const normalized = normalizeUrl(item.url);
      if (normalized) {
        map[normalized] = (map[normalized] || 0) + clicks;
      }
    });
    return map;
  }, [emailPreviewHeatmap, normalizeUrl]);

  const applyHeatmapOverlay = useCallback(() => {
    if (!heatmapPreviewRef.current || !heatmapClickMap) return;

    const container = heatmapPreviewRef.current;
    container.querySelectorAll('[data-heatmap-badge]').forEach(el => el.remove());

    const links = container.querySelectorAll('a[href]');
    if (links.length === 0) return;

    const aggregatedValues = Object.values(heatmapClickMap);
    const maxClicks = Math.max(...aggregatedValues, 1);

    links.forEach(link => {
      const rawHref = link.getAttribute('href') || '';
      if (!rawHref || rawHref === '#' || rawHref.startsWith('mailto:') || rawHref.startsWith('tel:')) return;

      const normalizedHref = normalizeUrl(rawHref);
      const clicks = heatmapClickMap[normalizedHref];
      if (clicks === undefined) return;

      const intensity = maxClicks > 0 ? clicks / maxClicks : 0;

      let bgColor, textColor, borderColor;
      if (clicks === 0) {
        bgColor = 'rgba(148, 163, 184, 0.15)';
        textColor = 'rgb(100, 116, 139)';
        borderColor = 'rgba(148, 163, 184, 0.3)';
      } else if (intensity <= 0.25) {
        bgColor = 'rgba(59, 130, 246, 0.15)';
        textColor = 'rgb(37, 99, 235)';
        borderColor = 'rgba(59, 130, 246, 0.3)';
      } else if (intensity <= 0.5) {
        bgColor = 'rgba(34, 197, 94, 0.2)';
        textColor = 'rgb(22, 163, 74)';
        borderColor = 'rgba(34, 197, 94, 0.4)';
      } else if (intensity <= 0.75) {
        bgColor = 'rgba(249, 115, 22, 0.2)';
        textColor = 'rgb(234, 88, 12)';
        borderColor = 'rgba(249, 115, 22, 0.4)';
      } else {
        bgColor = 'rgba(239, 68, 68, 0.2)';
        textColor = 'rgb(220, 38, 38)';
        borderColor = 'rgba(239, 68, 68, 0.4)';
      }

      const badge = document.createElement('span');
      badge.setAttribute('data-heatmap-badge', 'true');
      badge.textContent = `${clicks} click${clicks !== 1 ? 's' : ''}`;
      badge.style.cssText = `
        display: inline-flex;
        align-items: center;
        margin-left: 4px;
        padding: 1px 6px;
        font-size: 10px;
        font-weight: 600;
        line-height: 16px;
        border-radius: 9999px;
        white-space: nowrap;
        vertical-align: middle;
        background: ${bgColor};
        color: ${textColor};
        border: 1px solid ${borderColor};
        pointer-events: none;
      `;
      link.style.position = 'relative';
      link.insertAdjacentElement('afterend', badge);
    });
  }, [heatmapClickMap, normalizeUrl]);

  useEffect(() => {
    if (!showEmailPreview || !heatmapClickMap || !emailPreviewData || emailPreviewLoading) return;

    const timer = setTimeout(applyHeatmapOverlay, 100);

    let observer;
    let debounceTimer;
    let isApplying = false;
    if (heatmapPreviewRef.current) {
      observer = new MutationObserver((mutations) => {
        if (isApplying) return;
        const isOnlyBadgeChange = mutations.every(m =>
          [...m.addedNodes, ...m.removedNodes].every(n =>
            n.nodeType === 1 && n.getAttribute && n.getAttribute('data-heatmap-badge')
          )
        );
        if (isOnlyBadgeChange) return;
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          isApplying = true;
          applyHeatmapOverlay();
          isApplying = false;
        }, 150);
      });
      observer.observe(heatmapPreviewRef.current, { childList: true, subtree: true });
    }

    return () => {
      clearTimeout(timer);
      clearTimeout(debounceTimer);
      if (observer) observer.disconnect();
    };
  }, [showEmailPreview, heatmapClickMap, emailPreviewData, emailPreviewLoading, emailPreviewMode, applyHeatmapOverlay]);

  const handleViewStats = async (campaign) => {
    try {
      const statsResponse = await fetch(`/api/email-campaigns/${campaign.id}?stats=true`, {
        credentials: 'include'
      });

      if (!statsResponse.ok) throw new Error('Failed to fetch campaign stats');

      const result = await statsResponse.json();
      const stats = result.stats || {};
      const campaignData = result.campaign || campaign;
      
      let heatmapData = [];
      if (stats.clicked > 0) {
        const heatmapResponse = await fetch(`/api/email-campaigns/${campaign.id}?heatmap=true`, {
          credentials: 'include'
        });
        if (heatmapResponse.ok) {
          const heatmapResult = await heatmapResponse.json();
          heatmapData = heatmapResult.heatmapData || [];
        }
      }

      setStatsCampaignId(campaign.id);
      setStatsDetailView(false);
      setStatsRecipients([]);
      setStatsFilter(null);
      setStatsData({
        name: campaignData.name,
        sent: stats.sent || 0,
        sent_only: stats.sent_only || 0,
        delivered: stats.delivered || 0,
        opened: stats.opened || 0,
        clicked: stats.clicked || 0,
        bounced: stats.bounced || 0,
        unsubscribed: stats.unsubscribed || 0,
        complained: stats.complained || 0,
        openRate: stats.openRate || 0,
        clickRate: stats.clickRate || 0,
        bounceRate: stats.bounceRate || 0,
        total: stats.total || 0,
        heatmapData
      });
      setShowStatsDialog(true);
    } catch (error) {
      toast.error(error.message);
    }
  };

  const handleShowDetails = async () => {
    if (!statsCampaignId) return;
    setLoadingRecipients(true);
    try {
      const response = await fetch(`/api/email-campaigns/${statsCampaignId}?recipients=true`, {
        credentials: 'include'
      });
      if (!response.ok) throw new Error('Failed to fetch recipient details');
      const result = await response.json();
      setStatsRecipients(result.recipients || []);
      setStatsDetailView(true);
      setStatsFilter(null);
      setStatsLinkFilter(null);
      setExpandedRecipients(new Set());
    } catch (error) {
      toast.error(error.message);
    } finally {
      setLoadingRecipients(false);
    }
  };

  const getFilteredRecipients = () => {
    let filtered = statsRecipients;
    if (statsFilter) {
      filtered = filtered.filter(r => {
        switch (statsFilter) {
          case 'sent':
            return r.status === 'sent' || r.status === 'delivered' || r.status === 'opened' || r.status === 'clicked';
          case 'delivered':
            return r.status === 'delivered' || r.status === 'opened' || r.status === 'clicked';
          case 'opened':
            return r.status === 'opened' || r.status === 'clicked' || r.open_count > 0;
          case 'clicked':
            return r.status === 'clicked' || r.click_count > 0;
          case 'bounced':
            return r.status === 'bounced';
          case 'unsubscribed':
            return r.status === 'unsubscribed';
          case 'complained':
            return r.status === 'complained';
          case 'failed':
            return r.status === 'failed';
          default:
            return true;
        }
      });
    }
    if (statsLinkFilter) {
      filtered = filtered.filter(r =>
        r.link_clicks && r.link_clicks.some(c => c.url === statsLinkFilter)
      );
    }
    return filtered;
  };

  const handleExportStatsCSV = () => {
    if (!statsData) return;
    const rows = [];
    const escapeCell = (val) => {
      if (val == null) return '';
      let str = String(val);
      if (/^[=+\-@\t\r]/.test(str)) {
        str = "'" + str;
      }
      if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return '"' + str.replace(/"/g, '""') + '"';
      }
      return str;
    };

    rows.push(['Campaign Statistics']);
    rows.push(['Campaign', statsData.name]);
    rows.push([]);
    rows.push(['Metric', 'Count']);
    rows.push(['Sent', statsData.sent]);
    rows.push(['Delivered', statsData.delivered]);
    rows.push(['Opened', statsData.opened]);
    rows.push(['Clicked', statsData.clicked]);
    rows.push(['Bounced', statsData.bounced]);
    rows.push(['Unsubscribed', statsData.unsubscribed]);
    rows.push(['Complaints', statsData.complained]);

    if (statsData.heatmapData && statsData.heatmapData.length > 0) {
      rows.push([]);
      rows.push(['Link Click Heatmap']);
      rows.push(['URL', 'Clicks']);
      statsData.heatmapData.forEach(link => {
        rows.push([link.url, link.clicks]);
      });
    }

    if (statsDetailView && statsRecipients.length > 0) {
      const recipients = getFilteredRecipients();
      rows.push([]);
      const title = 'Recipients' +
        (statsFilter ? ` (filtered: ${statsFilter})` : '') +
        (statsLinkFilter ? ` (link: ${statsLinkFilter})` : '');
      rows.push([title]);
      rows.push(['Email', 'Status', 'Opens', 'Clicks', 'Sent At']);
      recipients.forEach(r => {
        rows.push([
          r.email,
          r.status,
          r.open_count || 0,
          r.click_count || 0,
          r.sent_at ? new Date(r.sent_at).toISOString() : ''
        ]);
      });
    }

    const csvContent = rows.map(row => row.map(escapeCell).join(',')).join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    const safeName = (statsData.name || 'campaign').replace(/[^a-z0-9]/gi, '-').toLowerCase();
    link.download = `campaign-stats-${safeName}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.URL.revokeObjectURL(url);
  };

  const handleSyncMailgunEvents = async () => {
    if (!statsCampaignId) return;
    setSyncingStats(true);
    try {
      const response = await fetch('/api/functions/sync-mailgun-events', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ campaignId: statsCampaignId })
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || 'Failed to sync events');
      }

      const result = await response.json();
      const { summary } = result;
      toast.success(`Sync complete: ${summary.processed} events processed, ${summary.skipped} skipped`);

      const campaign = campaigns.find(c => c.id === statsCampaignId);
      if (campaign) {
        await handleViewStats(campaign);
      }
      queryClient.invalidateQueries({ queryKey: ['email-campaigns'] });
    } catch (error) {
      toast.error(error.message);
    } finally {
      setSyncingStats(false);
    }
  };

  const toggleRecipientExpand = (recipientId) => {
    setExpandedRecipients(prev => {
      const next = new Set(prev);
      if (next.has(recipientId)) {
        next.delete(recipientId);
      } else {
        next.add(recipientId);
      }
      return next;
    });
  };

  const getStatusBadge = (status) => {
    const statusConfig = {
      draft: { label: 'Draft', variant: 'secondary' },
      scheduled: { label: 'Scheduled', variant: 'outline', className: 'border-blue-500 text-blue-600' },
      sending: { label: 'Sending', variant: 'outline', className: 'border-amber-500 text-amber-600' },
      sent: { label: 'Sent', variant: 'outline', className: 'border-green-500 text-green-600' },
      failed: { label: 'Failed', variant: 'destructive' },
      cancelled: { label: 'Cancelled', variant: 'secondary' }
    };

    const config = statusConfig[status] || statusConfig.draft;
    return <Badge variant={config.variant} className={config.className}>{config.label}</Badge>;
  };

  const getSegmentLabel = (type, ids) => {
    const typeLabels = {
      communication_category: 'Categories',
      member_group: 'Groups',
      role: 'Roles',
      form: 'Forms',
      fundraisers: 'Fundraisers',
      donors: 'Donors',
      all_members: 'All Members'
    };
    if (type === 'all_members') return 'All Members';
    let names = [];
    if (type === 'communication_category') {
      names = (ids || []).map(id => categories.find(c => c.id === id)?.name).filter(Boolean);
    } else if (type === 'member_group') {
      names = (ids || []).map(id => memberGroups.find(g => g.id === id)?.name).filter(Boolean);
    } else if (type === 'role') {
      names = (ids || []).map(id => roles.find(r => r.id === id)?.name).filter(Boolean);
    }
    if (names.length > 0) return `${typeLabels[type] || type}: ${names.join(', ')}`;
    return typeLabels[type] || type;
  };

  const getTargetLabel = (campaign) => {
    const audiences = campaign.target_audiences;
    if (Array.isArray(audiences) && audiences.length > 0) {
      return audiences.map(a => getSegmentLabel(a.type, a.ids)).join(' + ');
    }
    return getSegmentLabel(campaign.target_type, campaign.target_ids);
  };

  const formatDate = (dateStr) => {
    if (!dateStr) return '-';
    return new Date(dateStr).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    });
  };

  const recentCampaigns = campaigns.slice(0, 10);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Email Campaigns</h1>
          <p className="text-muted-foreground">
            Create, send, and track email campaigns to engage your members
          </p>
        </div>
        <Button 
          onClick={() => navigate('/EmailCampaignEdit/new')}
          size="lg"
          data-testid="button-create-campaign"
        >
          <Plus className="w-5 h-5 mr-2" />
          Create Campaign
        </Button>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card data-testid="stat-campaigns-sent">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Campaigns Sent</CardTitle>
            <Send className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.sentCampaigns}</div>
            <p className="text-xs text-muted-foreground">
              {stats.draftCount} drafts, {stats.scheduledCount} scheduled
            </p>
          </CardContent>
        </Card>

        <Card data-testid="stat-emails-delivered">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Emails Delivered</CardTitle>
            <Mail className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.totalSent.toLocaleString()}</div>
            <p className="text-xs text-muted-foreground">
              Total emails sent to recipients
            </p>
          </CardContent>
        </Card>

        <Card data-testid="stat-open-rate">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Open Rate</CardTitle>
            <MailOpen className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.avgOpenRate}%</div>
            <p className="text-xs text-muted-foreground">
              {stats.totalOpened.toLocaleString()} total opens
            </p>
          </CardContent>
        </Card>

        <Card data-testid="stat-click-rate">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Click Rate</CardTitle>
            <Link2 className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.avgClickRate}%</div>
            <p className="text-xs text-muted-foreground">
              {stats.totalClicked.toLocaleString()} total clicks
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-4">
          <div>
            <CardTitle>Recent Campaigns</CardTitle>
            <p className="text-sm text-muted-foreground mt-1">
              Your most recent email campaigns and their performance
            </p>
          </div>
        </CardHeader>
        <CardContent>
          {campaignsLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-6 h-6 animate-spin text-blue-600" />
            </div>
          ) : campaigns.length === 0 ? (
            <div className="text-center py-12 border-2 border-dashed rounded-lg">
              <Mail className="w-12 h-12 text-muted-foreground/50 mx-auto mb-4" />
              <h3 className="text-lg font-medium mb-2">No Campaigns Yet</h3>
              <p className="text-muted-foreground mb-4 max-w-sm mx-auto">
                Create your first email campaign to start engaging with your members
              </p>
              <Button 
                onClick={() => navigate('/EmailCampaignEdit/new')}
                data-testid="button-create-first-campaign"
              >
                <Plus className="w-4 h-4 mr-2" />
                Create First Campaign
              </Button>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Campaign</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Audience</TableHead>
                    <TableHead className="text-right">Sent</TableHead>
                    <TableHead className="text-right">Opens</TableHead>
                    <TableHead className="text-right">Clicks</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {recentCampaigns.map((campaign) => {
                    const openRate = campaign.sent_count > 0 
                      ? ((campaign.opened_count || 0) / campaign.sent_count * 100).toFixed(1)
                      : 0;
                    const clickRate = campaign.sent_count > 0 
                      ? ((campaign.clicked_count || 0) / campaign.sent_count * 100).toFixed(1)
                      : 0;

                    return (
                      <TableRow key={campaign.id} data-testid={`row-campaign-${campaign.id}`}>
                        <TableCell>
                          <div>
                            <div className="font-medium">{campaign.name}</div>
                            <div className="text-sm text-muted-foreground truncate max-w-[200px]">
                              {campaign.subject}
                            </div>
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-col gap-1">
                            <div className="flex items-center gap-1 flex-wrap">
                              {getStatusBadge(campaign.status)}
                              {campaign.is_test_mode && (
                                <Badge variant="outline" className="border-blue-500 text-blue-600" data-testid={`badge-test-mode-${campaign.id}`}>
                                  <TestTube2 className="w-3 h-3 mr-1" />
                                  Test
                                </Badge>
                              )}
                            </div>
                            {campaign.status === 'sending' && campaign.total_recipients > 0 && (
                              <span className="text-xs text-amber-600" data-testid={`text-sending-progress-${campaign.id}`}>
                                {campaign.sent_count || 0} / {campaign.total_recipients} sent
                              </span>
                            )}
                            {campaign.status === 'scheduled' && campaign.scheduled_at && (
                              <span className="text-xs text-muted-foreground">
                                {formatDate(campaign.scheduled_at)}
                              </span>
                            )}
                            {campaign.status === 'sent' && campaign.sent_at && (
                              <span className="text-xs text-muted-foreground">
                                {formatDate(campaign.sent_at)}
                              </span>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1">
                            <Target className="w-3 h-3 text-muted-foreground" />
                            <span className="text-sm truncate max-w-[120px]">
                              {getTargetLabel(campaign)}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell className="text-right font-medium">
                          {campaign.status === 'sending' && campaign.total_recipients > 0
                            ? `${campaign.sent_count || 0} / ${campaign.total_recipients}`
                            : (campaign.sent_count || '-')}
                        </TableCell>
                        <TableCell className="text-right">
                          {campaign.status === 'sent' ? (
                            <div>
                              <span className="font-medium">{campaign.opened_count || 0}</span>
                              <span className="text-muted-foreground text-xs ml-1">
                                ({openRate}%)
                              </span>
                            </div>
                          ) : '-'}
                        </TableCell>
                        <TableCell className="text-right">
                          {campaign.status === 'sent' ? (
                            <div>
                              <span className="font-medium">{campaign.clicked_count || 0}</span>
                              <span className="text-muted-foreground text-xs ml-1">
                                ({clickRate}%)
                              </span>
                            </div>
                          ) : '-'}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-1">
                            {campaign.status === 'draft' && (
                              <>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  onClick={() => navigate(`/EmailCampaignEdit/${campaign.id}`)}
                                  title="Edit"
                                  data-testid={`button-edit-${campaign.id}`}
                                >
                                  <Pencil className="w-4 h-4" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  onClick={() => {
                                    setTestEmailCampaign(campaign);
                                    setTestEmailAddress('');
                                    setShowTestEmailDialog(true);
                                  }}
                                  disabled={testSending}
                                  title="Send Test"
                                  data-testid={`button-test-${campaign.id}`}
                                >
                                  <TestTube2 className="w-4 h-4" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  onClick={() => handlePreviewRecipients(campaign)}
                                  title="Preview & Send"
                                  data-testid={`button-preview-${campaign.id}`}
                                >
                                  <Send className="w-4 h-4" />
                                </Button>
                              </>
                            )}
                            {(campaign.status === 'sending' || campaign.status === 'scheduled') && (
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => handleOpenCancelDialog(campaign)}
                                disabled={cancelling === campaign.id}
                                title="Stop Campaign"
                                className="text-destructive hover:text-destructive"
                                data-testid={`button-cancel-${campaign.id}`}
                              >
                                {cancelling === campaign.id ? (
                                  <Loader2 className="w-4 h-4 animate-spin" />
                                ) : (
                                  <Square className="w-4 h-4" />
                                )}
                              </Button>
                            )}
                            {campaign.status === 'sent' && (
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => handleEmailPreview(campaign)}
                                title="Preview Email"
                                data-testid={`button-preview-email-${campaign.id}`}
                              >
                                <Eye className="w-4 h-4" />
                              </Button>
                            )}
                            {campaign.status === 'sent' && (
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => handleViewStats(campaign)}
                                title="View Statistics"
                                data-testid={`button-stats-${campaign.id}`}
                              >
                                <BarChart3 className="w-4 h-4" />
                              </Button>
                            )}
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => handleDuplicateCampaign(campaign)}
                              disabled={duplicating === campaign.id}
                              title="Duplicate"
                              data-testid={`button-duplicate-${campaign.id}`}
                            >
                              {duplicating === campaign.id ? (
                                <Loader2 className="w-4 h-4 animate-spin" />
                              ) : (
                                <Copy className="w-4 h-4" />
                              )}
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => {
                                setCampaignToDelete(campaign);
                                setShowDeleteConfirm(true);
                              }}
                              title="Delete"
                              className="text-destructive hover:text-destructive"
                              data-testid={`button-delete-${campaign.id}`}
                            >
                              <Trash2 className="w-4 h-4" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Campaign</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete "{campaignToDelete?.name}"? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDeleteConfirm(false)} disabled={isDeleting}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDeleteCampaign} disabled={isDeleting} data-testid="button-confirm-delete">
              {isDeleting ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Deleting...</> : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showCancelConfirm} onOpenChange={setShowCancelConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-destructive" />
              Stop Campaign
            </DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-3">
                <p>
                  Are you sure you want to stop "{campaignToCancel?.name}"?
                </p>
                {campaignToCancel?.status === 'sending' && (
                  <>
                    <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
                      This campaign is currently sending. Some emails may have already been delivered.
                      Stopping will cancel all remaining unsent emails.
                    </div>
                    {loadingCancelPreview ? (
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Loader2 className="w-4 h-4 animate-spin" />
                        Loading delivery status...
                      </div>
                    ) : cancelPreviewStats ? (
                      <div className="rounded-md border p-3 text-sm space-y-1">
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Already sent:</span>
                          <span className="font-medium">{cancelPreviewStats.sent} emails</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Will be cancelled:</span>
                          <span className="font-medium text-destructive">{cancelPreviewStats.pending} emails</span>
                        </div>
                        <div className="flex justify-between border-t pt-1 mt-1">
                          <span className="text-muted-foreground">Total recipients:</span>
                          <span className="font-medium">{cancelPreviewStats.total}</span>
                        </div>
                      </div>
                    ) : campaignToCancel?.total_recipients ? (
                      <div className="rounded-md border p-3 text-sm">
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Total recipients:</span>
                          <span className="font-medium">{campaignToCancel.total_recipients}</span>
                        </div>
                      </div>
                    ) : null}
                  </>
                )}
                {campaignToCancel?.status === 'scheduled' && (
                  <p className="text-muted-foreground">
                    This campaign is scheduled but has not started sending yet. No emails have been sent.
                    {campaignToCancel.total_recipients ? ` ${campaignToCancel.total_recipients} emails will be cancelled.` : ''}
                  </p>
                )}
              </div>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setShowCancelConfirm(false); setCampaignToCancel(null); }} data-testid="button-cancel-stop-dismiss">
              Keep Running
            </Button>
            <Button variant="destructive" onClick={handleCancelCampaign} data-testid="button-cancel-stop-confirm">
              <Square className="w-4 h-4 mr-2" />
              Stop Campaign
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showPreviewDialog} onOpenChange={(open) => {
        setShowPreviewDialog(open);
        if (!open) {
          setScheduleMode(false);
          setScheduleDateTime('');
        }
      }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Send Campaign</DialogTitle>
            <DialogDescription>
              Review recipients before sending "{previewData?.campaign?.name}"
            </DialogDescription>
          </DialogHeader>
          
          {previewData && (
            <div className="space-y-4">
              <div className="bg-muted/50 rounded-lg p-4">
                <div className="flex items-center gap-2 mb-2">
                  <Users className="w-5 h-5 text-blue-600" />
                  <span className="font-semibold text-lg">
                    {previewData.recipientCount} Recipients
                  </span>
                </div>
                <p className="text-sm text-muted-foreground">
                  This campaign will be sent to all eligible members who haven't unsubscribed
                </p>
              </div>

              {previewData.recipients && previewData.recipients.length > 0 && (
                <div className="max-h-48 overflow-y-auto border rounded-md">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Name</TableHead>
                        <TableHead>Email</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {previewData.recipients.slice(0, 20).map((r, i) => (
                        <TableRow key={i}>
                          <TableCell className="text-sm">{r.name}</TableCell>
                          <TableCell className="text-sm text-muted-foreground">{r.email}</TableCell>
                        </TableRow>
                      ))}
                      {previewData.recipients.length > 20 && (
                        <TableRow>
                          <TableCell colSpan={2} className="text-center text-sm text-muted-foreground">
                            ... and {previewData.recipients.length - 20} more
                          </TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                </div>
              )}

              {previewData?.campaign?.is_test_mode && (
                <div className="rounded-lg border border-blue-200 bg-blue-50 dark:border-blue-800 dark:bg-blue-950 p-3 flex items-start gap-2">
                  <TestTube2 className="w-4 h-4 mt-0.5 text-blue-600 shrink-0" />
                  <div className="text-sm text-blue-800 dark:text-blue-200">
                    <span className="font-semibold">Test Mode</span> — No emails will be delivered. The full pipeline will run but Mailgun will not send any messages.
                  </div>
                </div>
              )}

              {scheduleMode ? (
                <div className="space-y-3 pt-2 border-t">
                  <Label htmlFor="schedule-datetime">Schedule Date & Time</Label>
                  <Input
                    id="schedule-datetime"
                    type="datetime-local"
                    value={scheduleDateTime}
                    onChange={(e) => setScheduleDateTime(e.target.value)}
                    min={new Date().toISOString().slice(0, 16)}
                    data-testid="input-schedule-datetime"
                  />
                </div>
              ) : null}
            </div>
          )}

          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={() => setShowPreviewDialog(false)}>
              Cancel
            </Button>
            {!scheduleMode ? (
              <>
                <Button 
                  variant="outline"
                  onClick={() => setScheduleMode(true)}
                  data-testid="button-schedule-mode"
                >
                  <Clock className="w-4 h-4 mr-2" />
                  Schedule
                </Button>
                <Button 
                  onClick={() => handleSendCampaign(previewData?.campaign)}
                  disabled={sending || !previewData?.recipientCount}
                  data-testid="button-confirm-send"
                >
                  {sending ? (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  ) : (
                    <Send className="w-4 h-4 mr-2" />
                  )}
                  Send Now
                </Button>
              </>
            ) : (
              <>
                <Button 
                  variant="outline"
                  onClick={() => {
                    setScheduleMode(false);
                    setScheduleDateTime('');
                  }}
                >
                  Back
                </Button>
                <Button 
                  onClick={() => handleScheduleCampaign(previewData?.campaign, scheduleDateTime)}
                  disabled={sending || !scheduleDateTime}
                  data-testid="button-confirm-schedule"
                >
                  {sending ? (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  ) : (
                    <Calendar className="w-4 h-4 mr-2" />
                  )}
                  Schedule Campaign
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showStatsDialog} onOpenChange={(open) => {
        setShowStatsDialog(open);
        if (!open) {
          setStatsDetailView(false);
          setStatsFilter(null);
          setStatsLinkFilter(null);
          setExpandedRecipients(new Set());
        }
      }}>
        <DialogContent className={`transition-all duration-300 ${statsDetailView ? 'w-[95vw] max-w-[95vw] h-[95vh] max-h-[95vh]' : 'max-w-3xl w-[95vw] max-h-[85vh]'} overflow-hidden flex flex-col`}>
          <DialogHeader className="flex-shrink-0">
            <div className="flex items-center justify-between gap-4">
              <div>
                <DialogTitle>Campaign Statistics</DialogTitle>
                <DialogDescription>
                  Performance metrics for "{statsData?.name}"
                </DialogDescription>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleSyncMailgunEvents}
                  disabled={syncingStats || !statsCampaignId}
                  data-testid="button-sync-mailgun-stats"
                >
                  {syncingStats ? (
                    <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                  ) : (
                    <RefreshCw className="w-4 h-4 mr-1" />
                  )}
                  {syncingStats ? 'Syncing...' : 'Sync with Mailgun'}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleExportStatsCSV}
                  disabled={!statsData}
                  data-testid="button-export-stats-csv"
                >
                  <Download className="w-4 h-4 mr-1" />
                  Export CSV
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleHeatmapPreview}
                  disabled={!statsData?.heatmapData?.length}
                  data-testid="button-preview-with-stats"
                >
                  <Flame className="w-4 h-4 mr-1" />
                  Preview with Stats
                </Button>
                {statsDetailView ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => { setStatsDetailView(false); setStatsFilter(null); setStatsLinkFilter(null); setExpandedRecipients(new Set()); }}
                    data-testid="button-back-to-summary"
                  >
                    <BarChart3 className="w-4 h-4 mr-1" />
                    Back to Summary
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleShowDetails}
                    disabled={loadingRecipients || !statsData?.sent}
                    data-testid="button-view-details"
                  >
                    {loadingRecipients ? (
                      <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                    ) : (
                      <Users className="w-4 h-4 mr-1" />
                    )}
                    View Details
                  </Button>
                )}
              </div>
            </div>
          </DialogHeader>
          
          {statsData && (
            <div className="flex-1 overflow-y-auto space-y-6 p-1">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                {[
                  { key: 'sent', label: 'Sent', icon: Send, value: statsData.sent, bg: 'bg-blue-50 dark:bg-blue-950', text: 'text-blue-700 dark:text-blue-300', accent: 'text-blue-600', ring: 'ring-blue-400' },
                  { key: 'delivered', label: 'Delivered', icon: CheckCircle2, value: statsData.delivered, bg: 'bg-green-50 dark:bg-green-950', text: 'text-green-700 dark:text-green-300', accent: 'text-green-600', ring: 'ring-green-400' },
                  { key: 'opened', label: 'Opened', icon: Eye, value: statsData.opened, bg: 'bg-purple-50 dark:bg-purple-950', text: 'text-purple-700 dark:text-purple-300', accent: 'text-purple-600', ring: 'ring-purple-400' },
                  { key: 'clicked', label: 'Clicked', icon: MousePointerClick, value: statsData.clicked, bg: 'bg-amber-50 dark:bg-amber-950', text: 'text-amber-700 dark:text-amber-300', accent: 'text-amber-600', ring: 'ring-amber-400' },
                ].map(({ key, label, icon: Icon, value, bg, text, accent, ring }) => (
                  <div
                    key={key}
                    className={`text-center p-4 ${bg} rounded-lg ${statsDetailView ? `cursor-pointer hover-elevate ${statsFilter === key ? `ring-2 ${ring}` : ''}` : ''}`}
                    onClick={() => statsDetailView && setStatsFilter(statsFilter === key ? null : key)}
                    data-testid={`stat-card-${key}`}
                  >
                    <Icon className={`w-5 h-5 mx-auto mb-1 ${accent}`} />
                    <div data-testid={`text-stats-${key}`} className={`text-2xl font-bold ${text}`}>
                      {value}
                    </div>
                    <div className={`text-xs ${accent}`}>{label}</div>
                  </div>
                ))}
              </div>

              {statsData.sent_only > 0 && statsData.delivered < statsData.sent && (
                <div className="flex items-start gap-3 p-3 bg-amber-50 dark:bg-amber-950 border border-amber-200 dark:border-amber-800 rounded-lg" data-testid="warning-incomplete-stats">
                  <AlertTriangle className="w-4 h-4 text-amber-600 mt-0.5 flex-shrink-0" />
                  <div className="text-sm">
                    <span className="font-medium text-amber-800 dark:text-amber-200">
                      {statsData.sent_only} recipients still showing as "sent" without delivery confirmation.
                    </span>
                    <span className="text-amber-700 dark:text-amber-300 ml-1">
                      This may indicate delayed or missing webhook data from Mailgun. Use "Sync with Mailgun" to recover missing events.
                    </span>
                  </div>
                </div>
              )}

              <div className="grid grid-cols-3 gap-4">
                {[
                  { key: 'bounced', label: 'Bounced', value: statsData.bounced, color: 'text-red-600', ring: 'ring-red-400' },
                  { key: 'unsubscribed', label: 'Unsubscribed', value: statsData.unsubscribed, color: 'text-orange-600', ring: 'ring-orange-400' },
                  { key: 'complained', label: 'Complaints', value: statsData.complained, color: 'text-rose-600', ring: 'ring-rose-400' },
                ].map(({ key, label, value, color, ring }) => (
                  <div
                    key={key}
                    className={`text-center p-3 border rounded-lg ${statsDetailView ? `cursor-pointer hover-elevate ${statsFilter === key ? `ring-2 ${ring}` : ''}` : ''}`}
                    onClick={() => statsDetailView && setStatsFilter(statsFilter === key ? null : key)}
                    data-testid={`stat-card-${key}`}
                  >
                    <div data-testid={`text-stats-${key}`} className={`text-lg font-semibold ${color}`}>
                      {value}
                    </div>
                    <div className="text-xs text-muted-foreground">{label}</div>
                  </div>
                ))}
              </div>

              {!statsDetailView && statsData.heatmapData && statsData.heatmapData.length > 0 && (
                <div>
                  <h4 className="font-semibold mb-3 flex items-center gap-2">
                    <TrendingUp className="w-4 h-4" />
                    Link Click Heatmap
                  </h4>
                  <div className="space-y-2 max-h-48 overflow-y-auto">
                    {statsData.heatmapData.map((link, i) => {
                      const maxClicks = Math.max(...statsData.heatmapData.map(l => l.clicks));
                      const intensity = maxClicks > 0 ? (link.clicks / maxClicks) * 100 : 0;
                      
                      return (
                        <div key={i} className="flex items-center gap-3">
                          <div className="flex-1 min-w-0">
                            <div 
                              className="h-8 rounded flex items-center px-3 text-sm truncate"
                              style={{
                                background: `linear-gradient(90deg, rgba(59, 130, 246, ${0.1 + intensity * 0.005}) ${intensity}%, transparent ${intensity}%)`,
                                border: '1px solid rgba(59, 130, 246, 0.2)'
                              }}
                            >
                              <a 
                                href={link.url} 
                                target="_blank" 
                                rel="noopener noreferrer"
                                className="text-blue-600 hover:underline truncate"
                              >
                                {link.url}
                              </a>
                            </div>
                          </div>
                          <div className="text-sm font-medium w-16 text-right">
                            {link.clicks} clicks
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {statsDetailView && statsData.heatmapData && statsData.heatmapData.length > 0 && (
                <div>
                  <h4 className="font-semibold mb-3 flex items-center gap-2">
                    <TrendingUp className="w-4 h-4" />
                    Link Click Heatmap
                    <span className="text-xs font-normal text-muted-foreground ml-1">Click a link to filter recipients</span>
                  </h4>
                  <div className="space-y-2">
                    {statsData.heatmapData.map((link, i) => {
                      const maxClicks = Math.max(...statsData.heatmapData.map(l => l.clicks));
                      const intensity = maxClicks > 0 ? (link.clicks / maxClicks) * 100 : 0;
                      const isActive = statsLinkFilter === link.url;
                      
                      return (
                        <div
                          key={i}
                          className={`flex items-center gap-3 cursor-pointer rounded-lg p-1 ${isActive ? 'ring-2 ring-blue-400' : ''}`}
                          onClick={() => setStatsLinkFilter(isActive ? null : link.url)}
                          data-testid={`heatmap-link-${i}`}
                        >
                          <div className="flex-1 min-w-0">
                            <div 
                              className="h-8 rounded flex items-center px-3 text-sm truncate"
                              style={{
                                background: `linear-gradient(90deg, rgba(59, 130, 246, ${0.1 + intensity * 0.005}) ${intensity}%, transparent ${intensity}%)`,
                                border: '1px solid rgba(59, 130, 246, 0.2)'
                              }}
                            >
                              <span className="truncate">{link.url}</span>
                            </div>
                          </div>
                          <div className="text-sm font-medium w-16 text-right shrink-0">
                            {link.clicks} clicks
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {statsDetailView && (
                <div>
                  <div className="flex items-center justify-between mb-3">
                    <h4 className="font-semibold flex items-center gap-2">
                      <Users className="w-4 h-4" />
                      {statsFilter ? `${statsFilter.charAt(0).toUpperCase() + statsFilter.slice(1)} Recipients` : 'All Recipients'}
                      {statsLinkFilter && <span className="text-xs font-normal text-muted-foreground truncate max-w-xs">filtered by link</span>}
                      <Badge variant="secondary" className="ml-1">{getFilteredRecipients().length}</Badge>
                    </h4>
                    <div className="flex items-center gap-2">
                      {statsLinkFilter && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setStatsLinkFilter(null)}
                          data-testid="button-clear-link-filter"
                        >
                          Clear link filter
                        </Button>
                      )}
                      {statsFilter && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setStatsFilter(null)}
                          data-testid="button-clear-filter"
                        >
                          Clear status filter
                        </Button>
                      )}
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground mb-3">
                    Click any stat card to filter by status, or a heatmap link to filter by link. Click a recipient row to see their specific link clicks.
                  </p>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-8"></TableHead>
                        <TableHead>Email</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="text-right">Opens</TableHead>
                        <TableHead className="text-right">Clicks</TableHead>
                        <TableHead>Sent At</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {getFilteredRecipients().length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">
                            No recipients found{statsFilter ? ` for "${statsFilter}"` : ''}{statsLinkFilter ? ' with this link' : ''}
                          </TableCell>
                        </TableRow>
                      ) : (
                        getFilteredRecipients().map((recipient) => {
                          const isExpanded = expandedRecipients.has(recipient.id);
                          const hasClicks = recipient.link_clicks && recipient.link_clicks.length > 0;
                          return (
                            <Fragment key={recipient.id}>
                              <TableRow
                                className={`${hasClicks ? 'cursor-pointer' : ''}`}
                                onClick={() => hasClicks && toggleRecipientExpand(recipient.id)}
                                data-testid={`row-recipient-${recipient.id}`}
                              >
                                <TableCell className="w-8 px-2">
                                  {hasClicks && (
                                    isExpanded
                                      ? <ChevronDown className="w-4 h-4 text-muted-foreground" />
                                      : <ChevronRight className="w-4 h-4 text-muted-foreground" />
                                  )}
                                </TableCell>
                                <TableCell className="font-medium">{recipient.email}</TableCell>
                                <TableCell>
                                  <Badge
                                    variant="outline"
                                    className={
                                      recipient.status === 'delivered' || recipient.status === 'opened' || recipient.status === 'clicked'
                                        ? 'border-green-500 text-green-600'
                                        : recipient.status === 'bounced' || recipient.status === 'failed'
                                        ? 'border-red-500 text-red-600'
                                        : recipient.status === 'complained'
                                        ? 'border-rose-500 text-rose-600'
                                        : recipient.status === 'unsubscribed'
                                        ? 'border-orange-500 text-orange-600'
                                        : ''
                                    }
                                  >
                                    {recipient.status}
                                  </Badge>
                                </TableCell>
                                <TableCell className="text-right">{recipient.open_count || 0}</TableCell>
                                <TableCell className="text-right">{recipient.click_count || 0}</TableCell>
                                <TableCell className="text-sm text-muted-foreground">
                                  {recipient.sent_at ? new Date(recipient.sent_at).toLocaleString() : '-'}
                                </TableCell>
                              </TableRow>
                              {isExpanded && (
                                <TableRow data-testid={`row-recipient-clicks-${recipient.id}`}>
                                  <TableCell colSpan={6} className="bg-muted/30 px-8 py-3">
                                    <div className="text-xs font-medium text-muted-foreground mb-2">Links clicked:</div>
                                    <div className="space-y-1.5">
                                      {recipient.link_clicks.map((click, ci) => (
                                        <div key={ci} className="flex items-center gap-3 text-sm">
                                          <ExternalLink className="w-3.5 h-3.5 text-blue-500 shrink-0" />
                                          <a
                                            href={click.url}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="text-blue-600 hover:underline truncate max-w-md"
                                            onClick={(e) => e.stopPropagation()}
                                          >
                                            {click.link_text || click.url}
                                          </a>
                                          <span className="text-muted-foreground shrink-0">
                                            {click.clicked_at ? new Date(click.clicked_at).toLocaleString() : ''}
                                          </span>
                                        </div>
                                      ))}
                                    </div>
                                  </TableCell>
                                </TableRow>
                              )}
                            </Fragment>
                          );
                        })
                      )}
                    </TableBody>
                  </Table>
                </div>
              )}
            </div>
          )}

        </DialogContent>
      </Dialog>

      <Dialog open={showTestEmailDialog} onOpenChange={(open) => {
        setShowTestEmailDialog(open);
        if (!open) {
          setTestEmailAddress('');
          setTestEmailCampaign(null);
          setTestEmailMode('manual');
          setMemberSearchQuery('');
          setMemberSearchResults([]);
          setSelectedMember(null);
        }
      }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Send Test Email</DialogTitle>
            <DialogDescription>
              Send a test email for "{testEmailCampaign?.name}" to preview how it will look
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <Tabs value={testEmailMode} onValueChange={(v) => {
              setTestEmailMode(v);
              setTestEmailAddress('');
              setMemberSearchQuery('');
              setMemberSearchResults([]);
              setSelectedMember(null);
            }}>
              <TabsList className="w-full">
                <TabsTrigger value="manual" className="flex-1" data-testid="tab-manual-email-list">
                  <Mail className="w-4 h-4 mr-2" />
                  Enter Email
                </TabsTrigger>
                <TabsTrigger value="member" className="flex-1" data-testid="tab-member-lookup-list">
                  <Search className="w-4 h-4 mr-2" />
                  Find Member
                </TabsTrigger>
              </TabsList>
              
              <TabsContent value="manual" className="mt-4">
                <div className="space-y-2">
                  <Label htmlFor="test-email-list">Email Address</Label>
                  <Input
                    id="test-email-list"
                    type="email"
                    value={testEmailAddress}
                    onChange={(e) => setTestEmailAddress(e.target.value)}
                    placeholder="your@email.com"
                    data-testid="input-test-email-list"
                  />
                  <p className="text-xs text-muted-foreground">
                    The test email will be sent to this address
                  </p>
                </div>
              </TabsContent>
              
              <TabsContent value="member" className="mt-4">
                <div className="space-y-2">
                  <Label htmlFor="member-search-list">Search Member</Label>
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                    <Input
                      id="member-search-list"
                      value={memberSearchQuery}
                      onChange={(e) => handleMemberSearchInput(e.target.value)}
                      placeholder="Search by name or email..."
                      className="pl-9"
                      data-testid="input-member-search-list"
                    />
                    {searchingMembers && (
                      <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 animate-spin text-muted-foreground" />
                    )}
                  </div>
                  
                  {memberSearchResults.length > 0 && (
                    <div className="border rounded-md max-h-48 overflow-y-auto">
                      {memberSearchResults.map((member) => (
                        <button
                          key={member.id}
                          type="button"
                          onClick={() => handleSelectMember(member)}
                          className="w-full text-left px-3 py-2 hover-elevate flex items-center gap-2 border-b last:border-b-0"
                          data-testid={`member-result-list-${member.id}`}
                        >
                          <Users className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                          <div className="min-w-0 flex-1">
                            <div className="font-medium truncate">
                              {member.first_name} {member.last_name}
                            </div>
                            <div className="text-sm text-muted-foreground truncate">
                              {member.email}
                            </div>
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                  
                  {memberSearchQuery.length >= 2 && memberSearchResults.length === 0 && !searchingMembers && (
                    <p className="text-sm text-muted-foreground">No members found</p>
                  )}
                  
                  {selectedMember && (
                    <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 flex items-center gap-2">
                      <Users className="w-4 h-4 text-blue-600 flex-shrink-0" />
                      <div className="min-w-0 flex-1">
                        <div className="font-medium text-blue-900">
                          {selectedMember.first_name} {selectedMember.last_name}
                        </div>
                        <div className="text-sm text-blue-700 truncate">
                          {selectedMember.email}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </TabsContent>
            </Tabs>
          </div>
          <DialogFooter>
            <Button 
              variant="outline" 
              onClick={() => setShowTestEmailDialog(false)}
              data-testid="button-cancel-test-send-list"
            >
              Cancel
            </Button>
            <Button 
              onClick={() => {
                if (testEmailAddress && testEmailCampaign) {
                  handleTestSend(testEmailCampaign, testEmailAddress);
                  setShowTestEmailDialog(false);
                }
              }}
              disabled={!testEmailAddress || testSending}
              data-testid="button-confirm-test-send-list"
            >
              {testSending ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <TestTube2 className="w-4 h-4 mr-2" />
              )}
              Send Test
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showEmailPreview} onOpenChange={(open) => {
        setShowEmailPreview(open);
        if (!open) setEmailPreviewHeatmap(null);
      }}>
        <DialogContent className="max-w-[90vw] w-[90vw] h-[85vh] max-h-[85vh] p-0 gap-0 flex flex-col">
          <DialogHeader className="flex flex-row items-center justify-between px-4 py-3 border-b bg-background flex-shrink-0 space-y-0">
            <DialogTitle className="text-sm font-semibold flex items-center gap-2" data-testid="text-sent-preview-title">
              {emailPreviewHeatmap ? (
                <>
                  <Flame className="w-4 h-4 text-orange-500" />
                  Email Preview — Click Heatmap
                </>
              ) : (
                'Email Preview'
              )}
            </DialogTitle>
            <DialogDescription className="sr-only">Preview how the sent email appeared to recipients</DialogDescription>
            <div className="flex items-center gap-1 bg-muted rounded-md p-0.5">
              <Button
                variant={emailPreviewMode === 'desktop' ? 'default' : 'ghost'}
                size="sm"
                onClick={() => setEmailPreviewMode('desktop')}
                data-testid="button-sent-preview-desktop"
              >
                <Monitor className="w-4 h-4 mr-1" />
                Desktop
              </Button>
              <Button
                variant={emailPreviewMode === 'mobile' ? 'default' : 'ghost'}
                size="sm"
                onClick={() => setEmailPreviewMode('mobile')}
                data-testid="button-sent-preview-mobile"
              >
                <Smartphone className="w-4 h-4 mr-1" />
                Mobile
              </Button>
            </div>
          </DialogHeader>
          {emailPreviewHeatmap && (
            <div className="flex-shrink-0 px-4 py-2 border-b bg-muted/20 flex items-center justify-between gap-4 flex-wrap" data-testid="heatmap-legend">
              <span className="text-xs text-muted-foreground">Click intensity:</span>
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-1">
                  <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: '50%', background: 'rgba(148, 163, 184, 0.4)' }} />
                  <span className="text-xs text-muted-foreground">0</span>
                </div>
                <div className="flex items-center gap-1">
                  <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: '50%', background: 'rgba(59, 130, 246, 0.5)' }} />
                  <span className="text-xs text-muted-foreground">Low</span>
                </div>
                <div className="flex items-center gap-1">
                  <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: '50%', background: 'rgba(34, 197, 94, 0.5)' }} />
                  <span className="text-xs text-muted-foreground">Medium</span>
                </div>
                <div className="flex items-center gap-1">
                  <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: '50%', background: 'rgba(249, 115, 22, 0.5)' }} />
                  <span className="text-xs text-muted-foreground">High</span>
                </div>
                <div className="flex items-center gap-1">
                  <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: '50%', background: 'rgba(239, 68, 68, 0.5)' }} />
                  <span className="text-xs text-muted-foreground">Max</span>
                </div>
              </div>
            </div>
          )}
          <div className="flex-1 overflow-auto bg-muted/30 flex justify-center p-6" data-testid="sent-preview-container">
            {emailPreviewLoading ? (
              <div className="flex items-center justify-center h-full">
                <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" data-testid="loader-email-preview" />
              </div>
            ) : emailPreviewData ? (
              <div
                className="bg-white dark:bg-zinc-900 rounded-md shadow-md overflow-hidden transition-all duration-300 h-fit border border-border"
                style={{ width: emailPreviewMode === 'mobile' ? '375px' : '100%', maxWidth: '800px' }}
              >
                <div className="border-b border-border bg-muted/40 px-4 py-2 flex items-center justify-between gap-2 flex-wrap" data-testid="sent-preview-email-toolbar">
                  <div className="flex items-center gap-1">
                    <Button variant="ghost" size="icon" className="h-7 w-7 opacity-50 cursor-default" tabIndex={-1}>
                      <Archive className="w-3.5 h-3.5" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-7 w-7 opacity-50 cursor-default" tabIndex={-1}>
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-7 w-7 opacity-50 cursor-default" tabIndex={-1}>
                      <Reply className="w-3.5 h-3.5" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-7 w-7 opacity-50 cursor-default" tabIndex={-1}>
                      <Forward className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button variant="ghost" size="icon" className="h-7 w-7 opacity-50 cursor-default" tabIndex={-1}>
                      <Star className="w-3.5 h-3.5" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-7 w-7 opacity-50 cursor-default" tabIndex={-1}>
                      <MoreHorizontal className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </div>

                <div className="border-b border-border px-4 py-3 space-y-1.5 bg-background" data-testid="sent-preview-email-headers">
                  <div className="text-base font-semibold text-foreground" data-testid="text-sent-preview-subject">
                    {emailPreviewData.subject || 'No subject'}
                  </div>
                  <div className="flex items-start gap-3">
                    <div className="flex-shrink-0 w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center mt-0.5">
                      <Mail className="w-4 h-4 text-primary" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium text-foreground" data-testid="text-sent-preview-from-name">
                          {emailPreviewData.from_name || 'Sender Name'}
                        </span>
                        <span className="text-xs text-muted-foreground" data-testid="text-sent-preview-from-email">
                          &lt;{emailPreviewData.from_email || 'sender@example.com'}&gt;
                        </span>
                      </div>
                      <div className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                        to <span className="font-medium">recipient@example.com</span>
                      </div>
                    </div>
                    <div className="flex-shrink-0 flex items-center gap-2">
                      <span className="text-xs text-muted-foreground" data-testid="text-sent-preview-date">
                        {emailPreviewData.sent_at
                          ? new Date(emailPreviewData.sent_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
                          : 'Unknown date'}
                      </span>
                      <Paperclip className="w-3.5 h-3.5 text-muted-foreground opacity-0" />
                    </div>
                  </div>
                </div>

                <div ref={heatmapPreviewRef} data-testid="sent-preview-email-body" style={{ backgroundColor: emailPreviewData.design_json?.globalStyles?.backgroundColor || '#f4f4f4' }}>
                  {emailPreviewData.design_json && Array.isArray(emailPreviewData.design_json.blocks) ? (
                    <ReadOnlyBlockPreview
                      blocks={emailPreviewData.design_json.blocks}
                      globalStyles={emailPreviewData.design_json.globalStyles}
                      footerHtml={emailPreviewFooter?.hasFooter ? emailPreviewFooter.footer : null}
                    />
                  ) : emailPreviewData.html_content ? (
                    <div
                      className="p-4"
                      dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(emailPreviewData.html_content, { ALLOWED_TAGS: ['div', 'span', 'p', 'br', 'b', 'i', 'u', 'strong', 'em', 'a', 'img', 'table', 'tr', 'td', 'th', 'thead', 'tbody', 'tfoot', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'hr', 'center', 'font', 'sup', 'sub', 'pre', 'code'], ALLOWED_ATTR: ['style', 'class', 'href', 'src', 'alt', 'width', 'height', 'align', 'valign', 'border', 'cellpadding', 'cellspacing', 'bgcolor', 'color', 'size', 'face', 'target', 'rel'] }) }}
                      data-testid="sent-preview-raw-html"
                    />
                  ) : (
                    <div className="flex items-center justify-center h-96 text-muted-foreground text-sm" data-testid="text-no-visual-design">
                      No visual design data available for this campaign.
                    </div>
                  )}
                </div>
              </div>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
