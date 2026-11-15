import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/queryClient';
import { toast } from 'sonner';

// Keep list-only optimism outside the board cache: card mutations and realtime
// refetches may replace that cache while a list save is in flight.
export function useProjectListWrites(boardId, boardData) {
  const client = useQueryClient();
  const lock = useRef(false);
  const [pending, setPending] = useState(null);
  const lists = pending?.boardId === boardId ? pending.lists : boardData?.lists || [];
  async function save(next, method, url, body) {
    if (lock.current) return;
    lock.current = true;
    const key = ['project-board', boardId];
    const previous = boardData?.lists || [];
    setPending({ boardId, lists: next });
    let saved = false;
    try {
      await apiRequest(method, url, body);
      saved = true;
      // Cancel reads begun before the write, then fetch an authoritative snapshot.
      await client.cancelQueries({ queryKey: key, exact: true });
      await client.fetchQuery({ queryKey: key, staleTime: 0 });
    } catch (error) {
      await client.cancelQueries({ queryKey: key, exact: true });
      client.setQueryData(key, old => old ? { ...old, lists: saved ? next : previous } : old);
      toast.error(saved ? 'Saved, but could not refresh the board. Please reload.' : error.message || 'Failed to save lists');
      client.invalidateQueries({ queryKey: key, exact: true });
    } finally {
      setPending(null);
      lock.current = false;
    }
  }
  return {
    lists, pending: pending?.boardId === boardId,
    reorder(source, destination) {
      const next = [...lists];
      next.splice(destination, 0, next.splice(source, 1)[0]);
      return save(next.map((list, position) => ({ ...list, position })), 'PATCH',
        `/api/projects/boards/${boardId}/lists`, { lists: next.map(({ id }) => ({ id })) });
    },
    color(listId, color) {
      return save(lists.map(list => list.id === listId ? { ...list, color } : list), 'PATCH',
        `/api/projects/lists/${listId}`, { color });
    },
  };
}
