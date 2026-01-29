import React, { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { publicClient } from "@/api/publicClient";

export default function NewsTickerBar() {
  const [currentIndex, setCurrentIndex] = useState(0);

  // Load ticker settings from SystemSettings via public client (for unauthenticated access)
  const { data: settings = [] } = useQuery({
    queryKey: ["public-news-ticker-settings"],
    queryFn: async () => {
      try {
        const allSettings = await publicClient.listSystemSettings() || [];
        return allSettings.filter(s => 
          s.setting_key === 'news_ticker_count' || 
          s.setting_key === 'news_ticker_cycle_seconds' ||
          s.setting_key === 'news_ticker_enabled' ||
          s.setting_key === 'news_ticker_bottom_margin'
        );
      } catch (error) {
        console.error("Error loading news ticker settings:", error);
        return [];
      }
    }
  });

  const tickerEnabled =
    settings.find((s) => s.setting_key === "news_ticker_enabled")
      ?.setting_value === "true";

  const tickerCount =
    parseInt(
      settings.find((s) => s.setting_key === "news_ticker_count")?.setting_value
    ) || 3;

  const cycleSeconds =
    parseInt(
      settings.find(
        (s) => s.setting_key === "news_ticker_cycle_seconds"
      )?.setting_value
    ) || 5;

  const bottomMargin =
    parseInt(
      settings.find(
        (s) => s.setting_key === "news_ticker_bottom_margin"
      )?.setting_value
    ) || 0;

  // Load latest news posts via public client (for unauthenticated access)
  const { data: latestNews = [] } = useQuery({
    queryKey: ["public-latest-news-ticker", tickerCount],
    enabled: tickerEnabled,
    queryFn: async () => {
      try {
        const nowIso = new Date().toISOString();
        const allNews = await publicClient.listNews() || [];
        
        // Filter for published news with published_date <= now
        const publishedNews = allNews
          .filter(news => 
            news.status === 'published' && 
            news.published_date && 
            news.published_date <= nowIso
          )
          .sort((a, b) => new Date(b.published_date) - new Date(a.published_date))
          .slice(0, tickerCount);
        
        return publishedNews;
      } catch (error) {
        console.error("Error loading latest news for ticker:", error);
        return [];
      }
    },
    refetchInterval: 2 * 60 * 1000
  });

  // Cycle through news items
  useEffect(() => {
    if (latestNews.length <= 1) return;

    const interval = setInterval(() => {
      setCurrentIndex((prev) => (prev + 1) % latestNews.length);
    }, cycleSeconds * 1000);

    return () => clearInterval(interval);
  }, [latestNews.length, cycleSeconds]);

  if (!tickerEnabled || latestNews.length === 0) return null;

  return (
    <div 
      className="bg-gradient-to-r from-purple-600 to-blue-600 text-white overflow-hidden"
      style={{ marginBottom: bottomMargin > 0 ? `${bottomMargin}px` : undefined }}
    >
      <div className="max-w-7xl mx-auto px-4 py-3">
        <div className="flex items-center gap-3">
          <span className="text-xs font-semibold uppercase tracking-wider shrink-0 bg-white/20 px-2 py-1 rounded">
            Latest News
          </span>
          <div className="flex-1 relative h-6 overflow-hidden">
            {latestNews.map((news, index) => (
              <Link
                key={news.id}
                to={`${createPageUrl("NewsView")}?slug=${news.slug}`}
                className="absolute inset-0 flex items-center gap-2 hover:underline transition-all duration-500"
                style={{
                  transform: `translateY(${(index - currentIndex) * 100}%)`,
                  opacity: index === currentIndex ? 1 : 0,
                }}
              >
                <span className="truncate">{news.title}</span>
                <ChevronRight className="w-4 h-4 shrink-0" />
              </Link>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
