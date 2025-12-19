import React, { useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { AtSign, AlertCircle, CheckCircle2, Loader2, PlayCircle, Users } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { createPageUrl } from "@/utils";

export default function MemberHandleManagementPage() {
  const { isFeatureExcluded, memberInfo, isAccessReady } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);
  const [generationResult, setGenerationResult] = useState(null);

  const { data: membersWithoutHandles = [], isLoading, refetch } = useQuery({
    queryKey: ['members-without-handles'],
    queryFn: async () => {
      const members = await base44.entities.Member.listAll();
      return members.filter(m => !m.handle);
    },
    enabled: accessChecked
  });

  const generateHandlesMutation = useMutation({
    mutationFn: async () => {
      return await base44.functions.invoke('generateMemberHandles', { 
        generate_all: true,
        member_email: memberInfo?.email 
      });
    },
    onSuccess: (response) => {
      setGenerationResult(response.data);
      refetch();
      
      const { successful, failed } = response.data.summary;
      if (successful > 0) {
        toast.success(`Successfully generated ${successful} handle(s)`);
      }
      if (failed > 0) {
        toast.error(`Failed to generate ${failed} handle(s)`);
      }
    },
    onError: (error) => {
      console.error('Generation error:', error);
      toast.error('Failed to generate handles: ' + error.message);
    }
  });

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded('admin.member-handle-management')) {
        window.location.href = createPageUrl('Events');
      } else {
        setAccessChecked(true);
      }
    }
  }, [isFeatureExcluded, isAccessReady]);

  if (!accessChecked) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  const handleGenerateAll = () => {
    if (!memberInfo?.email) {
      toast.error('Member information not available');
      return;
    }
    
    if (window.confirm(`This will generate handles for ${membersWithoutHandles.length} member(s). Continue?`)) {
      generateHandlesMutation.mutate();
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
      <div className="max-w-6xl mx-auto">
        <div className="mb-8">
          <div className="flex items-center gap-3 mb-2">
            <AtSign className="w-8 h-8 text-blue-600" />
            <h1 className="text-3xl md:text-4xl font-bold text-slate-900">
              Member Handle Management
            </h1>
          </div>
          <p className="text-slate-600">
            Generate unique handles for members who don't have one yet
          </p>
        </div>

        {/* Summary Card */}
        <Card className="border-slate-200 shadow-sm mb-6">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Users className="w-5 h-5 text-blue-600" />
              Handle Generation Status
            </CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="flex items-center gap-2 text-slate-600">
                <Loader2 className="w-4 h-4 animate-spin" />
                Loading members...
              </div>
            ) : (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-2xl font-bold text-slate-900">
                      {membersWithoutHandles.length}
                    </p>
                    <p className="text-sm text-slate-600">
                      Member{membersWithoutHandles.length !== 1 ? 's' : ''} without handle
                    </p>
                  </div>
                  
                  <Button
                    onClick={handleGenerateAll}
                    disabled={membersWithoutHandles.length === 0 || generateHandlesMutation.isPending || !memberInfo?.email}
                    className="bg-blue-600 hover:bg-blue-700"
                  >
                    {generateHandlesMutation.isPending ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        Generating...
                      </>
                    ) : (
                      <>
                        <PlayCircle className="w-4 h-4 mr-2" />
                        Generate All Handles
                      </>
                    )}
                  </Button>
                </div>

                {membersWithoutHandles.length === 0 && (
                  <div className="flex items-center gap-2 p-4 bg-green-50 rounded-lg border border-green-200">
                    <CheckCircle2 className="w-5 h-5 text-green-600 flex-shrink-0" />
                    <p className="text-sm text-green-700">
                      All members have handles assigned!
                    </p>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Members Without Handles */}
        {membersWithoutHandles.length > 0 && (
          <Card className="border-slate-200 shadow-sm mb-6">
            <CardHeader>
              <CardTitle className="text-lg">Members Needing Handles</CardTitle>
              <CardDescription>
                The following members will have handles generated automatically
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-2 max-h-96 overflow-y-auto">
                {membersWithoutHandles.map((member) => (
                  <div
                    key={member.id}
                    className="flex items-center justify-between p-3 bg-slate-50 rounded-lg"
                  >
                    <div>
                      <p className="font-medium text-slate-900">
                        {member.first_name} {member.last_name}
                      </p>
                      <p className="text-sm text-slate-600">{member.email}</p>
                    </div>
                    <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200">
                      No Handle
                    </Badge>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Generation Results */}
        {generationResult && (
          <Card className="border-slate-200 shadow-sm">
            <CardHeader>
              <CardTitle className="text-lg">Generation Results</CardTitle>
              <CardDescription>
                Summary of the last handle generation run
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              {/* Summary */}
              <div className="grid md:grid-cols-3 gap-4">
                <div className="p-4 bg-green-50 rounded-lg border border-green-200">
                  <p className="text-2xl font-bold text-green-700">
                    {generationResult.summary.successful}
                  </p>
                  <p className="text-sm text-green-600">Successful</p>
                </div>
                <div className="p-4 bg-red-50 rounded-lg border border-red-200">
                  <p className="text-2xl font-bold text-red-700">
                    {generationResult.summary.failed}
                  </p>
                  <p className="text-sm text-red-600">Failed</p>
                </div>
                <div className="p-4 bg-slate-50 rounded-lg border border-slate-200">
                  <p className="text-2xl font-bold text-slate-700">
                    {generationResult.summary.skipped}
                  </p>
                  <p className="text-sm text-slate-600">Skipped</p>
                </div>
              </div>

              {/* Successful Generations */}
              {generationResult.results.success.length > 0 && (
                <div>
                  <h4 className="font-semibold text-slate-900 mb-3 flex items-center gap-2">
                    <CheckCircle2 className="w-5 h-5 text-green-600" />
                    Successfully Generated ({generationResult.results.success.length})
                  </h4>
                  <div className="space-y-2 max-h-64 overflow-y-auto">
                    {generationResult.results.success.map((result) => (
                      <div
                        key={result.member_id}
                        className="flex items-center justify-between p-3 bg-green-50 rounded-lg border border-green-200"
                      >
                        <div>
                          <p className="font-medium text-slate-900">{result.name}</p>
                          <p className="text-sm text-slate-600">{result.email}</p>
                        </div>
                        <Badge className="bg-green-100 text-green-700 border-green-300">
                          @{result.handle}
                        </Badge>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Failed Generations */}
              {generationResult.results.failed.length > 0 && (
                <div>
                  <h4 className="font-semibold text-slate-900 mb-3 flex items-center gap-2">
                    <AlertCircle className="w-5 h-5 text-red-600" />
                    Failed ({generationResult.results.failed.length})
                  </h4>
                  <div className="space-y-2 max-h-64 overflow-y-auto">
                    {generationResult.results.failed.map((result) => (
                      <div
                        key={result.member_id}
                        className="p-3 bg-red-50 rounded-lg border border-red-200"
                      >
                        <p className="font-medium text-slate-900">{result.email}</p>
                        <p className="text-sm text-red-600">{result.error}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Skipped */}
              {generationResult.results.skipped.length > 0 && (
                <div>
                  <h4 className="font-semibold text-slate-900 mb-3 flex items-center gap-2">
                    Skipped ({generationResult.results.skipped.length})
                  </h4>
                  <div className="space-y-2 max-h-64 overflow-y-auto">
                    {generationResult.results.skipped.map((result) => (
                      <div
                        key={result.member_id}
                        className="flex items-center justify-between p-3 bg-slate-50 rounded-lg border border-slate-200"
                      >
                        <div>
                          <p className="font-medium text-slate-900">{result.email}</p>
                          <p className="text-sm text-slate-600">{result.reason}</p>
                        </div>
                        <Badge variant="outline">@{result.existing_handle}</Badge>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* Info Box */}
        <Card className="border-blue-200 bg-blue-50 shadow-sm mt-6">
          <CardContent className="p-6">
            <div className="flex gap-4">
              <AlertCircle className="w-5 h-5 text-blue-600 flex-shrink-0 mt-0.5" />
              <div className="space-y-2 text-sm text-blue-900">
                <p className="font-semibold">How Handle Generation Works:</p>
                <ul className="list-disc list-inside space-y-1 text-blue-800">
                  <li>Handles are generated from first and last names (e.g., "john-doe")</li>
                  <li>If a handle already exists, a number is appended (e.g., "john-doe-1")</li>
                  <li>Handles must be 3-30 characters, lowercase, and URL-friendly</li>
                  <li>Once set, handles cannot be changed by the member</li>
                  <li>Members who already have handles will be skipped</li>
                </ul>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}