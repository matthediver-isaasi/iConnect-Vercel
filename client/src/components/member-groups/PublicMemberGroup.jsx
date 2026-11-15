import React, { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { publicClient, getTenantSlugFromLocation } from '@/api/publicClient';
import { sanitizeRichText } from '@/components/canvas/blocks/sanitize';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import ConsentFrame from '@/components/ConsentFrame';

const html = value => <div className="prose prose-sm max-w-none" dangerouslySetInnerHTML={{ __html: sanitizeRichText(value || '') }} />;
const groupUrl = (id, extra = {}) => `/MemberGroupDetail?${new URLSearchParams({ id, ...extra })}`;
export function usePublicGroupRead(groupId, action, params = {}, enabled = true) {
  return useQuery({
    queryKey: ['guest-group-reading', window.location.host, getTenantSlugFromLocation(), groupId, action, params],
    queryFn: () => publicClient.readMemberGroupContent(groupId, action, params),
    enabled: !!groupId && enabled, staleTime: 0, gcTime: 0,
    retry: false, refetchOnMount: 'always', refetchOnWindowFocus: 'always',
  });
}
function ReadState({ query, children }) {
  if (query.error) return <div role="alert"><p>{query.error.status === 404 ? 'This group content is not available.' : 'Unable to load this content.'}</p><Button variant="outline" onClick={() => query.refetch()}>Try again</Button></div>;
  if (!query.data || query.isFetching) return <p role="status">Loading…</p>;
  return children(query.data);
}
function ResourceRead({ groupId, resourceId }) {
  const query = usePublicGroupRead(groupId, 'resource', { resourceId });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const download = async () => {
    setBusy(true); setError('');
    try {
      const result = await publicClient.readMemberGroupContent(groupId, 'download', { resourceId });
      window.location.assign(result.url);
    } catch { setError('This download is unavailable. Please reload the page.'); }
    finally { setBusy(false); }
  };
  return <ReadState query={query}>{resource => <article>
    <h2 className="text-2xl font-semibold mb-4">{resource.title}</h2>
    {html(resource.description)}
    {resource.embed_url && <ConsentFrame src={resource.embed_url} title={resource.title} className="w-full aspect-video mt-4" allowFullScreen />}
    {resource.can_download && <Button className="mt-4" onClick={download} disabled={busy}>Download resource</Button>}
    {resource.target_url && <a className="block underline mt-4" href={resource.target_url} target="_blank" rel="noopener noreferrer">Open resource</a>}
    {resource.resource_type === 'download' && !resource.can_download && !resource.target_url &&
      <p className="text-sm text-slate-500 mt-4">This file is not available for public download.</p>}
    {error && <p role="alert">{error}</p>}
  </article>}</ReadState>;
}
function ContentList({ groupId, section, page }) {
  const query = usePublicGroupRead(groupId, section, { page });
  const [, setSearchParams] = useSearchParams();
  return <ReadState query={query}>{data => <>
    {!data.records?.length && <p>No content available.</p>}
    <div className="grid gap-4 md:grid-cols-2">
      {(data.records || []).map(row => <Card key={row.id}><CardContent className="p-5">
        {section === 'members' ? <>
          {row.profile_photo_url && <img src={row.profile_photo_url} alt="" className="w-16 h-16 rounded-full object-cover mb-3" />}
          <h3 className="font-semibold">{row.name}</h3><p>{row.group_role}</p><p>{row.job_title}</p><p>{row.organization_name}</p>
        </> : <>
          <h3 className="font-semibold text-lg">{row.title || row.role_title}</h3>
          {section === 'resources' ? <Link className="underline" to={groupUrl(groupId, { resourceId: row.id })}>Read resource</Link>
            : section === 'threads' ? <Link className="underline" to={groupUrl(groupId, { threadId: row.id })}>Read discussion</Link>
            : <>{html(row.description || row.role_description)}
              {row.start_date && <p>{new Date(row.start_date).toLocaleDateString()}</p>}
              {row.closing_date && <p>Closes {new Date(row.closing_date).toLocaleDateString()}</p>}
              <p className="text-sm text-slate-500 mt-3">{section === 'events' ? 'Sign in to check booking eligibility.' : 'Sign in to apply.'}</p>
            </>}
        </>}
      </CardContent></Card>)}
    </div>
    <div className="flex gap-3 mt-4">
      {page > 1 && <Button variant="outline" onClick={() => setSearchParams({ id: groupId, section, page: page - 1 })}>Previous</Button>}
      {(data.hasMore || data.total > page * 24) && <Button variant="outline" onClick={() => setSearchParams({ id: groupId, section, page: page + 1 })}>Next</Button>}
    </div>
  </>}</ReadState>;
}
function ThreadRead({ groupId, threadId, page }) {
  const query = usePublicGroupRead(groupId, 'thread', { threadId, page });
  return <ReadState query={query}>{data => <article>
    <h2 className="text-2xl font-semibold mb-5">{data.thread.title}</h2>
    {data.records.map(post => <Card key={post.id} className="mb-4"><CardContent className="p-5">
      <p className="text-sm text-slate-500 mb-3">{post.author_name} · {new Date(post.created_at).toLocaleString()}</p>
      <p className="whitespace-pre-wrap">{post.content}</p>
      {post.image_urls?.map((url, index) => <img key={url} src={url} alt={`Discussion attachment ${index + 1}`}
        loading="lazy" className="max-w-full max-h-96 mt-3 rounded" />)}
    </CardContent></Card>)}
    <p>Sign in to participate. Group membership and posting permissions still apply.</p>
    <div className="flex gap-4 mt-4">
      {page > 1 && <Link to={groupUrl(groupId, { threadId, page: page - 1 })}>Previous</Link>}
      {data.hasMore && <Link to={groupUrl(groupId, { threadId, page: page + 1 })}>Next</Link>}
    </div>
  </article>}</ReadState>;
}
export default function PublicMemberGroup({ groupId: suppliedGroupId, threadId: suppliedThreadId }) {
  const [params] = useSearchParams();
  const groupId = suppliedGroupId || params.get('id');
  const threadId = suppliedThreadId || params.get('threadId');
  const resourceId = params.get('resourceId');
  const section = ['members', 'events', 'vacancies', 'resources', 'threads'].includes(params.get('section')) ? params.get('section') : 'about';
  const page = Math.max(1, Number.parseInt(params.get('page'), 10) || 1);
  const detail = usePublicGroupRead(groupId, 'detail');
  if (!groupId) return <p className="p-8">Group not found.</p>;
  return <div className="max-w-6xl mx-auto px-4 py-8">
    <Link className="underline" to="/MemberGroups">Back to groups</Link>
    <ReadState query={detail}>{group => <>
      {group.header_image_url && <img className="w-full max-h-72 object-cover rounded-lg mt-6" src={group.header_image_url} alt="" />}
      <h1 className="text-3xl font-bold mt-6 mb-3">{group.name}</h1>
      <p className="text-sm text-slate-500 mb-5">Public read-only access. <a className="underline" href={`/login?returnTo=${encodeURIComponent('/MemberGroupDetail')}&groupId=${encodeURIComponent(groupId)}`}>Sign in</a> to use member features.</p>
      <nav aria-label="Group content" className="flex flex-wrap gap-4 border-b pb-4 mb-6">
        {['about', 'members', 'events', 'vacancies', 'resources', ...(group.forum_enabled ? ['threads'] : [])].map(tab =>
          <Link key={tab} className="capitalize underline" to={groupUrl(groupId, { section: tab })}>{tab === 'threads' ? 'Discussions' : tab}</Link>)}
      </nav>
      {resourceId ? <ResourceRead key={resourceId} groupId={groupId} resourceId={resourceId} />
        : threadId ? <ThreadRead groupId={groupId} threadId={threadId} page={page} />
        : section === 'about' ? <div className="space-y-6">
          {html(group.description)}
          {group.who_is_it_for && <section><h2 className="text-xl font-semibold mb-3">Who is it for?</h2>{html(group.who_is_it_for)}</section>}
          {group.about_the_group && <section><h2 className="text-xl font-semibold mb-3">About the group</h2>{html(group.about_the_group)}</section>}
          {group.terms_of_reference && <section><h2 className="text-xl font-semibold mb-3">Terms of reference</h2>{html(group.terms_of_reference)}</section>}
        </div> : <ContentList groupId={groupId} section={section} page={page} />}
    </>}</ReadState>
  </div>;
}
