import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { 
  User, Check, Clock, FileSignature, AlertCircle, Send, Loader2, UserPlus, CheckCircle2, Download, X, ExternalLink, Eye
} from "lucide-react";
import { format } from 'date-fns';
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/components/ui/use-toast";

const STATUS_CONFIG = {
  not_sent: { label: 'Not Sent', color: '#6b7280', bgColor: '#f3f4f6', icon: Clock },
  draft: { label: 'Not Sent', color: '#6b7280', bgColor: '#f3f4f6', icon: Clock },
  pending: { label: 'Pending', color: '#f59e0b', bgColor: '#fef3c7', icon: Clock },
  out_for_signing: { label: 'Pending', color: '#f59e0b', bgColor: '#fef3c7', icon: Clock },
  received: { label: 'Signed', color: '#22c55e', bgColor: '#dcfce7', icon: Check },
  expired: { label: 'Expired', color: '#ef4444', bgColor: '#fee2e2', icon: AlertCircle }
};

function SignerRow({ signer, onSend, onDownload, isSending, isDownloading, isFieldSigned, isLegacyAmbiguous }) {
  const statusConfig = STATUS_CONFIG[signer.status] || STATUS_CONFIG.pending;
  const StatusIcon = statusConfig.icon;
  const fullName = [signer.firstName, signer.lastName].filter(Boolean).join(' ') || 'Unknown';
  const isWinner = signer.status === 'received' || signer.signed;
  const isNotSent = signer.status === 'not_sent' || signer.status === 'draft';
  const hasValidEmail = !!signer.email;
  const canSend = !isFieldSigned && !isLegacyAmbiguous && !isWinner && hasValidEmail;
  const buttonLabel = isNotSent ? 'Send' : 'Resend';
  const canDownload = isWinner && signer.submission_id;
  
  return (
    <div 
      className={`flex items-center gap-3 p-3 rounded-lg border ${isWinner ? 'border-green-500 bg-green-50' : ''}`}
      data-testid={`signer-row-${signer.email}`}
    >
      <div className="p-2 bg-muted rounded-md flex-shrink-0">
        <User className="w-4 h-4 text-muted-foreground" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium truncate">{fullName}</p>
          {signer.isOriginal && (
            <Badge variant="secondary" className="text-xs flex-shrink-0">Original</Badge>
          )}
        </div>
        <p className="text-xs text-muted-foreground truncate">{signer.email}</p>
      </div>
      <Badge 
        variant="outline" 
        className="flex-shrink-0 text-xs"
        style={{ borderColor: statusConfig.color, color: statusConfig.color }}
      >
        <StatusIcon className="w-3 h-3 mr-1" />
        {statusConfig.label}
      </Badge>
      {canDownload && (
        <Button
          size="icon"
          variant="ghost"
          onClick={() => onDownload(signer.submission_id)}
          disabled={isDownloading}
          className="flex-shrink-0"
          title="View signed PDF"
          data-testid={`button-download-${signer.email}`}
        >
          {isDownloading ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Eye className="w-4 h-4" />
          )}
        </Button>
      )}
      {canSend ? (
        <Button
          size="sm"
          variant="outline"
          onClick={() => onSend(signer)}
          disabled={isSending}
          className="flex-shrink-0"
          data-testid={`button-send-${signer.email}`}
        >
          {isSending ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <>
              <Send className="w-4 h-4 mr-1" />
              {buttonLabel}
            </>
          )}
        </Button>
      ) : isWinner ? (
        <Badge className="flex-shrink-0 bg-green-100 text-green-700 border-green-300">
          <CheckCircle2 className="w-3 h-3 mr-1" />
          Winner
        </Badge>
      ) : null}
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
        Add another person who can sign this document. Use the Send button to send them the contract.
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
      <div className="flex justify-end">
        <Button
          type="submit"
          size="sm"
          disabled={isSubmitting || !firstName.trim() || !email.trim()}
          data-testid="button-add-alt-signer"
        >
          {isSubmitting ? (
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
          ) : (
            <UserPlus className="w-4 h-4 mr-2" />
          )}
          Add Signer
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
  const [sendingEmail, setSendingEmail] = useState(null);
  const [downloadingSubmissionId, setDownloadingSubmissionId] = useState(null);
  const [pdfPreview, setPdfPreview] = useState({ isOpen: false, url: null, fileName: null });
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const sendMutation = useMutation({
    mutationFn: async (signer) => {
      if (signer.contractId) {
        return apiRequest('POST', `/api/contracts/resend`, {
          contractInstanceId: signer.contractId,
          signerEmail: signer.email
        });
      } else {
        return apiRequest('POST', `/api/contracts/send-original`, {
          formSubmissionId,
          fieldId: signatory?.fieldId,
          contractFormId: signatory?.contractFormId,
          signer: {
            firstName: signer.firstName,
            lastName: signer.lastName,
            email: signer.email
          }
        });
      }
    },
    onSuccess: () => {
      toast({
        title: "Contract Sent",
        description: "The contract has been sent to the signer.",
      });
      queryClient.invalidateQueries({ queryKey: ['/api/contracts/by-submission', formSubmissionId] });
      setSendingEmail(null);
    },
    onError: (error) => {
      toast({
        title: "Error",
        description: error.message || "Failed to send contract.",
        variant: "destructive",
      });
      setSendingEmail(null);
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
        description: "The new signer has been added. Use the Send button to send them the contract.",
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

  const handleSend = (signer) => {
    setSendingEmail(signer.email);
    sendMutation.mutate(signer);
  };

  const handleAddSigner = (newSigner) => {
    addSignerMutation.mutate(newSigner);
  };

  const handleDownload = async (submissionId) => {
    setDownloadingSubmissionId(submissionId);
    try {
      const response = await fetch(`/api/contracts/download-pdf?submissionId=${submissionId}`);
      const data = await response.json();
      
      if (!response.ok) {
        throw new Error(data.error || 'Failed to get download URL');
      }
      
      setPdfPreview({
        isOpen: true,
        url: data.downloadUrl,
        fileName: data.fileName || 'signed-contract.pdf'
      });
    } catch (error) {
      toast({
        title: "Download Failed",
        description: error.message || "Failed to download PDF.",
        variant: "destructive",
      });
    } finally {
      setDownloadingSubmissionId(null);
    }
  };

  const handlePdfDownload = () => {
    if (pdfPreview.url) {
      const link = document.createElement('a');
      link.href = pdfPreview.url;
      link.download = pdfPreview.fileName;
      link.target = '_blank';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      
      toast({
        title: "Download Started",
        description: "Your signed contract PDF is downloading.",
      });
    }
  };

  const closePdfPreview = () => {
    setPdfPreview({ isOpen: false, url: null, fileName: null });
  };

  if (!signatory) return null;

  const statusConfig = STATUS_CONFIG[signatory.status] || STATUS_CONFIG.pending;
  const StatusIcon = statusConfig.icon;

  return (
    <>
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col" data-testid="signatory-detail-modal">
        <DialogHeader className="flex-shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <div className="p-2 bg-muted rounded-md">
              <FileSignature className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <DialogTitle className="text-lg truncate">{signatory.fieldLabel || 'Signatory'}</DialogTitle>
              <p className="text-sm text-muted-foreground truncate">{signatory.contractName}</p>
            </div>
          </div>
        </DialogHeader>

        <ScrollArea className="flex-1 mt-4">
          <div className="space-y-4 pr-4">
            <div>
              <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
                <User className="w-4 h-4" />
                Signers
              </h3>
              <p className="text-xs text-muted-foreground mb-3">
                The first person to sign this document wins. All others will be locked out.
              </p>
              
              {fieldSignerHistory.length > 0 ? (
                <div className="space-y-2">
                  {fieldSignerHistory.map((signer, index) => (
                    <SignerRow 
                      key={`${signer.contractId || 'no-contract'}-${signer.email}-${index}`}
                      signer={signer}
                      onSend={handleSend}
                      onDownload={handleDownload}
                      isSending={sendingEmail === signer.email}
                      isDownloading={downloadingSubmissionId === signer.submission_id}
                      isFieldSigned={isFieldSigned}
                      isLegacyAmbiguous={isLegacyAmbiguous}
                    />
                  ))}
                </div>
              ) : (
                <div className="text-center py-6 text-muted-foreground border rounded-lg">
                  <User className="w-10 h-10 mx-auto mb-2 opacity-50" />
                  <p className="text-sm">No signers have been added yet</p>
                </div>
              )}
            </div>

            <Separator />

            <AddAlternativeSignerForm 
              onSubmit={handleAddSigner}
              isSubmitting={addSignerMutation.isPending}
              isDisabled={isFieldSigned}
              isLegacyAmbiguous={isLegacyAmbiguous}
            />
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>

    <Dialog open={pdfPreview.isOpen} onOpenChange={closePdfPreview}>
      <DialogContent className="max-w-4xl h-[85vh] flex flex-col p-0" data-testid="pdf-preview-modal">
        <div className="flex items-center justify-between px-4 py-3 border-b flex-shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <FileSignature className="w-5 h-5 flex-shrink-0" />
            <span className="font-medium truncate">{pdfPreview.fileName}</span>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <Button
              variant="outline"
              size="sm"
              onClick={handlePdfDownload}
              className="gap-2"
              data-testid="button-download-pdf"
            >
              <Download className="w-4 h-4" />
              Download
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => pdfPreview.url && window.open(pdfPreview.url, '_blank')}
              className="gap-2"
              data-testid="button-open-new-tab"
            >
              <ExternalLink className="w-4 h-4" />
              Open in New Tab
            </Button>
          </div>
        </div>
        <div className="flex-1 bg-muted">
          {pdfPreview.url && (
            <iframe
              src={pdfPreview.url}
              className="w-full h-full border-0"
              title="PDF Preview"
              data-testid="pdf-preview-iframe"
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
    </>
  );
}
