import { useState, useEffect, useRef } from "react";
import { useParams, useLocation } from "react-router-dom";
import { useTenantBranding } from "@/contexts/TenantBrandingContext";
import { useArticleUrl } from "@/contexts/ArticleUrlContext";
import { getTenantSlugFromLocation } from "@/api/publicClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Calendar, User, Lock, Eye } from "lucide-react";
import { format, isValid } from "date-fns";
import DOMPurify from "dompurify";

export default function ArticlePreview() {
  const { id } = useParams();
  const location = useLocation();
  const { branding, tenantSlug } = useTenantBranding();
  // Remount the authorization boundary on navigation or tenant changes.
  return <Preview key={`${id}:${location.key}:${tenantSlug}:${branding?.id}`} id={id} />;
}

function Preview({ id }) {
  const { displayName = 'Articles' } = useArticleUrl();
  const articleDisplayName = displayName.endsWith('s') ? displayName.slice(0, -1) : displayName;
  const [enteredPassword, setEnteredPassword] = useState('');
  const [result, setResult] = useState(null);
  const [authError, setAuthError] = useState('');
  const [pending, setPending] = useState(false);
  const request = useRef(null);

  useEffect(() => {
    const previousTitle = document.title;
    document.title = 'Article Preview';
    const robots = document.createElement('meta');
    robots.name = 'robots';
    robots.content = 'noindex, nofollow, noarchive';
    document.head.appendChild(robots);
    return () => {
      request.current?.abort();
      document.title = previousTitle;
      robots.remove();
    };
  }, []);

  const handlePasswordSubmit = async event => {
    event.preventDefault();
    if (request.current || !enteredPassword) return;
    const controller = new AbortController();
    request.current = controller;
    const timeout = setTimeout(() => controller.abort(), 15000);
    setPending(true);
    setAuthError('');
    try {
      const tenant = getTenantSlugFromLocation();
      const response = await fetch(`/api/public/article-preview${tenant ? `?tenant=${encodeURIComponent(tenant)}` : ''}`, {
        method: 'POST', credentials: 'omit', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, password: enteredPassword }),
        signal: controller.signal,
      });
      const data = await response.json();
      if (!response.ok) {
        const message = response.status === 429 ? 'Too many attempts. Try again in an hour.'
          : [403, 404].includes(response.status) ? 'This preview is unavailable or the password is incorrect.'
          : 'Preview is temporarily unavailable. Please try again.';
        throw new Error(message);
      }
      if (!data?.article) throw new Error('Preview is temporarily unavailable. Please try again.');
      if (!controller.signal.aborted) setResult(data);
    } catch (error) {
      setAuthError(error.name === 'AbortError' ? 'The request timed out. Please try again.' : error.message);
    } finally {
      clearTimeout(timeout);
      request.current = null;
      setEnteredPassword('');
      setPending(false);
    }
  };

  if (!result) return (
    <div className="bg-gradient-to-br from-slate-50 to-blue-50 flex items-start justify-center pt-12 px-4 pb-12">
      <Card className="max-w-md w-full">
        <CardHeader className="text-center">
          <div className="w-16 h-16 bg-slate-100 rounded-full flex items-center justify-center mx-auto mb-4"><Lock className="w-8 h-8 text-slate-600" /></div>
          <CardTitle className="text-xl">Password Required</CardTitle>
          <p className="text-slate-600 text-sm mt-2">This is a draft {articleDisplayName.toLowerCase()}. Enter the password to view it.</p>
        </CardHeader>
        <CardContent>
          <form onSubmit={handlePasswordSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="password">Access Password</Label>
              <Input id="password" type="password" autoComplete="off" placeholder="Enter preview password"
                value={enteredPassword} onChange={e => setEnteredPassword(e.target.value)}
                className="text-center text-lg font-mono tracking-widest" maxLength={128}
                autoFocus data-testid="input-preview-password" />
            </div>
            {authError && <div role="alert" className="p-3 bg-red-50 rounded-lg border border-red-200"><p className="text-sm text-red-600 text-center">{authError}</p></div>}
            <Button type="submit" className="w-full gap-2" disabled={!enteredPassword || pending} data-testid="button-submit-password">
              <Eye className="w-4 h-4" />{pending ? 'Checking…' : `View ${articleDisplayName}`}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );

  const { article, authorName } = result;
  const date = new Date(article.published_date);
  return (
    <div className="min-h-screen p-4 md:p-8">
      <div className="max-w-4xl mx-auto">
        <div className="mb-6"><Badge variant="outline" className="bg-warning/10 text-warning border-warning/30">Draft Preview</Badge></div>
        <article className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
          {article.feature_image_url && <div className="w-full h-64 md:h-96 overflow-hidden"><img src={article.feature_image_url} alt={article.title} className="w-full h-full object-cover" /></div>}
          <div className="p-6 md:p-10">
            <h1 className="text-3xl md:text-4xl font-bold text-slate-900 mb-4">{article.title}</h1>
            <div className="flex flex-wrap items-center gap-4 text-sm text-slate-600 mb-6 pb-6 border-b border-slate-200">
              {authorName && <div className="flex items-center gap-2"><User className="w-4 h-4" /><span>{authorName}</span></div>}
              {article.published_date && isValid(date) && <div className="flex items-center gap-2"><Calendar className="w-4 h-4" /><span>{format(date, 'MMMM d, yyyy')}</span></div>}
            </div>
            {article.summary && <p className="text-lg text-slate-700 mb-8 font-medium leading-relaxed">{article.summary}</p>}
            <div className="prose prose-slate max-w-none" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(article.content || '') }} />
            {Array.isArray(article.subcategories) && <div className="mt-8 pt-6 border-t border-slate-200 flex flex-wrap gap-2">{article.subcategories.map((sub, i) => <Badge key={i} variant="secondary">{sub}</Badge>)}</div>}
            {Array.isArray(article.tags) && <div className="mt-4 flex flex-wrap gap-2">{article.tags.map((tag, i) => <span key={i} className="text-sm text-slate-500">#{tag}</span>)}</div>}
          </div>
        </article>
        <div className="mt-6 p-4 bg-warning/10 rounded-lg border border-warning/30 text-center"><p className="text-sm text-warning">This is a draft preview. The {articleDisplayName.toLowerCase()} is not publicly published yet.</p></div>
      </div>
    </div>
  );
}
