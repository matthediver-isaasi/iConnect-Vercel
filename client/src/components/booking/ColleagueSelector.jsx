
import { useState, useEffect } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Loader2, Search, Mail, Users } from "lucide-react";
import { createClient } from '@supabase/supabase-js';

// Initialize Supabase client for direct queries
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseAnonKey);

export default function ColleagueSelector({ organizationId, onSelect, memberInfo, ticketRoleIds = [] }) {
  const [searchTerm, setSearchTerm] = useState("");
  const [members, setMembers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(true);
  const [syncComplete, setSyncComplete] = useState(false);
  const [showManualEntry, setShowManualEntry] = useState(false);
  const [manualEmail, setManualEmail] = useState("");
  const [validating, setValidating] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);
  const [syncError, setSyncError] = useState(null);

  // Load members directly from Supabase (no CRM sync on this page)
  useEffect(() => {
    const loadMembers = async () => {
      if (!organizationId) {
        setSyncing(false);
        setSyncComplete(true);
        return;
      }

      setSyncing(true);
      setSyncError(null);
      
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
        } else {
          // Exclude the current member from the list
          let filteredMembers = (data || []).filter(
            m => m.email?.toLowerCase() !== memberInfo?.email?.toLowerCase()
          );
          
          // If ticketRoleIds is specified and not empty, filter by role
          if (ticketRoleIds && ticketRoleIds.length > 0) {
            console.log('[ColleagueSelector] Filtering by ticket role IDs:', ticketRoleIds);
            filteredMembers = filteredMembers.filter(m => {
              // Only include members whose role_id is in the ticket's role_ids
              return m.role_id && ticketRoleIds.includes(m.role_id);
            });
          }
          
          console.log('[ColleagueSelector] Loaded', filteredMembers.length, 'eligible members');
          setMembers(filteredMembers);
        }
      } catch (error) {
        console.error('[ColleagueSelector] Load failed:', error);
        setSyncError('Failed to load colleagues');
        setMembers([]);
      } finally {
        setSyncing(false);
        setSyncComplete(true);
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

  const handleManualSubmit = async () => {
    if (!manualEmail || !manualEmail.includes('@')) return;

    setValidating(true);
    
    try {
      // Check if email exists in the member table for this organization
      // Use maybeSingle() instead of single() to avoid 406 error when no member found
      const { data: existingMember, error } = await supabase
        .from('member')
        .select('id, email, first_name, last_name, zoho_contact_id, login_enabled')
        .eq('email', manualEmail.toLowerCase())
        .eq('organization_id', organizationId)
        .limit(1)
        .maybeSingle();

      if (error) {
        console.error('[ColleagueSelector] Member lookup error:', error);
        // For any error, treat as external email
        onSelect({
          email: manualEmail,
          first_name: "",
          last_name: "",
          isValid: true,
          validationStatus: 'external',
          validationMessage: 'External attendee - will be registered with this email'
        });
        setManualEmail("");
        setShowManualEntry(false);
        return;
      }
      
      if (!existingMember) {
        // Email not found in organization - treat as valid external attendee
        onSelect({
          email: manualEmail,
          first_name: "",
          last_name: "",
          isValid: true,
          validationStatus: 'external',
          validationMessage: 'External attendee - will be registered with this email'
        });
      } else if (!existingMember.login_enabled) {
        // Member exists but is not active
        onSelect({
          email: manualEmail,
          first_name: existingMember.first_name || "",
          last_name: existingMember.last_name || "",
          isValid: false,
          validationStatus: 'inactive',
          validationMessage: 'This member account is not currently active'
        });
      } else {
        // Valid active member
        onSelect({
          email: manualEmail,
          first_name: existingMember.first_name || "",
          last_name: existingMember.last_name || "",
          zoho_contact_id: existingMember.zoho_contact_id,
          isValid: true,
          validationStatus: 'registered',
          validationMessage: 'Colleague verified'
        });
      }
      
      setManualEmail("");
      setShowManualEntry(false);
    } catch (error) {
      console.error('[ColleagueSelector] Manual validation error:', error);
      onSelect({
        email: manualEmail,
        first_name: "",
        last_name: "",
        isValid: false,
        validationStatus: 'error',
        validationMessage: 'Validation failed'
      });
      setManualEmail("");
      setShowManualEntry(false);
    } finally {
      setValidating(false);
    }
  };

  if (syncing) {
    return (
      <div className="p-4 border border-slate-200 rounded-lg bg-slate-50 text-center">
        <div className="flex items-center justify-center gap-2 mb-2">
          <Loader2 className="w-5 h-5 animate-spin text-blue-600" />
        </div>
        <p className="text-sm font-medium text-slate-700">Loading colleagues...</p>
      </div>
    );
  }

  if (showManualEntry) {
    return (
      <div className="space-y-2">
        <div className="flex gap-2">
          <Input
            placeholder="Enter email address"
            type="email"
            value={manualEmail}
            onChange={(e) => setManualEmail(e.target.value)}
            onKeyPress={(e) => e.key === 'Enter' && handleManualSubmit()}
            disabled={validating}
            autoFocus
            data-testid="input-manual-colleague-email"
          />
          <Button onClick={handleManualSubmit} size="sm" disabled={validating} data-testid="button-add-manual-colleague">
            {validating ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              'Add'
            )}
          </Button>
        </div>
        <Button 
          variant="ghost" 
          size="sm"
          onClick={() => setShowManualEntry(false)}
          className="text-xs"
          disabled={validating}
          data-testid="button-back-to-search"
        >
          ← Back to search
        </Button>
      </div>
    );
  }

  return (
    <div className="relative">
      {/* Sync error display */}
      {syncError && (
        <div className="mb-2 p-2 bg-amber-50 border border-amber-200 rounded-md text-xs text-amber-700">
          {syncError} - showing cached data
        </div>
      )}
      
      <div className="relative">
        <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-slate-400" />
        <Input
          placeholder={syncComplete ? "Search by name or email..." : "Syncing..."}
          value={searchTerm}
          onChange={(e) => {
            setSearchTerm(e.target.value);
            setShowDropdown(e.target.value.length > 0);
          }}
          onFocus={() => searchTerm && setShowDropdown(true)}
          className="pl-10"
          disabled={!syncComplete || loading}
          data-testid="input-colleague-search"
        />
      </div>

      {/* Member count indicator */}
      {syncComplete && members.length > 0 && !showDropdown && (
        <div className="mt-2 flex items-center gap-2 text-xs text-slate-500">
          <Users className="w-3 h-3" />
          <span>{members.length} active colleague{members.length !== 1 ? 's' : ''} available</span>
        </div>
      )}

      {showDropdown && searchTerm && (
        <div className="absolute z-10 w-full mt-1 bg-white border border-slate-200 rounded-lg shadow-lg max-h-60 overflow-y-auto">
          {loading ? (
            <div className="p-4 text-center text-slate-500">
              <Loader2 className="w-4 h-4 animate-spin mx-auto mb-1" />
              <p className="text-sm">Loading...</p>
            </div>
          ) : filteredMembers.length > 0 ? (
            <>
              {filteredMembers.map((member) => (
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
              ))}
              <button
                onClick={() => {
                  setShowManualEntry(true);
                  setShowDropdown(false);
                }}
                className="w-full px-4 py-3 text-left hover:bg-blue-50 border-t border-slate-200 transition-colors"
                data-testid="button-enter-email-manually"
              >
                <div className="flex items-center gap-2 text-blue-600">
                  <Mail className="w-4 h-4" />
                  <span className="text-sm font-medium">Can't find them? Enter email manually</span>
                </div>
              </button>
            </>
          ) : (
            <div className="p-4">
              <p className="text-sm text-slate-500 mb-3">No matches found</p>
              <button
                onClick={() => {
                  setShowManualEntry(true);
                  setShowDropdown(false);
                }}
                className="w-full px-4 py-2 text-left bg-blue-50 hover:bg-blue-100 rounded-lg transition-colors"
                data-testid="button-enter-email-manually-no-results"
              >
                <div className="flex items-center gap-2 text-blue-600">
                  <Mail className="w-4 h-4" />
                  <span className="text-sm font-medium">Enter email manually</span>
                </div>
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
