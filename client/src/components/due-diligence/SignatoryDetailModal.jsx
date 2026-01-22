import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { 
  User, Check, Clock, FileSignature, Mail, Briefcase, Building2, History, AlertCircle
} from "lucide-react";
import { format } from 'date-fns';

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

function TimelineEvent({ event, isLast }) {
  return (
    <div className="flex gap-3">
      <div className="flex flex-col items-center">
        <div 
          className="w-3 h-3 rounded-full border-2"
          style={{ 
            borderColor: event.color || '#6b7280',
            backgroundColor: event.filled ? (event.color || '#6b7280') : 'transparent'
          }}
        />
        {!isLast && <div className="w-0.5 flex-1 bg-border mt-1" />}
      </div>
      <div className="pb-4">
        <p className="text-sm font-medium">{event.title}</p>
        <p className="text-xs text-muted-foreground">{event.description}</p>
        {event.date && (
          <p className="text-xs text-muted-foreground mt-1">
            {format(new Date(event.date), 'MMM d, yyyy h:mm a')}
          </p>
        )}
      </div>
    </div>
  );
}

export default function SignatoryDetailModal({ 
  isOpen, 
  onClose, 
  signatory 
}) {
  const [activeTab, setActiveTab] = useState('preview');

  if (!signatory) return null;

  const statusConfig = STATUS_CONFIG[signatory.status] || STATUS_CONFIG.pending;
  const StatusIcon = statusConfig.icon;
  const fullName = [signatory.firstName, signatory.lastName].filter(Boolean).join(' ') || 'Unknown';

  const timeline = [];
  
  timeline.push({
    title: 'Contract Created',
    description: `${signatory.contractName} assigned to ${fullName}`,
    date: signatory.createdAt || null,
    color: '#6b7280',
    filled: true
  });

  if (signatory.status === 'not_sent') {
    timeline.push({
      title: 'Awaiting Send',
      description: 'Contract has not been sent for signing yet',
      color: '#6b7280',
      filled: false
    });
  } else if (signatory.sentAt) {
    timeline.push({
      title: 'Sent for Signing',
      description: `Contract sent to ${signatory.email}`,
      date: signatory.sentAt,
      color: '#f59e0b',
      filled: true
    });
  }

  if (signatory.status === 'received' && signatory.signedAt) {
    timeline.push({
      title: 'Contract Signed',
      description: `Signed by ${fullName}`,
      date: signatory.signedAt,
      color: '#22c55e',
      filled: true
    });
  } else if (signatory.status === 'expired') {
    timeline.push({
      title: 'Contract Expired',
      description: 'The signing deadline has passed',
      color: '#ef4444',
      filled: true
    });
  } else if (signatory.status === 'pending') {
    timeline.push({
      title: 'Awaiting Signature',
      description: `Waiting for ${fullName} to sign`,
      color: '#f59e0b',
      filled: false
    });
  }

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
            <TabsTrigger value="preview" className="flex items-center gap-2" data-testid="tab-preview">
              <FileSignature className="w-4 h-4" />
              Preview
            </TabsTrigger>
            <TabsTrigger value="versions" className="flex items-center gap-2" data-testid="tab-versions">
              <History className="w-4 h-4" />
              Versions
            </TabsTrigger>
          </TabsList>

          <TabsContent value="preview" className="flex-1 overflow-hidden mt-4">
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
              </div>
            </ScrollArea>
          </TabsContent>

          <TabsContent value="versions" className="flex-1 overflow-hidden mt-4">
            <ScrollArea className="h-full">
              <div className="pr-4">
                <h3 className="text-sm font-semibold mb-4 flex items-center gap-2">
                  <History className="w-4 h-4" />
                  Contract History
                </h3>
                
                {timeline.length > 0 ? (
                  <div className="space-y-0">
                    {timeline.map((event, index) => (
                      <TimelineEvent 
                        key={index} 
                        event={event} 
                        isLast={index === timeline.length - 1} 
                      />
                    ))}
                  </div>
                ) : (
                  <div className="text-center py-8 text-muted-foreground">
                    <History className="w-12 h-12 mx-auto mb-3 opacity-50" />
                    <p>No timeline events</p>
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
