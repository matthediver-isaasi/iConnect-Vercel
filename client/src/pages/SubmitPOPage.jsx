import { useState, useEffect } from "react";
import { useParams } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { Loader2, CheckCircle2, AlertCircle, FileText, ClipboardList, Building2 } from "lucide-react";

function formatCurrency(amount) {
  const n = Number(amount || 0);
  return `\u00a3${n.toFixed(2)}`;
}

function formatDate(d) {
  if (!d) return null;
  try {
    return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  } catch {
    return null;
  }
}

export default function SubmitPOPage() {
  const { token } = useParams();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);

  const [poNumber, setPoNumber] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [submitError, setSubmitError] = useState(null);

  useEffect(() => {
    if (!token) return;
    fetch(`/api/public/pending-po/${token}`)
      .then(async (res) => {
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || 'Failed to load invoice details');
        }
        return res.json();
      })
      .then((result) => {
        setData(result);
        if (result.status === 'submitted') {
          setSubmitted(true);
          setPoNumber(result.submittedPoNumber || '');
        } else if (result.invoice?.existingPoNumber) {
          setSubmitted(true);
          setPoNumber(result.invoice.existingPoNumber);
        }
      })
      .catch((err) => setLoadError(err.message))
      .finally(() => setLoading(false));
  }, [token]);

  const handleSubmit = async () => {
    if (!poNumber.trim()) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await fetch(`/api/public/pending-po/${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'submit_po', poNumber: poNumber.trim() }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to submit purchase order number');
      }
      setSubmitted(true);
    } catch (err) {
      setSubmitError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  const primaryColor = data?.tenant?.primaryColor || '#5C0085';

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <Loader2 className="w-8 h-8 animate-spin text-gray-400" />
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
        <Card className="max-w-md w-full">
          <CardContent className="pt-6 text-center">
            <AlertCircle className="w-12 h-12 mx-auto mb-4 text-red-500" />
            <h2 className="text-lg font-semibold mb-2">Unable to Load</h2>
            <p className="text-sm text-gray-500" data-testid="text-load-error">{loadError}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const invoice = data?.invoice || {};
  const invoiceDate = formatDate(invoice.invoiceDate);

  return (
    <div className="min-h-screen bg-gray-50 p-4">
      <div className="max-w-lg mx-auto space-y-4">
        {data?.tenant && (
          <div className="text-center py-4">
            {data.tenant.logoUrl && (
              <img src={data.tenant.logoUrl} alt={data.tenant.name} className="h-10 mx-auto mb-2" />
            )}
            <p className="text-sm text-gray-500">{data.tenant.name}</p>
          </div>
        )}

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 mb-4">
              <FileText className="w-5 h-5" style={{ color: primaryColor }} />
              <h1 className="text-lg font-semibold">Purchase Order Required</h1>
            </div>
            <p className="text-sm text-gray-500 mb-4">
              An invoice for your organisation is awaiting a purchase order number. Please confirm
              the details below and submit your PO number.
            </p>

            {invoice.organizationName && (
              <div className="flex items-center justify-between mb-1">
                <span className="text-sm text-gray-500 inline-flex items-center gap-1">
                  <Building2 className="w-3 h-3" />
                  Organisation
                </span>
                <span className="font-medium" data-testid="text-org-name">{invoice.organizationName}</span>
              </div>
            )}
            {invoice.invoiceNumber && (
              <div className="flex items-center justify-between mb-1">
                <span className="text-sm text-gray-500">Invoice Number</span>
                <span className="font-medium" data-testid="text-invoice-number">{invoice.invoiceNumber}</span>
              </div>
            )}
            {invoiceDate && (
              <div className="flex items-center justify-between mb-1">
                <span className="text-sm text-gray-500">Invoice Date</span>
                <span className="font-medium" data-testid="text-invoice-date">{invoiceDate}</span>
              </div>
            )}
            {invoice.sourceName && (
              <div className="flex items-center justify-between mb-1">
                <span className="text-sm text-gray-500">{invoice.sourceType || 'For'}</span>
                <span className="font-medium text-right" data-testid="text-source-name">{invoice.sourceName}</span>
              </div>
            )}
            {invoice.bookerNameDisplay && (
              <div className="flex items-center justify-between mb-1">
                <span className="text-sm text-gray-500">Booked by</span>
                <span className="font-medium text-right" data-testid="text-booker-name">{invoice.bookerNameDisplay}</span>
              </div>
            )}
            {invoice.quantity > 0 && (
              <div className="flex items-center justify-between mb-1">
                <span className="text-sm text-gray-500">Quantity</span>
                <Badge variant="secondary" data-testid="text-quantity">{invoice.quantity}</Badge>
              </div>
            )}

            <Separator className="my-3" />

            <div className="flex items-center justify-between">
              <span className="font-medium">Total</span>
              <span className="text-2xl font-bold" style={{ color: primaryColor }} data-testid="text-total">
                {formatCurrency(invoice.totalCost)}
              </span>
            </div>
          </CardContent>
        </Card>

        {submitted ? (
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-2 text-green-600">
                <CheckCircle2 className="w-5 h-5" />
                <span className="font-medium">Purchase Order Submitted</span>
              </div>
              <p className="text-sm text-gray-500 mt-1">
                PO Number:{' '}
                <span className="font-medium text-gray-700" data-testid="text-submitted-po">
                  {poNumber}
                </span>
              </p>
              <p className="text-sm text-gray-500 mt-2">
                Thank you. Your purchase order number has been recorded against this invoice.
              </p>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-2 mb-3">
                <ClipboardList className="w-4 h-4" style={{ color: primaryColor }} />
                <h2 className="font-medium">Submit Purchase Order Number</h2>
              </div>
              <div className="flex items-center gap-2">
                <Input
                  value={poNumber}
                  onChange={(e) => setPoNumber(e.target.value)}
                  placeholder="e.g. PO-12345"
                  data-testid="input-po-number"
                />
                <Button
                  onClick={handleSubmit}
                  disabled={submitting || !poNumber.trim()}
                  style={{ background: primaryColor }}
                  data-testid="button-submit-po"
                >
                  {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Submit'}
                </Button>
              </div>
              {submitError && (
                <div className="flex items-start gap-2 p-3 rounded-md bg-red-50 border border-red-200 mt-3">
                  <AlertCircle className="w-4 h-4 text-red-500 mt-0.5 shrink-0" />
                  <p className="text-sm text-red-700" data-testid="text-submit-error">{submitError}</p>
                </div>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
