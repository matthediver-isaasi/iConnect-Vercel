import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Handshake, Image } from "lucide-react";
import { publicClient } from "@/api/publicClient";

export default function EventSponsorsCard({ eventId, eventType = "simple" }) {
  const { data } = useQuery({
    queryKey: ['public-event-sponsors', eventId],
    queryFn: () => publicClient.getEventSponsors(eventId),
    enabled: !!eventId
  });

  const sponsors = data?.sponsors || [];
  const categories = data?.categories || [];
  const assignments = data?.assignments || [];

  const sponsorMap = useMemo(() => {
    const map = {};
    sponsors.forEach(s => { map[s.id] = s; });
    return map;
  }, [sponsors]);

  const groupedSponsors = useMemo(() => {
    if (assignments.length === 0 || sponsors.length === 0) return [];

    const assignmentCategoryMap = {};
    assignments.forEach(a => {
      assignmentCategoryMap[a.sponsor_id] = a.category_id;
    });

    const sponsorIds = assignments.map(a => a.sponsor_id).filter(Boolean);
    const eventSponsors = sponsorIds
      .map(id => sponsorMap[id])
      .filter(Boolean);

    if (eventSponsors.length === 0) return [];

    const groups = {};
    const uncategorized = [];

    eventSponsors.forEach(sponsor => {
      const catId = assignmentCategoryMap[sponsor.id] || sponsor.category_id;
      if (catId) {
        if (!groups[catId]) groups[catId] = [];
        groups[catId].push(sponsor);
      } else {
        uncategorized.push(sponsor);
      }
    });

    const result = [];
    categories.forEach(cat => {
      if (groups[cat.id] && groups[cat.id].length > 0) {
        result.push({
          categoryName: cat.name,
          categoryId: cat.id,
          sponsors: groups[cat.id].sort((a, b) => a.name.localeCompare(b.name))
        });
      }
    });

    if (uncategorized.length > 0) {
      result.push({
        categoryName: result.length > 0 ? "Other Sponsors" : null,
        categoryId: null,
        sponsors: uncategorized.sort((a, b) => a.name.localeCompare(b.name))
      });
    }

    return result;
  }, [sponsors, sponsorMap, categories, assignments]);

  if (groupedSponsors.length === 0) return null;

  return (
    <Card className="border-slate-200" data-testid="card-event-sponsors">
      <CardContent className="p-6">
        <h2 className="text-lg font-semibold text-slate-900 mb-4 flex items-center gap-2" data-testid="text-sponsors-heading">
          <Handshake className="w-5 h-5 text-blue-600" />
          Sponsors
        </h2>
        <div className="space-y-6">
          {groupedSponsors.map((group, gi) => (
            <div key={group.categoryId || `uncategorized-${gi}`}>
              {group.categoryName && (
                <h3 className="text-sm font-medium text-slate-500 uppercase tracking-wider mb-3" data-testid={`text-sponsor-category-${gi}`}>
                  {group.categoryName}
                </h3>
              )}
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
                {group.sponsors.map(sponsor => (
                  <SponsorItem key={sponsor.id} sponsor={sponsor} />
                ))}
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function SponsorItem({ sponsor }) {
  const content = (
    <div className="flex flex-col items-center text-center gap-2 p-3 rounded-lg border border-slate-100 bg-slate-50/50" data-testid={`sponsor-item-${sponsor.id}`}>
      {sponsor.logo_url ? (
        <img
          src={sponsor.logo_url}
          alt={sponsor.name}
          className="w-20 h-14 object-contain"
          data-testid={`img-sponsor-${sponsor.id}`}
        />
      ) : (
        <div className="w-20 h-14 flex items-center justify-center">
          <Image className="h-8 w-8 text-slate-200" />
        </div>
      )}
      <span className="text-sm font-medium text-slate-700 leading-tight">{sponsor.name}</span>
      {sponsor.description && (
        <span className="text-xs text-slate-500 line-clamp-2">{sponsor.description}</span>
      )}
    </div>
  );

  if (sponsor.website_url) {
    return (
      <a
        href={sponsor.website_url}
        target="_blank"
        rel="noopener noreferrer"
        className="block hover:ring-2 hover:ring-blue-200 rounded-lg transition-shadow"
        data-testid={`link-sponsor-${sponsor.id}`}
      >
        {content}
      </a>
    );
  }

  return content;
}
