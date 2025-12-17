
import React, { useState } from "react";
import { base44 } from "@/api/base44Client";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Trash2, Loader2, AlertCircle, CheckCircle2, User, Info } from "lucide-react";

export default function AttendeeList({ attendees, onUpdate, onRemove, onAdd, memberInfo }) {
  const [validating, setValidating] = useState({});

  const validateEmail = async (index, email) => {
    if (!email || !email.includes('@')) {
      onUpdate(index, 'isValid', null);
      onUpdate(index, 'validationStatus', null);
      onUpdate(index, 'validationMessage', null);
      return;
    }

    setValidating(prev => ({ ...prev, [index]: true }));

    try {
      const response = await base44.functions.invoke('validateColleague', {
        email: email,
        memberEmail: memberInfo.email,
        organizationId: memberInfo.organization_id
      });

      if (response.data.valid) {
        onUpdate(index, 'isValid', true);
        onUpdate(index, 'validationStatus', response.data.status);
        onUpdate(index, 'validationMessage', response.data.message);
        
        // Only update names if they're provided (registered status)
        if (response.data.first_name) {
          onUpdate(index, 'first_name', response.data.first_name);
          onUpdate(index, 'last_name', response.data.last_name);
        }
      } else {
        // Validation returned invalid - preserve the status but allow manual entry
        onUpdate(index, 'isValid', true); // Allow booking to proceed
        onUpdate(index, 'validationStatus', response.data.status); // Preserve the actual status
        onUpdate(index, 'validationMessage', response.data.error || 'Could not verify. Please enter attendee details.');
      }
    } catch (error) {
      // Error occurred (500, network issue, etc.) - treat as external attendee
      console.error('Validation error:', error);
      onUpdate(index, 'isValid', true);
      onUpdate(index, 'validationStatus', 'external');
      onUpdate(index, 'validationMessage', 'Could not verify email. Please enter attendee details manually.');
    } finally {
      setValidating(prev => ({ ...prev, [index]: false }));
    }
  };

  const handleEmailBlur = (index, email) => {
    if (!attendees[index].isSelf) {
      validateEmail(index, email);
    }
  };

  const getCardStyle = (attendee) => {
    if (attendee.isSelf) return 'border-blue-200 bg-blue-50';
    
    switch (attendee.validationStatus) {
      case 'registered':
        return 'border-green-200 bg-green-50';
      case 'unregistered_domain_match':
        return 'border-blue-200 bg-blue-50';
      case 'external':
        return 'border-amber-200 bg-amber-50';
      case 'wrong_organization':
      case 'error':
        return 'border-red-200 bg-red-50';
      default:
        return 'border-slate-200 bg-white';
    }
  };

  const getIcon = (attendee) => {
    if (validating[attendees.indexOf(attendee)]) {
      return <Loader2 className="w-4 h-4 animate-spin text-slate-400" />;
    }

    switch (attendee.validationStatus) {
      case 'registered':
        return <CheckCircle2 className="w-4 h-4 text-green-600" />;
      case 'unregistered_domain_match':
        return <Info className="w-4 h-4 text-blue-600" />;
      case 'external':
        return <Info className="w-4 h-4 text-amber-600" />;
      case 'wrong_organization':
      case 'error':
        return <AlertCircle className="w-4 h-4 text-red-600" />;
      default:
        return null;
    }
  };

  const getMessageStyle = (status) => {
    switch (status) {
      case 'registered':
        return 'text-green-700';
      case 'unregistered_domain_match':
        return 'text-blue-700';
      case 'external':
        return 'text-amber-700';
      case 'wrong_organization':
      case 'error':
        return 'text-red-600';
      default:
        return 'text-slate-600';
    }
  };

  const needsManualName = (attendee) => {
    return !attendee.isSelf && 
           (attendee.validationStatus === 'unregistered_domain_match' || 
            attendee.validationStatus === 'external' ||
            attendee.validationStatus === 'wrong_organization');
  };

  // Check if attendee is missing required name fields
  const isMissingRequiredName = (attendee) => {
    return needsManualName(attendee) && (!attendee.first_name || !attendee.last_name);
  };

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      {attendees.map((attendee, index) => (
        <div key={index} className={`p-4 rounded-lg border ${getCardStyle(attendee)}`}>
          <div className="space-y-3">
            <div className="relative">
              <Input
                placeholder="Email address"
                type="email"
                value={attendee.email}
                onChange={(e) => onUpdate(index, 'email', e.target.value)}
                onBlur={(e) => handleEmailBlur(index, e.target.value)}
                disabled={attendee.isSelf}
                className={attendee.isSelf ? 'bg-blue-50' : ''}
              />
              {!attendee.isSelf && (
                <div className="absolute right-3 top-1/2 -translate-y-1/2">
                  {getIcon(attendee)}
                </div>
              )}
            </div>

            {needsManualName(attendee) && (
              <div className="space-y-2 pt-2 border-t border-slate-200">
                <p className="text-xs font-medium text-slate-700">Attendee Details Required</p>
                <div className="grid grid-cols-2 gap-2">
                  <Input
                    placeholder="First Name *"
                    value={attendee.first_name || ''}
                    onChange={(e) => onUpdate(index, 'first_name', e.target.value)}
                    className={`text-sm ${!attendee.first_name ? 'border-red-300 focus:border-red-500' : ''}`}
                    required
                  />
                  <Input
                    placeholder="Last Name *"
                    value={attendee.last_name || ''}
                    onChange={(e) => onUpdate(index, 'last_name', e.target.value)}
                    className={`text-sm ${!attendee.last_name ? 'border-red-300 focus:border-red-500' : ''}`}
                    required
                  />
                </div>
                {isMissingRequiredName(attendee) && (
                  <p className="text-xs text-red-600 flex items-center gap-1">
                    <AlertCircle className="w-3 h-3" />
                    Please enter first and last name to continue
                  </p>
                )}
              </div>
            )}

            <div className="flex items-center gap-2">
              {onRemove && (
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => onRemove(index)}
                  className="text-red-600 hover:text-red-700 hover:bg-red-50 h-8 w-8 shrink-0"
                  data-testid={`button-remove-attendee-${index}`}
                >
                  <Trash2 className="w-4 h-4" />
                </Button>
              )}
              
              {attendee.isSelf && (
                <div className="flex items-center gap-2 text-sm text-blue-600">
                  <User className="w-4 h-4" />
                  <span>This is you</span>
                </div>
              )}

              {!attendee.isSelf && attendee.validationStatus === 'registered' && attendee.first_name && (
                <div className="flex items-center gap-2 text-sm text-green-700">
                  <User className="w-4 h-4" />
                  <span>{attendee.first_name} {attendee.last_name}</span>
                </div>
              )}

              {!attendee.isSelf && attendee.validationMessage && 
               !(attendee.validationStatus === 'registered' && attendee.first_name) && (
                <p className={`text-xs flex items-start gap-1 flex-1 ${getMessageStyle(attendee.validationStatus)}`}>
                  {getIcon(attendee)}
                  <span className="flex-1">{attendee.validationMessage}</span>
                </p>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
