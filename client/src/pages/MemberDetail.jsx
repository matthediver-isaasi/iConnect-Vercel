import { useParams, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { Loader2 } from "lucide-react";
import MemberDetailView from "@/components/MemberDetailView";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { Button } from "@/components/ui/button";

export default function MemberDetail() {
  const { id } = useParams();
  const { isAccessReady } = useMemberAccess();

  const { data: member, isLoading: memberLoading } = useQuery({
    queryKey: ['member-detail', id],
    enabled: isAccessReady && !!id,
    queryFn: async () => {
      return await base44.entities.Member.get(id);
    }
  });

  const { data: organizations = [] } = useQuery({
    queryKey: ['organizations-for-member-detail'],
    enabled: isAccessReady,
    queryFn: async () => {
      return await base44.entities.Organization.list('name');
    }
  });

  const { data: roles = [] } = useQuery({
    queryKey: ['roles-for-member-detail'],
    enabled: isAccessReady,
    queryFn: async () => {
      return await base44.entities.Role.list();
    }
  });

  const { data: memberCustomFields = [] } = useQuery({
    queryKey: ['member-custom-fields-detail'],
    enabled: isAccessReady,
    queryFn: async () => {
      try {
        const fields = await base44.entities.PreferenceField.list({
          filter: { is_active: true, entity_scope: 'member' },
          sort: { display_order: 'asc' }
        });
        return (fields || []).filter(f => f.entity_scope === 'member');
      } catch {
        try {
          const allFields = await base44.entities.PreferenceField.list({
            filter: { is_active: true },
            sort: { display_order: 'asc' }
          });
          return (allFields || []).filter(f => !f.entity_scope || f.entity_scope === 'member');
        } catch {
          return [];
        }
      }
    }
  });

  if (memberLoading || !member) {
    return (
      <div className="flex items-center justify-center h-screen">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  return (
    <div>
      {/* DEBUG: Test navigation links at page level */}
      <div className="fixed top-0 right-0 z-[9999] bg-red-500 text-white p-2 flex gap-2">
        <Link to="/members" className="underline">Link to /members</Link>
        <Button asChild size="sm" variant="secondary">
          <Link to="/Events">Go Events</Link>
        </Button>
      </div>
      <MemberDetailView
        member={member}
        memberCustomFields={memberCustomFields}
        organizations={organizations}
        roles={roles}
      />
    </div>
  );
}
