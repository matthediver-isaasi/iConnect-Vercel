import { adminFetch } from '@/lib/adminFetch';
export async function listAwards(page = 1) {
  const response = await adminFetch(`/api/awards?page=${page}`);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Unable to load awards');
  return result;
}
export async function awardCommand(command, award, payload) {
  const response = await adminFetch('/api/awards', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Awards-Request': '1' },
    body: JSON.stringify({ command, id: award?.id, version: award?.version, payload }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Unable to save award');
  return result.award;
}
export async function listAwardRounds(awardId, page = 1) {
  const response = await adminFetch(`/api/awards/rounds?awardId=${encodeURIComponent(awardId)}&page=${page}`);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Unable to load rounds');
  return result;
}
export async function getAwardRound(awardId, roundId) {
  const response = await adminFetch(`/api/awards/rounds?awardId=${encodeURIComponent(awardId)}&roundId=${encodeURIComponent(roundId)}`);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Unable to load round');
  return result;
}
export async function awardRoundCommand(awardId, command, round, payload) {
  const response = await adminFetch('/api/awards/rounds', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Awards-Request': '1' },
    body: JSON.stringify({ awardId, command, roundId: round?.id, version: round?.version, payload }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Unable to save round');
  return result.round;
}
