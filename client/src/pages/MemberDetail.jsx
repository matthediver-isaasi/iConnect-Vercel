import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { Loader2 } from "lucide-react";
import React, { Suspense, lazy } from "react";
import { useMemberAccess } from "@/hooks/useMemberAccess";

// Lazy load MemberDetailView to isolate its render cycle
const MemberDetailView = lazy(() => import("@/components/MemberDetailView"));

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
    <Suspense fallback={<div className="flex items-center justify-center h-screen"><Loader2 className="w-8 h-8 animate-spin text-blue-600" /></div>}>
      <MemberDetailView
        key={id}
        member={member}
        memberCustomFields={memberCustomFields}
        organizations={organizations}
        roles={roles}
      />
    </Suspense>
  );
}
