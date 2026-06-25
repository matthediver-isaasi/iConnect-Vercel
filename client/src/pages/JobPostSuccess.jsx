import React from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CheckCircle } from "lucide-react";
import { createPageUrl } from "@/utils";

export default function JobPostSuccessPage() {
  return (
    <div className="min-h-screen p-4 md:p-8 flex items-center justify-center">
      <Card className="max-w-md w-full border-slate-200 shadow-xl">
        <CardContent className="p-8 text-center">
          <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <CheckCircle className="w-8 h-8 text-green-600" />
          </div>
          <h2 className="text-2xl font-bold text-slate-900 mb-2">Payment Successful!</h2>
          <p className="text-slate-600 mb-6">
            Thank you for your payment. Your job posting has been submitted and is pending approval. 
            You'll receive an email confirmation shortly, and another email once your posting is approved and live on the job board.
          </p>
          <Button 
            onClick={() => window.location.href = createPageUrl('JobBoard')}
            className="bg-blue-600 hover:bg-blue-700"
          >
            View Job Board
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}