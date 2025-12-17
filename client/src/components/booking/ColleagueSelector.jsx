
import { useState, useEffect } from "react";
import { Input } from "@/components/ui/input";
import { Loader2, Search, Users } from "lucide-react";
import { createClient } from '@supabase/supabase-js';

// Initialize Supabase client for direct queries
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseAnonKey);

export default function ColleagueSelector({ organizationId, onSelect, memberInfo, ticketRoleIds = [] }) {
  const [searchTerm, setSearchTerm] = useState("");
  const [members, setMembers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showDropdown, setShowDropdown] = useState(false);
  const [loadError, setLoadError] = useState(null);

  // Load members directly from Supabase
  useEffect(() => {
    const loadMembers = async () => {
      if (!organizationId) {
        setLoading(false);
        return;
      }

      setLoading(true);
      setLoadError(null);
      
      try {
        console.log('[ColleagueSelector] Loading members from Supabase...');
        const { data, error } = await supabase
          .from('member')
          .select('id, email, first_name, last_name, zoho_contact_id, login_enabled, role_id')
          .eq('organization_id', organizationId)
          .eq('login_enabled', true)
          .order('first_name', { ascending: true });

        if (error) {
          console.error('[ColleagueSelector] Error loading members:', error);
          setMembers([]);
          setLoadError('Failed to load team members');
        } else {
          // Exclude the current member from the list
          let filteredMembers = (data || []).filter(
            m => m.email?.toLowerCase() !== memberInfo?.email?.toLowerCase()
          );
          
          // If ticketRoleIds is specified and not empty, filter by role
          if (ticketRoleIds && ticketRoleIds.length > 0) {
            console.log('[ColleagueSelector] Filtering by ticket role IDs:', ticketRoleIds);
            filteredMembers = filteredMembers.filter(m => {
              return m.role_id && ticketRoleIds.includes(m.role_id);
            });
          }
          
          console.log('[ColleagueSelector] Loaded', filteredMembers.length, 'eligible members');
          setMembers(filteredMembers);
        }
      } catch (error) {
        console.error('[ColleagueSelector] Load failed:', error);
        setLoadError('Failed to load team members');
        setMembers([]);
      } finally {
        setLoading(false);
      }
    };

    loadMembers();
  }, [organizationId, memberInfo?.email, JSON.stringify(ticketRoleIds)]);

  // Filter members based on search term
  const filteredMembers = members.filter(member => {
    if (!searchTerm) return false;
    const search = searchTerm.toLowerCase();
    const firstNameMatch = member.first_name?.toLowerCase().includes(search);
    const lastNameMatch = member.last_name?.toLowerCase().includes(search);
    const emailMatch = member.email?.toLowerCase().includes(search);
    
    return firstNameMatch || lastNameMatch || emailMatch;
  });

  const handleMemberSelect = (member) => {
    onSelect({
      email: member.email,
      first_name: member.first_name,
      last_name: member.last_name,
      zoho_contact_id: member.zoho_contact_id,
      isValid: true,
      validationStatus: 'registered'
    });
    setSearchTerm("");
    setShowDropdown(false);
  };

  if (loading) {
    return (
      <div className="p-4 border border-slate-200 rounded-lg bg-slate-50 text-center">
        <div className="flex items-center justify-center gap-2 mb-2">
          <Loader2 className="w-5 h-5 animate-spin text-blue-600" />
        </div>
        <p className="text-sm font-medium text-slate-700">Loading team members...</p>
      </div>
    );
  }

  return (
    <div className="relative">
      {/* Load error display */}
      {loadError && (
        <div className="mb-2 p-2 bg-amber-50 border border-amber-200 rounded-md text-xs text-amber-700">
          {loadError}
        </div>
      )}
      
      <div className="relative">
        <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-slate-400" />
        <Input
          placeholder="Search by name or email..."
          value={searchTerm}
          onChange={(e) => {
            setSearchTerm(e.target.value);
            setShowDropdown(e.target.value.length > 0);
          }}
          onFocus={() => searchTerm && setShowDropdown(true)}
          className="pl-10"
          data-testid="input-colleague-search"
        />
      </div>

      {/* Member count indicator */}
      {members.length > 0 && !showDropdown && (
        <div className="mt-2 flex items-center gap-2 text-xs text-slate-500">
          <Users className="w-3 h-3" />
          <span>{members.length} team member{members.length !== 1 ? 's' : ''} available</span>
        </div>
      )}

      {/* No members message */}
      {members.length === 0 && !loadError && (
        <div className="mt-2 text-xs text-slate-500">
          No other team members found in your organisation.
        </div>
      )}

      {showDropdown && searchTerm && (
        <div className="absolute z-10 w-full mt-1 bg-white border border-slate-200 rounded-lg shadow-lg max-h-60 overflow-y-auto">
          {filteredMembers.length > 0 ? (
            filteredMembers.map((member) => (
              <button
                key={member.id}
                onClick={() => handleMemberSelect(member)}
                className="w-full px-4 py-3 text-left hover:bg-slate-50 border-b border-slate-100 last:border-0 transition-colors"
                data-testid={`button-select-colleague-${member.id}`}
              >
                <div className="font-medium text-slate-900">
                  {member.first_name} {member.last_name}
                </div>
                <div className="text-sm text-slate-500">{member.email}</div>
              </button>
            ))
          ) : (
            <div className="p-4 text-center text-slate-500">
              <p className="text-sm">No matches found</p>
              <p className="text-xs mt-1">Try a different search term</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
