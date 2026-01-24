import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, CheckCircle2, AlertCircle, UserPlus } from "lucide-react";
import { publicClient } from "@/api/publicClient";
import { Toaster, toast } from "sonner";

export default function EmbedAlternativeSignerPage() {
  const [searchParams] = useSearchParams();
  const contractId = searchParams.get('contract');
  const token = searchParams.get('token');
  const tenantParam = searchParams.get('tenant');
  const roundParam = searchParams.get('round');
  
  const [formData, setFormData] = useState({
    first_name: '',
    last_name: '',
    email: ''
  });
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState(null);

  const { data: contractInfo, isLoading: loadingContract, error: contractError } = useQuery({
    queryKey: ['alternative-signer-contract', contractId, token, tenantParam, roundParam],
    queryFn: async () => {
      const response = await fetch(`/api/public/alternative-signer/validate?contract=${contractId}&token=${token}&tenant=${tenantParam}&round=${roundParam || ''}`);
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || 'Invalid or expired link');
      }
      return response.json();
    },
    enabled: !!(contractId && token),
    retry: false
  });

  const submitMutation = useMutation({
    mutationFn: async (data) => {
      const response = await fetch('/api/public/alternative-signer/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contract_id: contractId,
          token,
          tenant: tenantParam,
          round: roundParam ? parseInt(roundParam, 10) : undefined,
          ...data
        })
      });
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || 'Failed to submit');
      }
      return response.json();
    },
    onSuccess: () => {
      setSubmitted(true);
    },
    onError: (err) => {
      setError(err.message);
      toast.error(err.message);
    }
  });

  const handleSubmit = (e) => {
    e.preventDefault();
    setError(null);
    
    if (!formData.first_name.trim()) {
      setError('First name is required');
      return;
    }
    if (!formData.last_name.trim()) {
      setError('Last name is required');
      return;
    }
    if (!formData.email.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.email)) {
      setError('Valid email is required');
      return;
    }
    
    submitMutation.mutate(formData);
  };

  if (!contractId || !token) {
    return (
      <div className="min-h-screen bg-slate-50 dark:bg-slate-900 flex items-center justify-center p-4">
        <Toaster position="top-center" richColors />
        <Card className="max-w-md w-full">
          <CardContent className="pt-6">
            <div className="text-center">
              <AlertCircle className="w-12 h-12 text-red-500 mx-auto mb-4" />
              <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100 mb-2">
                Invalid Link
              </h2>
              <p className="text-slate-600 dark:text-slate-400">
                This link is missing required parameters. Please use the link from your email.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (loadingContract) {
    return (
      <div className="min-h-screen bg-slate-50 dark:bg-slate-900 flex items-center justify-center p-4">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  if (contractError) {
    return (
      <div className="min-h-screen bg-slate-50 dark:bg-slate-900 flex items-center justify-center p-4">
        <Toaster position="top-center" richColors />
        <Card className="max-w-md w-full">
          <CardContent className="pt-6">
            <div className="text-center">
              <AlertCircle className="w-12 h-12 text-red-500 mx-auto mb-4" />
              <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100 mb-2">
                Link Expired or Invalid
              </h2>
              <p className="text-slate-600 dark:text-slate-400">
                {contractError.message || 'This link is no longer valid. Please contact the organization for assistance.'}
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (submitted) {
    return (
      <div className="min-h-screen bg-slate-50 dark:bg-slate-900 flex items-center justify-center p-4">
        <Toaster position="top-center" richColors />
        <Card className="max-w-md w-full">
          <CardContent className="pt-6">
            <div className="text-center">
              <CheckCircle2 className="w-12 h-12 text-green-500 mx-auto mb-4" />
              <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100 mb-2">
                Alternative Signer Added
              </h2>
              <p className="text-slate-600 dark:text-slate-400">
                The new signer has been added and the contract has been sent to them for signing.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-900 flex items-center justify-center p-4">
      <Toaster position="top-center" richColors />
      <Card className="max-w-md w-full">
        <CardHeader className="text-center">
          <div className="mx-auto mb-2">
            <UserPlus className="w-10 h-10 text-blue-600" />
          </div>
          <CardTitle>{contractInfo?.alternative_signer_title || "Provide Alternative Signer"}</CardTitle>
          {contractInfo?.alternative_signer_message && (
            <p className="text-sm text-slate-700 dark:text-slate-300 mt-2">
              {contractInfo.alternative_signer_message}
            </p>
          )}
          <CardDescription className="mt-2">
            {contractInfo?.contract_name 
              ? `The contract "${contractInfo.contract_name}" was not signed in time. Please provide an alternative signer below.`
              : 'Please provide the details of an alternative signer for this contract.'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="first_name">First Name *</Label>
                <Input
                  id="first_name"
                  value={formData.first_name}
                  onChange={(e) => setFormData(prev => ({ ...prev, first_name: e.target.value }))}
                  placeholder="John"
                  data-testid="input-signer-first-name"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="last_name">Last Name *</Label>
                <Input
                  id="last_name"
                  value={formData.last_name}
                  onChange={(e) => setFormData(prev => ({ ...prev, last_name: e.target.value }))}
                  placeholder="Smith"
                  data-testid="input-signer-last-name"
                />
              </div>
            </div>
            
            <div className="space-y-2">
              <Label htmlFor="email">Email Address *</Label>
              <Input
                id="email"
                type="email"
                value={formData.email}
                onChange={(e) => setFormData(prev => ({ ...prev, email: e.target.value }))}
                placeholder="john.smith@example.com"
                data-testid="input-signer-email"
              />
            </div>

            {error && (
              <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-md p-3">
                <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
              </div>
            )}

            <Button 
              type="submit" 
              className="w-full" 
              disabled={submitMutation.isPending}
              data-testid="button-submit-alternative-signer"
            >
              {submitMutation.isPending ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Submitting...
                </>
              ) : (
                <>
                  <UserPlus className="w-4 h-4 mr-2" />
                  {contractInfo?.alternative_signer_button_label || "Add Signer & Send Contract"}
                </>
              )}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
