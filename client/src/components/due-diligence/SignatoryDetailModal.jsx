import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { 
  User, Check, Clock, FileSignature, Mail, Briefcase, Building2, Users, AlertCircle, Send, Loader2, UserPlus, CheckCircle2
} from "lucide-react";
import { format } from 'date-fns';
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/components/ui/use-toast";

const STATUS_CONFIG = {
  not_sent: { label: 'Not Sent', color: '#6b7280', bgColor: '#f3f4f6', icon: Clock },
  pending: { label: 'Pending', color: '#f59e0b', bgColor: '#fef3c7', icon: Clock },
  out_for_signing: { label: 'Pending', color: '#f59e0b', bgColor: '#fef3c7', icon: Clock },
  received: { label: 'Received', color: '#22c55e', bgColor: '#dcfce7', icon: Check },
  expired: { label: 'Expired', color: '#ef4444', bgColor: '#fee2e2', icon: AlertCircle }
};

function DetailRow({ icon: Icon, label, value }) {
  if (!value) return null;
  return (
    <div className="flex items-start gap-3 py-2">
      <div className="p-2 bg-muted rounded-md">
        <Icon className="w-4 h-4 text-muted-foreground" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-sm font-medium truncate">{value}</p>
      </div>
    </div>
  );
}

function SignerHistoryItem({ signer, onResend, isResending, isFieldSigned, isLegacyAmbiguous }) {
  const statusConfig = STATUS_CONFIG[signer.status] || STATUS_CONFIG.pending;
  const StatusIcon = statusConfig.icon;
  const fullName = [signer.firstName, signer.lastName].filter(Boolean).join(' ') || 'Unknown';
  const canResend = !isFieldSigned && !isLegacyAmbiguous && signer.status !== 'received' && signer.contractId;
  const isWinner = signer.status === 'received';
  
  return (
    <div 
      className={`flex items-center gap-3 p-3 rounded-lg border ${isWinner ? 'border-green-500 bg-green-50' : ''}`}
      data-testid={`signer-history-item-${signer.email}`}
    >
      <div className="p-2 bg-muted rounded-md">
        <User className="w-4 h-4 text-muted-foreground" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium truncate">{fullName}</p>
          {isWinner && (
            <Badge variant="outline" className="text-xs border-green-500 text-green-600">
              <CheckCircle2 className="w-3 h-3 mr-1" />
              Signed
            </Badge>
          )}
        </div>
        <p className="text-xs text-muted-foreground truncate">{signer.email}</p>
        <div className="flex items-center gap-2 mt-1 flex-wrap">
          <Badge 
            variant="outline" 
            className="text-xs"
            style={{ borderColor: statusConfig.color, color: statusConfig.color }}
          >
            <StatusIcon className="w-3 h-3 mr-1" />
            {statusConfig.label}
          </Badge>
          {signer.sentAt && (
            <span className="text-xs text-muted-foreground">
              Sent {format(new Date(signer.sentAt), 'MMM d, yyyy')}
            </span>
          )}
          {signer.signedAt && (
            <span className="text-xs text-green-600">
              Signed {format(new Date(signer.signedAt), 'MMM d, yyyy')}
            </span>
          )}
        </div>
      </div>
      {canResend && (
        <Button
          size="sm"
          variant="outline"
          onClick={() => onResend(signer)}
          disabled={isResending}
          data-testid={`button-resend-${signer.email}`}
        >
          {isResending ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <>
              <Send className="w-4 h-4 mr-1" />
              Resend
            </>
          )}
        </Button>
      )}
    </div>
  );
}

function AddAlternativeSignerForm({ onSubmit, isSubmitting, isDisabled, isLegacyAmbiguous }) {
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!firstName.trim() || !email.trim()) return;
    onSubmit({ firstName: firstName.trim(), lastName: lastName.trim(), email: email.trim() });
  };

  const resetForm = () => {
    setFirstName('');
    setLastName('');
    setEmail('');
  };

  if (isLegacyAmbiguous) {
    return (
      <div className="p-4 bg-amber-50 border border-amber-200 rounded-lg text-center">
        <AlertCircle className="w-8 h-8 text-amber-500 mx-auto mb-2" />
        <p className="text-sm font-medium text-amber-700">Ambiguous contract data</p>
        <p className="text-xs text-amber-600 mt-1">Cannot add signers due to legacy data. Please contact support.</p>
      </div>
    );
  }

  if (isDisabled) {
    return (
      <div className="p-4 bg-green-50 border border-green-200 rounded-lg text-center">
        <CheckCircle2 className="w-8 h-8 text-green-500 mx-auto mb-2" />
        <p className="text-sm font-medium text-green-700">This field has been signed</p>
        <p className="text-xs text-green-600 mt-1">No additional signers can be added</p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="p-4 bg-muted/50 rounded-lg space-y-4">
      <h4 className="text-sm font-semibold flex items-center gap-2">
        <UserPlus className="w-4 h-4" />
        Add Alternative Signer
      </h4>
      <p className="text-xs text-muted-foreground">
        Add another person who can sign this document. The first person to sign will be recorded.
      </p>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label htmlFor="alt-first-name" className="text-xs">First Name *</Label>
          <Input
            id="alt-first-name"
            value={firstName}
            onChange={(e) => setFirstName(e.target.value)}
            placeholder="First name"
            required
            data-testid="input-alt-first-name"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="alt-last-name" className="text-xs">Last Name</Label>
          <Input
            id="alt-last-name"
            value={lastName}
            onChange={(e) => setLastName(e.target.value)}
            placeholder="Last name"
            data-testid="input-alt-last-name"
          />
        </div>
      </div>
      <div className="space-y-1">
        <Label htmlFor="alt-email" className="text-xs">Email Address *</Label>
        <Input
          id="alt-email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="email@example.com"
          required
          data-testid="input-alt-email"
        />
      </div>
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={resetForm}
          data-testid="button-reset-alt-signer"
        >
          Clear
        </Button>
        <Button
          type="submit"
          size="sm"
          disabled={isSubmitting || !firstName.trim() || !email.trim()}
          data-testid="button-add-alt-signer"
        >
          {isSubmitting ? (
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
          ) : (
            <Send className="w-4 h-4 mr-2" />
          )}
          Add & Send Contract
        </Button>
      </div>
    </form>
  );
}

export default function SignatoryDetailModal({ 
  isOpen, 
  onClose, 
  signatory,
  fieldSignerHistory = [],
  isFieldSigned = false,
  isLegacyAmbiguous = false,
  formSubmissionId
}) {
  const [activeTab, setActiveTab] = useState('active');
  const [resendingEmail, setResendingEmail] = useState(null);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const resendMutation = useMutation({
    mutationFn: async (signer) => {
      return apiRequest('POST', `/api/contracts/resend`, {
        contractInstanceId: signer.contractId,
        signerEmail: signer.email
      });
    },
    onSuccess: () => {
      toast({
        title: "Contract Resent",
        description: "The contract has been resent to the signer.",
      });
      queryClient.invalidateQueries({ queryKey: ['/api/contracts/by-submission', formSubmissionId] });
      setResendingEmail(null);
    },
    onError: (error) => {
      toast({
        title: "Error",
        description: error.message || "Failed to resend contract.",
        variant: "destructive",
      });
      setResendingEmail(null);
    }
  });

  const addSignerMutation = useMutation({
    mutationFn: async (newSigner) => {
      return apiRequest('POST', `/api/contracts/add-signer`, {
        formSubmissionId,
        fieldId: signatory?.fieldId,
        contractFormId: signatory?.contractFormId,
        signer: newSigner
      });
    },
    onSuccess: () => {
      toast({
        title: "Signer Added",
        description: "The new signer has been added and the contract has been sent.",
      });
      queryClient.invalidateQueries({ queryKey: ['/api/contracts/by-submission', formSubmissionId] });
    },
    onError: (error) => {
      toast({
        title: "Error",
        description: error.message || "Failed to add signer.",
        variant: "destructive",
      });
    }
  });

  const handleResend = (signer) => {
    setResendingEmail(signer.email);
    resendMutation.mutate(signer);
  };

  const handleAddSigner = (newSigner) => {
    addSignerMutation.mutate(newSigner);
  };

  if (!signatory) return null;

  const statusConfig = STATUS_CONFIG[signatory.status] || STATUS_CONFIG.pending;
  const StatusIcon = statusConfig.icon;
  const fullName = [signatory.firstName, signatory.lastName].filter(Boolean).join(' ') || 'Unknown';
  const canResendActive = !isFieldSigned && !isLegacyAmbiguous && signatory.status !== 'received' && signatory.contractId;

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col" data-testid="signatory-detail-modal">
        <DialogHeader className="flex-shrink-0">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3 min-w-0">
              <div className="p-2 bg-muted rounded-md">
                <FileSignature className="w-5 h-5" />
              </div>
              <div className="min-w-0">
                <DialogTitle className="text-lg truncate">{signatory.fieldLabel || 'Signatory'}</DialogTitle>
                <p className="text-sm text-muted-foreground truncate">{signatory.contractName}</p>
              </div>
            </div>
            {isFieldSigned ? (
              <Badge className="flex-shrink-0 bg-green-100 text-green-700 border-green-300">
                <CheckCircle2 className="w-3 h-3 mr-1" />
                Completed
              </Badge>
            ) : (
              <Badge 
                className="flex-shrink-0"
                style={{ 
                  backgroundColor: statusConfig.bgColor, 
                  color: statusConfig.color,
                  borderColor: statusConfig.color
                }}
              >
                <StatusIcon className="w-3 h-3 mr-1" />
                {statusConfig.label}
              </Badge>
            )}
          </div>
        </DialogHeader>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col overflow-hidden">
          <TabsList className="w-full justify-start flex-shrink-0">
            <TabsTrigger value="active" className="flex items-center gap-2" data-testid="tab-active">
              <User className="w-4 h-4" />
              Active
            </TabsTrigger>
            <TabsTrigger value="all" className="flex items-center gap-2" data-testid="tab-all">
              <Users className="w-4 h-4" />
              All ({fieldSignerHistory.length})
            </TabsTrigger>
          </TabsList>

          <TabsContent value="active" className="flex-1 overflow-hidden mt-4">
            <ScrollArea className="h-full">
              <div className="space-y-4 pr-4">
                <div className="p-4 bg-muted/50 rounded-lg">
                  <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
                    <User className="w-4 h-4" />
                    Current Signer Details
                  </h3>
                  <div className="space-y-1">
                    <DetailRow 
                      icon={User} 
                      label="Full Name" 
                      value={fullName} 
                    />
                    <DetailRow 
                      icon={Mail} 
                      label="Email" 
                      value={signatory.email} 
                    />
                    <DetailRow 
                      icon={Briefcase} 
                      label="Job Title" 
                      value={signatory.jobTitle} 
                    />
                    <DetailRow 
                      icon={Building2} 
                      label="Organisation" 
                      value={signatory.organisation} 
                    />
                  </div>
                </div>

                <Separator />

                <div className="p-4 bg-muted/50 rounded-lg">
                  <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
                    <FileSignature className="w-4 h-4" />
                    Contract Status
                  </h3>
                  <div className="space-y-1">
                    <DetailRow 
                      icon={FileSignature} 
                      label="Contract Template" 
                      value={signatory.contractName} 
                    />
                    <DetailRow 
                      icon={Clock} 
                      label="Status" 
                      value={isFieldSigned ? 'Completed' : statusConfig.label} 
                    />
                    {signatory.signedAt && (
                      <DetailRow 
                        icon={Check} 
                        label="Signed At" 
                        value={format(new Date(signatory.signedAt), 'MMM d, yyyy h:mm a')} 
                      />
                    )}
                    {signatory.sentAt && !signatory.signedAt && (
                      <DetailRow 
                        icon={Mail} 
                        label="Sent At" 
                        value={format(new Date(signatory.sentAt), 'MMM d, yyyy h:mm a')} 
                      />
                    )}
                  </div>
                </div>

                {canResendActive && (
                  <>
                    <Separator />
                    <div className="flex justify-end">
                      <Button
                        onClick={() => handleResend(signatory)}
                        disabled={resendingEmail === signatory.email}
                        data-testid="button-resend-active"
                      >
                        {resendingEmail === signatory.email ? (
                          <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        ) : (
                          <Send className="w-4 h-4 mr-2" />
                        )}
                        Resend Contract
                      </Button>
                    </div>
                  </>
                )}

                {isFieldSigned && (
                  <div className="p-4 bg-green-50 border border-green-200 rounded-lg text-center">
                    <CheckCircle2 className="w-8 h-8 text-green-500 mx-auto mb-2" />
                    <p className="text-sm font-medium text-green-700">This document has been signed</p>
                  </div>
                )}
              </div>
            </ScrollArea>
          </TabsContent>

          <TabsContent value="all" className="flex-1 overflow-hidden mt-4">
            <ScrollArea className="h-full">
              <div className="space-y-4 pr-4">
                <div>
                  <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
                    <Users className="w-4 h-4" />
                    Signer History for this Field
                  </h3>
                  <p className="text-xs text-muted-foreground mb-4">
                    Everyone who has been asked to sign this document. The first to complete it wins.
                  </p>
                  
                  {fieldSignerHistory.length > 0 ? (
                    <div className="space-y-2">
                      {fieldSignerHistory.map((signer, index) => (
                        <SignerHistoryItem 
                          key={`${signer.contractId || 'no-contract'}-${signer.email}-${index}`}
                          signer={signer}
                          onResend={handleResend}
                          isResending={resendingEmail === signer.email}
                          isFieldSigned={isFieldSigned}
                          isLegacyAmbiguous={isLegacyAmbiguous}
                        />
                      ))}
                    </div>
                  ) : (
                    <div className="text-center py-6 text-muted-foreground border rounded-lg">
                      <Users className="w-10 h-10 mx-auto mb-2 opacity-50" />
                      <p className="text-sm">No signers have been contacted yet</p>
                    </div>
                  )}
                </div>

                <Separator />

                <AddAlternativeSignerForm 
                  onSubmit={handleAddSigner}
                  isSubmitting={addSignerMutation.isPending}
                  isDisabled={isFieldSigned || isLegacyAmbiguous}
                  isLegacyAmbiguous={isLegacyAmbiguous}
                />
              </div>
            </ScrollArea>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
