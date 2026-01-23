import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { 
  User, Check, Clock, FileSignature, Mail, Briefcase, Building2, Users, AlertCircle, Send, Loader2
} from "lucide-react";
import { format } from 'date-fns';
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

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

function SignerListItem({ signer, isActive, onResend, isResending, showContractName = false }) {
  const statusConfig = STATUS_CONFIG[signer.status] || STATUS_CONFIG.pending;
  const StatusIcon = statusConfig.icon;
  const fullName = [signer.firstName, signer.lastName].filter(Boolean).join(' ') || 'Unknown';
  const canResend = signer.status !== 'received' && signer.contractId;
  
  return (
    <div 
      className={`flex items-center gap-3 p-3 rounded-lg border ${isActive ? 'border-primary bg-primary/5' : ''}`}
      data-testid={`signer-list-item-${signer.email}`}
    >
      <div className="p-2 bg-muted rounded-md">
        <User className="w-4 h-4 text-muted-foreground" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium truncate">{fullName}</p>
          {isActive && (
            <Badge variant="outline" className="text-xs">Active</Badge>
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
          {showContractName && signer.contractName && (
            <span className="text-xs text-muted-foreground flex items-center gap-1">
              <FileSignature className="w-3 h-3" />
              {signer.contractName}
            </span>
          )}
          {signer.sentAt && (
            <span className="text-xs text-muted-foreground">
              Sent {format(new Date(signer.sentAt), 'MMM d, yyyy')}
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

export default function SignatoryDetailModal({ 
  isOpen, 
  onClose, 
  signatory,
  allSignatories = [],
  formSubmissionId
}) {
  const [activeTab, setActiveTab] = useState('active');
  const [resendingEmail, setResendingEmail] = useState(null);
  const { toast } = useToast();

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

  const handleResend = (signer) => {
    setResendingEmail(signer.email);
    resendMutation.mutate(signer);
  };

  if (!signatory) return null;

  const statusConfig = STATUS_CONFIG[signatory.status] || STATUS_CONFIG.pending;
  const StatusIcon = statusConfig.icon;
  const fullName = [signatory.firstName, signatory.lastName].filter(Boolean).join(' ') || 'Unknown';

  const signatoryList = allSignatories.length > 0 ? allSignatories : [signatory];

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col" data-testid="signatory-detail-modal">
        <DialogHeader className="flex-shrink-0">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3 min-w-0">
              <div className="p-2 bg-muted rounded-md">
                <User className="w-5 h-5" />
              </div>
              <div className="min-w-0">
                <DialogTitle className="text-lg truncate">{fullName}</DialogTitle>
                <p className="text-sm text-muted-foreground truncate">{signatory.email}</p>
              </div>
            </div>
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
              All
            </TabsTrigger>
          </TabsList>

          <TabsContent value="active" className="flex-1 overflow-hidden mt-4">
            <ScrollArea className="h-full">
              <div className="space-y-4 pr-4">
                <div className="p-4 bg-muted/50 rounded-lg">
                  <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
                    <User className="w-4 h-4" />
                    Contact Details
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
                    Contract Details
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
                      value={statusConfig.label} 
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

                {signatory.status !== 'received' && signatory.contractId && (
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
              </div>
            </ScrollArea>
          </TabsContent>

          <TabsContent value="all" className="flex-1 overflow-hidden mt-4">
            <ScrollArea className="h-full">
              <div className="pr-4">
                <h3 className="text-sm font-semibold mb-4 flex items-center gap-2">
                  <Users className="w-4 h-4" />
                  All Signers ({signatoryList.length})
                </h3>
                
                {signatoryList.length > 0 ? (
                  <div className="space-y-2">
                    {signatoryList.map((signer, index) => (
                      <SignerListItem 
                        key={`${signer.contractId || 'no-contract'}-${signer.email}-${index}`}
                        signer={signer}
                        isActive={signer.email === signatory.email && signer.contractId === signatory.contractId}
                        onResend={handleResend}
                        isResending={resendingEmail === signer.email}
                        showContractName={true}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="text-center py-8 text-muted-foreground">
                    <Users className="w-12 h-12 mx-auto mb-3 opacity-50" />
                    <p>No signers found</p>
                  </div>
                )}
              </div>
            </ScrollArea>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
