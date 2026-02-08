import { useState, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { toast } from "sonner";
import { 
  Upload, 
  Link as LinkIcon, 
  X, 
  Image as ImageIcon,
  Loader2,
  RefreshCw
} from "lucide-react";
import { base44 } from "@/api/base44Client";

export default function EventImageUpload({ 
  value, 
  onChange, 
  disabled = false,
  className = "",
  label = "Event Image",
  helpText = "Optional: Add an image to display on the event card"
}) {
  const [isUploading, setIsUploading] = useState(false);
  const [activeTab, setActiveTab] = useState(value ? "preview" : "upload");
  const [urlInput, setUrlInput] = useState("");
  const fileInputRef = useRef(null);

  useEffect(() => {
    if (value && activeTab !== "preview") {
      setActiveTab("preview");
    }
  }, [value]);

  const handleFileSelect = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      toast.error('Please select an image file');
      return;
    }

    if (file.size > 5 * 1024 * 1024) {
      toast.error('Image must be less than 5MB');
      return;
    }

    setIsUploading(true);
    try {
      const result = await base44.integrations.Core.UploadFile({ file });
      onChange(result.file_url);
      setActiveTab("preview");
      toast.success('Image uploaded successfully');
    } catch (error) {
      console.error('Upload error:', error);
      toast.error('Failed to upload image');
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const handleUrlSubmit = () => {
    if (!urlInput.trim()) {
      toast.error('Please enter an image URL');
      return;
    }

    try {
      new URL(urlInput);
      onChange(urlInput.trim());
      setActiveTab("preview");
      setUrlInput("");
      toast.success('Image URL set successfully');
    } catch {
      toast.error('Please enter a valid URL');
    }
  };

  const handleRemove = () => {
    onChange("");
    setActiveTab("upload");
    setUrlInput("");
  };

  const handleReplace = () => {
    setActiveTab("upload");
  };

  if (disabled) {
    return (
      <div className={`space-y-2 ${className}`}>
        <Label>{label}</Label>
        {value ? (
          <div className="relative rounded-lg overflow-hidden border border-slate-200 bg-slate-100">
            <img 
              src={value} 
              alt="Event" 
              className="w-full h-48 object-cover opacity-75"
            />
            <div className="absolute inset-0 flex items-center justify-center bg-slate-900/20">
              <span className="text-sm text-white bg-slate-800/70 px-3 py-1 rounded">
                Image managed by Zoom
              </span>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-center h-32 bg-slate-100 rounded-lg border border-slate-200">
            <span className="text-sm text-slate-500">No image set</span>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={`space-y-2 ${className}`}>
      <Label>{label}</Label>
      
      {value && activeTab === "preview" ? (
        <div className="space-y-3">
          <div className="relative rounded-lg overflow-hidden border border-slate-200">
            <img 
              src={value} 
              alt="Event preview" 
              className="w-full h-48 object-cover"
              onError={(e) => {
                e.target.onerror = null;
                e.target.src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect fill="%23f1f5f9" width="100" height="100"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" fill="%2394a3b8" font-size="12">Image failed to load</text></svg>';
              }}
            />
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleReplace}
              data-testid="button-replace-image"
            >
              <RefreshCw className="h-4 w-4 mr-2" />
              Replace
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleRemove}
              className="text-red-600 hover:text-red-700 hover:bg-red-50"
              data-testid="button-remove-image"
            >
              <X className="h-4 w-4 mr-2" />
              Remove
            </Button>
          </div>
        </div>
      ) : (
        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="upload" className="flex items-center gap-2">
              <Upload className="h-4 w-4" />
              Upload
            </TabsTrigger>
            <TabsTrigger value="url" className="flex items-center gap-2">
              <LinkIcon className="h-4 w-4" />
              URL
            </TabsTrigger>
          </TabsList>
          
          <TabsContent value="upload" className="mt-3">
            <div 
              className="border-2 border-dashed border-slate-300 rounded-lg p-6 text-center hover:border-blue-400 hover:bg-blue-50/50 transition-colors cursor-pointer"
              onClick={() => fileInputRef.current?.click()}
              data-testid="dropzone-upload"
            >
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                onChange={handleFileSelect}
                className="hidden"
                data-testid="input-file-upload"
              />
              {isUploading ? (
                <div className="flex flex-col items-center gap-2">
                  <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
                  <span className="text-sm text-slate-600">Uploading...</span>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-2">
                  <div className="p-3 bg-slate-100 rounded-full">
                    <ImageIcon className="h-6 w-6 text-slate-500" />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-slate-700">
                      Click to upload an image
                    </p>
                    <p className="text-xs text-slate-500 mt-1">
                      PNG, JPG, GIF up to 5MB
                    </p>
                  </div>
                </div>
              )}
            </div>
          </TabsContent>
          
          <TabsContent value="url" className="mt-3">
            <div className="space-y-3">
              <Input
                type="url"
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
                placeholder="https://example.com/image.jpg"
                data-testid="input-image-url"
              />
              <Button
                type="button"
                onClick={handleUrlSubmit}
                className="w-full"
                disabled={!urlInput.trim()}
                data-testid="button-set-url"
              >
                <LinkIcon className="h-4 w-4 mr-2" />
                Set Image URL
              </Button>
            </div>
          </TabsContent>
        </Tabs>
      )}
      
      <p className="text-xs text-slate-500">
        {helpText}
      </p>
    </div>
  );
}
