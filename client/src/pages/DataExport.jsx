import React, { useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Download, Database, CheckCircle, AlertCircle, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { createPageUrl } from "@/utils";

export default function DataExportPage() {
  const { isFeatureExcluded, memberInfo, isAccessReady } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [downloadUrl, setDownloadUrl] = useState(null);
  const [fileName, setFileName] = useState(null);
  const [expiresIn, setExpiresIn] = useState(null);

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded('admin.data-export')) {
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

  const handleExport = async () => {
    if (!memberInfo?.email) {
      toast.error('Member information not available');
      return;
    }
    
    setIsExporting(true);
    setDownloadUrl(null);
    setFileName(null);
    
    try {
      const result = await base44.functions.invoke('exportAllData', {
        memberEmail: memberInfo.email
      });
      
      console.log('Export result:', result);
      
      // Check for success in the response data
      if (result?.success || result?.data?.success) {
        const data = result?.data || result;
        setDownloadUrl(data.download_url);
        setFileName(data.file_name);
        setExpiresIn(data.expires_in);
        toast.success('Data export completed successfully!');
      } else {
        const errorMsg = result?.error || result?.data?.error || 'Unknown error';
        toast.error('Export failed: ' + errorMsg);
      }
    } catch (error) {
      console.error('Export error:', error);
      toast.error('Failed to export data: ' + error.message);
    } finally {
      setIsExporting(false);
    }
  };

  const handleDownload = () => {
    if (downloadUrl) {
      window.open(downloadUrl, '_blank');
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
      <div className="max-w-4xl mx-auto">
        <div className="mb-8">
          <h1 className="text-3xl md:text-4xl font-bold text-slate-900 mb-2">
            Data Export & Backup
          </h1>
          <p className="text-slate-600">
            Export all application data to CSV files in a downloadable ZIP archive
          </p>
        </div>

        <Card className="border-slate-200 shadow-sm mb-6">
          <CardHeader className="border-b border-slate-200">
            <CardTitle className="flex items-center gap-2">
              <Database className="w-5 h-5 text-blue-600" />
              Export All Data
            </CardTitle>
          </CardHeader>
          <CardContent className="p-6 space-y-6">
            <div className="p-4 bg-blue-50 rounded-lg border border-blue-200">
              <h3 className="text-sm font-semibold text-blue-900 mb-2">What will be exported:</h3>
              <ul className="text-sm text-blue-700 space-y-1 list-disc list-inside">
                <li>All member and organisation data</li>
                <li>Events, bookings, and program tickets</li>
                <li>Resources, articles, and news posts</li>
                <li>Roles, permissions, and settings</li>
                <li>Forms, submissions, and all other entities</li>
              </ul>
            </div>

            <div className="p-4 bg-amber-50 rounded-lg border border-amber-200">
              <div className="flex items-start gap-2">
                <AlertCircle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
                <div>
                  <h3 className="text-sm font-semibold text-amber-900 mb-1">Important Notes:</h3>
                  <ul className="text-sm text-amber-700 space-y-1">
                    <li>• Export may take several minutes depending on data volume</li>
                    <li>• Download link expires after 1 hour</li>
                    <li>• Sensitive data like tokens are included - store securely</li>
                    <li>• Each entity is exported as a separate CSV file</li>
                  </ul>
                </div>
              </div>
            </div>

            {!downloadUrl && !isExporting && (
              <Button
                onClick={handleExport}
                disabled={isExporting}
                className="w-full bg-blue-600 hover:bg-blue-700 h-12 text-base"
              >
                <Download className="w-5 h-5 mr-2" />
                Start Data Export
              </Button>
            )}

            {isExporting && (
              <div className="flex flex-col items-center justify-center py-8 space-y-4">
                <Loader2 className="w-12 h-12 text-blue-600 animate-spin" />
                <div className="text-center">
                  <p className="text-lg font-medium text-slate-900">Exporting data...</p>
                  <p className="text-sm text-slate-600 mt-1">
                    This may take a few minutes. Please don't close this page.
                  </p>
                </div>
              </div>
            )}

            {downloadUrl && (
              <div className="space-y-4">
                <div className="flex items-center gap-3 p-4 bg-green-50 rounded-lg border border-green-200">
                  <CheckCircle className="w-6 h-6 text-green-600 shrink-0" />
                  <div className="flex-1">
                    <h3 className="text-sm font-semibold text-green-900">Export Complete!</h3>
                    <p className="text-sm text-green-700 mt-1">
                      Your data has been exported and is ready for download.
                    </p>
                  </div>
                </div>

                <div className="p-4 bg-slate-50 rounded-lg space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-slate-700">File:</span>
                    <span className="text-sm text-slate-900">{fileName}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-slate-700">Link expires in:</span>
                    <span className="text-sm text-slate-900">
                      {Math.floor(expiresIn / 60)} minutes
                    </span>
                  </div>
                </div>

                <div className="flex gap-3">
                  <Button
                    onClick={handleDownload}
                    className="flex-1 bg-green-600 hover:bg-green-700 h-12 text-base"
                  >
                    <Download className="w-5 h-5 mr-2" />
                    Download ZIP File
                  </Button>
                  <Button
                    onClick={handleExport}
                    variant="outline"
                    className="h-12"
                  >
                    Export Again
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="border-slate-200 shadow-sm">
          <CardContent className="p-6">
            <h3 className="text-sm font-semibold text-slate-900 mb-3">Best Practices:</h3>
            <ul className="text-sm text-slate-600 space-y-2">
              <li>• Schedule regular backups (weekly or monthly)</li>
              <li>• Store backup files in a secure, encrypted location</li>
              <li>• Test restoring from backups periodically</li>
              <li>• Keep multiple backup versions for different time periods</li>
              <li>• Document your backup and restoration procedures</li>
            </ul>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}