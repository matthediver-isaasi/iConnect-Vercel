import { useState, useEffect } from "react";
import { useSearchParams, Link } from "react-router-dom";
import { Search, Loader2, Calendar, BookOpen, Newspaper, FolderOpen, FileText, ArrowRight } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

const typeIconMap = {
  event: Calendar,
  article: BookOpen,
  news: Newspaper,
  resource: FolderOpen
};

const typeLabels = {
  event: 'Event',
  article: 'Article',
  news: 'News',
  resource: 'Resource'
};

const typeColors = {
  event: 'bg-blue-100 text-blue-700',
  article: 'bg-purple-100 text-purple-700',
  news: 'bg-green-100 text-green-700',
  resource: 'bg-orange-100 text-orange-700'
};

export default function SearchResults() {
  const [searchParams, setSearchParams] = useSearchParams();
  const initialQuery = searchParams.get('q') || '';
  const [query, setQuery] = useState(initialQuery);
  const [results, setResults] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);

  useEffect(() => {
    const q = searchParams.get('q');
    if (q && q.trim().length >= 2) {
      setQuery(q);
      performSearch(q);
    }
  }, [searchParams]);

  const performSearch = async (searchTerm) => {
    if (!searchTerm || searchTerm.trim().length < 2) {
      setResults([]);
      return;
    }

    setIsLoading(true);
    setHasSearched(true);

    try {
      const response = await fetch(`/api/public/search?q=${encodeURIComponent(searchTerm.trim())}&limit=20`);
      if (response.ok) {
        const data = await response.json();
        setResults(data.results || []);
      }
    } catch (error) {
      console.error('Search error:', error);
      setResults([]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (query.trim().length >= 2) {
      setSearchParams({ q: query.trim() });
      performSearch(query);
    }
  };

  const groupedResults = results.reduce((acc, result) => {
    if (!acc[result.type]) {
      acc[result.type] = [];
    }
    acc[result.type].push(result);
    return acc;
  }, {});

  const formatDate = (dateString) => {
    if (!dateString) return '';
    try {
      return new Date(dateString).toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'short',
        year: 'numeric'
      });
    } catch {
      return '';
    }
  };

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="bg-white border-b border-slate-200">
        <div className="max-w-4xl mx-auto px-4 py-8">
          <h1 className="text-2xl font-bold text-slate-900 mb-6" style={{ fontFamily: 'Poppins, sans-serif' }}>
            Search Results
          </h1>
          
          <form onSubmit={handleSubmit} className="relative">
            <Search className="absolute left-4 top-1/2 transform -translate-y-1/2 w-5 h-5 text-slate-400" />
            <Input
              type="text"
              placeholder="Search events, articles, news, resources..."
              className="pl-12 pr-4 py-6 text-lg"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              data-testid="input-search-page"
            />
            <Button
              type="submit"
              className="absolute right-2 top-1/2 transform -translate-y-1/2"
              disabled={query.trim().length < 2}
              data-testid="button-search-submit"
            >
              Search
            </Button>
          </form>
        </div>
      </div>

      <div className="max-w-4xl mx-auto px-4 py-8">
        {isLoading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="w-8 h-8 animate-spin text-purple-600" />
            <span className="ml-3 text-slate-600">Searching...</span>
          </div>
        ) : hasSearched && results.length === 0 ? (
          <div className="text-center py-16">
            <Search className="w-16 h-16 mx-auto mb-4 text-slate-300" />
            <h2 className="text-xl font-semibold text-slate-700 mb-2">No results found</h2>
            <p className="text-slate-500">
              We couldn't find anything matching "{searchParams.get('q')}"
            </p>
            <p className="text-slate-400 text-sm mt-2">
              Try different keywords or check your spelling
            </p>
          </div>
        ) : results.length > 0 ? (
          <div className="space-y-8">
            <p className="text-slate-600">
              Found <span className="font-semibold">{results.length}</span> result{results.length !== 1 ? 's' : ''} for "{searchParams.get('q')}"
            </p>

            {Object.entries(groupedResults).map(([type, items]) => {
              const TypeIcon = typeIconMap[type] || FileText;
              return (
                <div key={type} className="space-y-4">
                  <div className="flex items-center gap-2 pb-2 border-b border-slate-200">
                    <TypeIcon className="w-5 h-5 text-slate-600" />
                    <h2 className="text-lg font-semibold text-slate-900">
                      {typeLabels[type] || type}s
                    </h2>
                    <Badge variant="secondary" className="ml-2">
                      {items.length}
                    </Badge>
                  </div>

                  <div className="grid gap-4">
                    {items.map((result) => (
                      <Link
                        key={`${result.type}-${result.id}`}
                        to={result.url}
                        className="block"
                        data-testid={`result-card-${result.type}-${result.id}`}
                      >
                        <Card className="hover:shadow-md transition-shadow">
                          <CardContent className="p-4">
                            <div className="flex gap-4">
                              {result.image && (
                                <div className="flex-shrink-0 w-24 h-24 rounded-lg overflow-hidden bg-slate-100">
                                  <img
                                    src={result.image}
                                    alt={result.title}
                                    className="w-full h-full object-cover"
                                    onError={(e) => {
                                      e.target.style.display = 'none';
                                    }}
                                  />
                                </div>
                              )}
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 mb-1">
                                  <Badge className={typeColors[result.type] || 'bg-slate-100 text-slate-700'}>
                                    {typeLabels[result.type]}
                                  </Badge>
                                  {result.date && (
                                    <span className="text-sm text-slate-500">
                                      {formatDate(result.date)}
                                    </span>
                                  )}
                                </div>
                                <h3 className="font-semibold text-slate-900 mb-1 line-clamp-1">
                                  {result.title}
                                </h3>
                                {result.description && (
                                  <p className="text-sm text-slate-600 line-clamp-2">
                                    {result.description}
                                  </p>
                                )}
                                <div className="flex items-center gap-1 mt-2 text-sm text-purple-600 font-medium">
                                  <span>View {typeLabels[result.type]?.toLowerCase()}</span>
                                  <ArrowRight className="w-4 h-4" />
                                </div>
                              </div>
                            </div>
                          </CardContent>
                        </Card>
                      </Link>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        ) : !hasSearched && (
          <div className="text-center py-16">
            <Search className="w-16 h-16 mx-auto mb-4 text-slate-300" />
            <h2 className="text-xl font-semibold text-slate-700 mb-2">Search our content</h2>
            <p className="text-slate-500">
              Find events, articles, news, and resources across our platform
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
