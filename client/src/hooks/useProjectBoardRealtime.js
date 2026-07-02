import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase, isSupabaseConfigured } from '@/api/supabaseClient';

export function useProjectBoardRealtime(boardId) {
  const queryClient = useQueryClient();
  const boardIdRef = useRef(boardId);
  boardIdRef.current = boardId;

  useEffect(() => {
    if (!isSupabaseConfigured || !supabase) {
      console.log('[useProjectBoardRealtime] Supabase not configured, skipping realtime subscription');
      return;
    }

    if (!boardId) {
      console.log('[useProjectBoardRealtime] No boardId provided, skipping subscription');
      return;
    }

    console.log('[useProjectBoardRealtime] Setting up realtime subscriptions for board:', boardId);

    const channelName = 'project-board-' + boardId + '-' + Math.random().toString(36).substr(2, 9);
    
    const handleChange = (payload) => {
      console.log('[useProjectBoardRealtime] Change detected:', payload.table, payload.eventType);
      queryClient.invalidateQueries({ queryKey: ['project-board', boardIdRef.current] });
    };

    const channel = supabase
      .channel(channelName)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'project_board',
          filter: `id=eq.${boardId}`
        },
        handleChange
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'project_list',
          filter: `board_id=eq.${boardId}`
        },
        handleChange
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'project_card'
        },
        (payload) => {
          console.log('[useProjectBoardRealtime] Card change detected:', payload.eventType, payload.new?.id || payload.old?.id);
          queryClient.invalidateQueries({ queryKey: ['project-board', boardIdRef.current] });
        }
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'project_board_member',
          filter: `board_id=eq.${boardId}`
        },
        handleChange
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'project_label',
          filter: `board_id=eq.${boardId}`
        },
        handleChange
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'project_card_label'
        },
        handleChange
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'project_card_assignee'
        },
        handleChange
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'project_card_comment'
        },
        handleChange
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'project_card_checklist'
        },
        handleChange
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'project_checklist_item'
        },
        handleChange
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'project_card_activity'
        },
        handleChange
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'project_card_attachment'
        },
        handleChange
      )
      .subscribe((status) => {
        console.log('[useProjectBoardRealtime] Subscription status:', status);
      });

    return () => {
      console.log('[useProjectBoardRealtime] Cleaning up realtime subscription for board:', boardId);
      supabase.removeChannel(channel);
    };
  }, [queryClient, boardId]);
}
