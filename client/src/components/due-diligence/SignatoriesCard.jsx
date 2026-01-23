import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { User, Clock, Check, FileSignature, Loader2 } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import SignatoryDetailModal from "./SignatoryDetailModal";

const STATUS_CONFIG = {
  not_sent: { label: 'Not Sent', color: '#6b7280', icon: Clock },
  pending: { label: 'Pending', color: '#f59e0b', icon: Clock },
  out_for_signing: { label: 'Pending', color: '#f59e0b', icon: Clock },
  received: { label: 'Received', color: '#22c55e', icon: Check },
  expired: { label: 'Expired', color: '#ef4444', icon: Clock }
};

function SignatoryItem({ signer, contractName, status, onClick }) {
  const statusConfig = STATUS_CONFIG[status] || STATUS_CONFIG.pending;
  const StatusIcon = statusConfig.icon;
  const fullName = [signer.first_name, signer.last_name].filter(Boolean).join(' ') || 'Unknown';
  
  return (
    <div 
      className="flex items-center gap-3 p-3 rounded-lg border hover-elevate cursor-pointer"
      data-testid={`signatory-item-${signer.email}`}
      onClick={onClick}
    >
      <div className="p-2 bg-muted rounded-md">
        <User className="w-5 h-5 text-muted-foreground" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate">{fullName}</p>
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
          <span className="text-xs text-muted-foreground flex items-center gap-1">
            <FileSignature className="w-3 h-3" />
            {contractName}
          </span>
        </div>
      </div>
    </div>
  );
}

export default function SignatoriesCard({ formSubmissionId, submissionData, formSchema }) {
  const [selectedFieldId, setSelectedFieldId] = useState(null);
  const [isModalOpen, setIsModalOpen] = useState(false);

  const handleSignatoryClick = (signatory) => {
    setSelectedFieldId(signatory.fieldId);
    setIsModalOpen(true);
  };

  const handleCloseModal = () => {
    setIsModalOpen(false);
    setSelectedFieldId(null);
  };

  const { data: contractsData, isLoading: contractsLoading } = useQuery({
    queryKey: ['/api/contracts/by-submission', formSubmissionId],
    queryFn: () => apiRequest('GET', `/api/contracts/by-submission?formSubmissionId=${formSubmissionId}`),
    enabled: !!formSubmissionId
  });

  const contractFormIds = useMemo(() => {
    if (!formSchema) return [];
    const schema = formSchema.schema || formSchema;
    const ids = new Set();
    
    const processFields = (fields) => {
      if (!fields) return;
      fields.forEach(field => {
        if (field.type === 'contact' && field.contract_form_id) {
          ids.add(field.contract_form_id);
        }
      });
    };
    
    if (schema.pages?.length > 0) {
      schema.pages.forEach(page => processFields(page.fields));
    }
    if (schema.fields) {
      processFields(schema.fields);
    }
    
    return [...ids];
  }, [formSchema]);

  const { data: contractTemplates, isLoading: templatesLoading } = useQuery({
    queryKey: ['/api/entities/form', 'contract-templates', contractFormIds],
    queryFn: async () => {
      if (contractFormIds.length === 0) return [];
      const results = await Promise.all(
        contractFormIds.map(id => 
          apiRequest('GET', `/api/entities/form/${id}`).catch(() => null)
        )
      );
      return results.filter(Boolean);
    },
    enabled: contractFormIds.length > 0
  });

  const templateNamesMap = useMemo(() => {
    const map = {};
    (contractTemplates || []).forEach(t => {
      if (t?.id) map[t.id] = t.name || 'Unnamed Contract';
    });
    return map;
  }, [contractTemplates]);

  const contactFieldsWithContracts = useMemo(() => {
    if (!formSchema || !submissionData) return [];
    
    const schema = formSchema.schema || formSchema;
    if (!schema.fields && !schema.pages) return [];
    
    const contacts = [];
    
    const processFields = (fields) => {
      if (!fields) return;
      
      fields.forEach(field => {
        if (field.type === 'contact' && field.contract_form_id) {
          const fieldKey = field.name || field.id;
          const fieldValue = submissionData[fieldKey] || submissionData[field.id];
          
          if (fieldValue) {
            let contactData = fieldValue;
            if (typeof fieldValue === 'string') {
              try {
                contactData = JSON.parse(fieldValue);
              } catch {
                contactData = {};
              }
            }
            
            contacts.push({
              fieldId: field.id,
              fieldKey,
              fieldLabel: field.label || fieldKey,
              contractFormId: field.contract_form_id,
              firstName: contactData.first_name || contactData.firstName || '',
              lastName: contactData.last_name || contactData.lastName || '',
              email: contactData.email || '',
              jobTitle: contactData.job_title || contactData.jobTitle || '',
              organisation: contactData.organisation || contactData.organization || ''
            });
          }
        }
      });
    };
    
    if (schema.pages && schema.pages.length > 0) {
      schema.pages.forEach(page => {
        if (page.fields) processFields(page.fields);
      });
    }
    
    if (schema.fields) {
      processFields(schema.fields);
    }
    
    return contacts;
  }, [formSchema, submissionData]);

  const signatories = useMemo(() => {
    const contracts = contractsData?.contracts || [];
    
    const result = [];
    
    contactFieldsWithContracts.forEach(contact => {
      let contractsForField = contracts.filter(c => 
        c.sourceContactFieldId === contact.fieldId
      );
      
      let isLegacyAmbiguous = false;
      if (contractsForField.length === 0) {
        const legacyCandidates = contracts.filter(c => 
          c.formId === contact.contractFormId && !c.sourceContactFieldId
        );
        if (legacyCandidates.length === 1) {
          contractsForField = legacyCandidates;
        } else if (legacyCandidates.length > 1) {
          isLegacyAmbiguous = true;
        }
      }
      
      const matchingContract = contractsForField[0];
      const templateName = templateNamesMap[contact.contractFormId] || 'Unknown Contract';
      
      const fieldSignerHistory = [];
      const seenKeys = new Set();
      const originalContactEmail = (contact.email || '').toLowerCase();
      let originalFoundInContracts = false;
      
      contractsForField.forEach(contract => {
        // Process signedSigners FIRST so their submission_id is preserved (not overwritten by duplicate from signers array)
        const allSigners = [...(contract.signedSigners || []), ...(contract.signers || [])];
        allSigners.forEach(signer => {
          const email = (signer.email || '').toLowerCase();
          const uniqueKey = `${contract.id}-${email}`;
          
          if (seenKeys.has(uniqueKey)) return;
          seenKeys.add(uniqueKey);
          
          const isOriginal = email === originalContactEmail;
          if (isOriginal) {
            originalFoundInContracts = true;
          }
          
          const isSigned = signer.signed || contract.signedSigners?.some(
            s => (s.email || '').toLowerCase() === email
          );
          
          let status = 'not_sent';
          if (isSigned) {
            status = 'received';
          } else if (contract.status === 'expired') {
            status = 'expired';
          } else if (signer.sent_at || signer.last_resent_at) {
            status = 'pending';
          }
          
          fieldSignerHistory.push({
            firstName: isOriginal ? contact.firstName : (signer.first_name || signer.name?.split(' ')[0] || ''),
            lastName: isOriginal ? contact.lastName : (signer.last_name || signer.name?.split(' ').slice(1).join(' ') || ''),
            email: signer.email,
            jobTitle: isOriginal ? contact.jobTitle : (signer.job_title || ''),
            organisation: isOriginal ? contact.organisation : (signer.organisation || signer.organization || ''),
            status,
            contractId: contract.id,
            signedAt: signer.signed_at,
            sentAt: signer.added_at || contract.sentAt || contract.sent_at,
            createdAt: contract.createdAt || contract.created_at,
            addedAt: signer.added_at,
            isOriginal,
            submission_id: signer.submission_id
          });
        });
      });
      
      if (originalContactEmail && !originalFoundInContracts) {
        fieldSignerHistory.unshift({
          firstName: contact.firstName,
          lastName: contact.lastName,
          email: contact.email,
          jobTitle: contact.jobTitle || '',
          organisation: contact.organisation || '',
          status: 'not_sent',
          contractId: matchingContract?.id || null,
          signedAt: null,
          sentAt: null,
          isOriginal: true
        });
      }
      
      fieldSignerHistory.sort((a, b) => {
        const dateA = new Date(a.addedAt || a.sentAt || a.createdAt || 0);
        const dateB = new Date(b.addedAt || b.sentAt || b.createdAt || 0);
        return dateA - dateB;
      });
      
      const hasSignedSigner = fieldSignerHistory.some(s => s.status === 'received');
      
      let currentStatus = 'not_sent';
      if (matchingContract) {
        const matchingSigner = matchingContract.signers?.find(
          s => (s.email || '').toLowerCase() === (contact.email || '').toLowerCase()
        );
        
        const isSigned = matchingSigner?.signed || 
          matchingContract.signedSigners?.some(
            s => (s.email || '').toLowerCase() === (contact.email || '').toLowerCase()
          );
        
        if (isSigned || hasSignedSigner) {
          currentStatus = 'received';
        } else if (matchingContract.status === 'expired') {
          currentStatus = 'expired';
        } else if (matchingContract.sentAt) {
          currentStatus = 'pending';
        }
      } else if (hasSignedSigner) {
        currentStatus = 'received';
      }
      
      result.push({
        ...contact,
        contractName: matchingContract?.name || templateName,
        status: currentStatus,
        contractId: matchingContract?.id || null,
        signedAt: matchingContract?.signedSigners?.[0]?.signed_at,
        sentAt: matchingContract?.sentAt || matchingContract?.sent_at,
        createdAt: matchingContract?.createdAt || matchingContract?.created_at,
        fieldSignerHistory,
        isFieldSigned: hasSignedSigner,
        isLegacyAmbiguous
      });
    });
    
    return result;
  }, [contactFieldsWithContracts, contractsData, templateNamesMap]);

  const hasSignatories = signatories.length > 0;

  if (!hasSignatories) {
    return null;
  }

  const isLoading = contractsLoading || templatesLoading;

  if (isLoading) {
    return (
      <Card className="shadow-lg">
        <CardHeader>
          <CardTitle className="text-lg">Signatories</CardTitle>
        </CardHeader>
        <CardContent className="flex items-center justify-center py-8">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <Card className="shadow-lg" data-testid="signatories-card">
        <CardHeader>
          <CardTitle className="text-lg">Signatories</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {signatories.length > 0 ? (
            signatories.map((signatory, index) => (
              <SignatoryItem 
                key={`${signatory.fieldId}-${index}`}
                signer={{
                  first_name: signatory.firstName,
                  last_name: signatory.lastName,
                  email: signatory.email
                }}
                contractName={signatory.contractName}
                status={signatory.status}
                onClick={() => handleSignatoryClick(signatory)}
              />
            ))
          ) : (
            <p className="text-sm text-muted-foreground text-center py-4">
              No signatories found for this submission
            </p>
          )}
        </CardContent>
      </Card>

      {(() => {
        const currentSignatory = signatories.find(s => s.fieldId === selectedFieldId);
        return (
          <SignatoryDetailModal
            isOpen={isModalOpen}
            onClose={handleCloseModal}
            signatory={currentSignatory}
            fieldSignerHistory={currentSignatory?.fieldSignerHistory || []}
            isFieldSigned={currentSignatory?.isFieldSigned || false}
            isLegacyAmbiguous={currentSignatory?.isLegacyAmbiguous || false}
            formSubmissionId={formSubmissionId}
          />
        );
      })()}
    </>
  );
}
