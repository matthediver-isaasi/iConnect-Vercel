import React, { useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight, Plus, Trash2, Upload, Loader2, GripVertical, Copy } from "lucide-react";
import { toast } from "sonner";
import { DragDropContext, Droppable, Draggable } from "@hello-pangea/dnd";

export function IEditBannerCarouselElementEditor({ element, onChange }) {
  const content = element.content || { banners: [] };
  const [uploadingIndex, setUploadingIndex] = useState(null);

  const updateContent = (key, value) => {
    onChange({ ...element, content: { ...content, [key]: value } });
  };

  const addBanner = () => {
    const newBanner = {
      id: `banner-${Date.now()}`,
      headerText: '',
      paragraphText: '',
      ctaText: '',
      ctaLink: '',
      backgroundImage: ''
    };
    updateContent('banners', [...(content.banners || []), newBanner]);
  };

  const removeBanner = (index) => {
    const banners = [...(content.banners || [])];
    banners.splice(index, 1);
    updateContent('banners', banners);
  };

  const duplicateBanner = (index) => {
    const banners = [...(content.banners || [])];
    const bannerToDuplicate = { ...banners[index], id: `banner-${Date.now()}` };
    banners.splice(index + 1, 0, bannerToDuplicate);
    updateContent('banners', banners);
    toast.success('Banner duplicated');
  };

  const updateBanner = (index, field, value) => {
    const banners = [...(content.banners || [])];
    banners[index] = { ...banners[index], [field]: value };
    updateContent('banners', banners);
  };

  const handleImageUpload = async (index, file) => {
    if (!file) return;

    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml'];
    if (!allowedTypes.includes(file.type)) {
      toast.error('Please upload a valid image file');
      return;
    }

    if (file.size > 10 * 1024 * 1024) {
      toast.error('Image must be smaller than 10MB');
      return;
    }

    setUploadingIndex(index);

    try {
      const response = await base44.integrations.Core.UploadFile({ file });
      updateBanner(index, 'backgroundImage', response.file_url);
      toast.success('Image uploaded');
    } catch (error) {
      toast.error('Upload failed: ' + error.message);
    } finally {
      setUploadingIndex(null);
    }
  };

  const handleDragEnd = (result) => {
    if (!result.destination) return;

    const banners = Array.from(content.banners || []);
    const [removed] = banners.splice(result.source.index, 1);
    banners.splice(result.destination.index, 0, removed);

    updateContent('banners', banners);
  };

  return (
    <div className="space-y-4">
      {/* Anchor ID Field */}
      <div className="border rounded-lg p-3 bg-slate-50">
        <label className="block text-sm font-medium mb-1">Anchor ID</label>
        <input
          type="text"
          value={content.anchor || ''}
          onChange={(e) => {
            const sanitized = e.target.value
              .toLowerCase()
              .replace(/\s+/g, '-')
              .replace(/[^a-z0-9-_]/g, '');
            updateContent('anchor', sanitized);
          }}
          placeholder="e.g., carousel-section"
          className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm"
          data-testid="input-bannercarousel-anchor"
        />
        <p className="text-xs text-slate-500 mt-1">
          Used for linking directly to this section (e.g., /page#anchor-id)
        </p>
      </div>

      <div className="flex items-center justify-between">
        <Label>Banners ({(content.banners || []).length})</Label>
        <Button onClick={addBanner} size="sm" type="button">
          <Plus className="w-4 h-4 mr-1" />
          Add Banner
        </Button>
      </div>

      {(!content.banners || content.banners.length === 0) ? (
        <div className="border-2 border-dashed border-slate-300 rounded-lg p-8 text-center">
          <p className="text-slate-500 text-sm mb-3">No banners yet</p>
          <Button onClick={addBanner} size="sm" type="button">
            <Plus className="w-4 h-4 mr-1" />
            Add First Banner
          </Button>
        </div>
      ) : (
        <DragDropContext onDragEnd={handleDragEnd}>
          <Droppable droppableId="banners">
            {(provided) => (
              <div {...provided.droppableProps} ref={provided.innerRef} className="space-y-3">
                {content.banners.map((banner, index) => (
                  <Draggable key={banner.id} draggableId={banner.id} index={index}>
                    {(provided) => (
                      <div
                        ref={provided.innerRef}
                        {...provided.draggableProps}
                        className="border border-slate-200 rounded-lg p-4 bg-slate-50 space-y-3"
                      >
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center gap-2">
                            <div {...provided.dragHandleProps}>
                              <GripVertical className="w-4 h-4 text-slate-400 cursor-grab" />
                            </div>
                            <span className="font-medium text-sm text-slate-700">Banner {index + 1}</span>
                          </div>
                          <div className="flex gap-1">
                            <Button
                              onClick={() => duplicateBanner(index)}
                              size="sm"
                              variant="ghost"
                              className="text-blue-600 hover:text-blue-700 hover:bg-blue-50"
                              type="button"
                            >
                              <Copy className="w-4 h-4" />
                            </Button>
                            <Button
                              onClick={() => removeBanner(index)}
                              size="sm"
                              variant="ghost"
                              className="text-red-600 hover:text-red-700 hover:bg-red-50"
                              type="button"
                            >
                              <Trash2 className="w-4 h-4" />
                            </Button>
                          </div>
                        </div>

                        <div>
                          <Label htmlFor={`header-${index}`}>Header Text</Label>
                          <Input
                            id={`header-${index}`}
                            value={banner.headerText || ''}
                            onChange={(e) => updateBanner(index, 'headerText', e.target.value)}
                            placeholder="Main heading"
                          />
                        </div>

                        <div>
                          <Label htmlFor={`paragraph-${index}`}>Paragraph Text</Label>
                          <Textarea
                            id={`paragraph-${index}`}
                            value={banner.paragraphText || ''}
                            onChange={(e) => updateBanner(index, 'paragraphText', e.target.value)}
                            placeholder="Description text"
                            rows={3}
                          />
                        </div>

                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <Label htmlFor={`cta-text-${index}`}>CTA Button Text</Label>
                            <Input
                              id={`cta-text-${index}`}
                              value={banner.ctaText || ''}
                              onChange={(e) => updateBanner(index, 'ctaText', e.target.value)}
                              placeholder="Learn More"
                            />
                          </div>
                          <div>
                            <Label htmlFor={`cta-link-${index}`}>CTA Button Link</Label>
                            <Input
                              id={`cta-link-${index}`}
                              value={banner.ctaLink || ''}
                              onChange={(e) => updateBanner(index, 'ctaLink', e.target.value)}
                              placeholder="/page-url"
                            />
                          </div>
                        </div>

                        <div>
                          <Label htmlFor={`bg-image-${index}`}>Background Image</Label>
                          <div className="flex gap-2">
                            <Input
                              id={`bg-image-${index}`}
                              value={banner.backgroundImage || ''}
                              onChange={(e) => updateBanner(index, 'backgroundImage', e.target.value)}
                              placeholder="Image URL"
                              className="flex-1"
                            />
                            <Label htmlFor={`upload-${index}`} className="cursor-pointer">
                              <div className={`flex items-center gap-2 px-4 py-2 rounded-md transition-colors ${
                                uploadingIndex === index
                                  ? 'bg-slate-300 cursor-not-allowed'
                                  : 'bg-blue-600 hover:bg-blue-700 text-white'
                              }`}>
                                {uploadingIndex === index ? (
                                  <Loader2 className="w-4 h-4 animate-spin" />
                                ) : (
                                  <Upload className="w-4 h-4" />
                                )}
                              </div>
                              <input
                                id={`upload-${index}`}
                                type="file"
                                accept="image/*"
                                onChange={(e) => {
                                  const file = e.target.files?.[0];
                                  if (file) handleImageUpload(index, file);
                                  e.target.value = '';
                                }}
                                className="hidden"
                                disabled={uploadingIndex === index}
                              />
                            </Label>
                          </div>
                          {banner.backgroundImage && (
                            <img
                              src={banner.backgroundImage}
                              alt="Preview"
                              className="mt-2 w-full h-32 object-cover rounded"
                            />
                          )}
                        </div>
                      </div>
                    )}
                  </Draggable>
                ))}
                {provided.placeholder}
              </div>
            )}
          </Droppable>
        </DragDropContext>
      )}

      <div>
        <Label htmlFor="autoplay">Autoplay Interval (seconds)</Label>
        <Input
          id="autoplay"
          type="number"
          min="0"
          value={content.autoplayInterval || 5}
          onChange={(e) => updateContent('autoplayInterval', parseInt(e.target.value) || 5)}
          placeholder="5"
        />
        <p className="text-xs text-slate-500 mt-1">Set to 0 to disable autoplay</p>
      </div>
    </div>
  );
}

export function IEditBannerCarouselElementRenderer({ element }) {
  const content = element.content || { banners: [], autoplayInterval: 5 };
  const { anchor } = content;
  const [currentIndex, setCurrentIndex] = useState(0);

  const banners = content.banners || [];
  const autoplayInterval = content.autoplayInterval || 5;

  useEffect(() => {
    if (banners.length === 0 || autoplayInterval === 0) return;

    const interval = setInterval(() => {
      setCurrentIndex((prev) => (prev + 1) % banners.length);
    }, autoplayInterval * 1000);

    return () => clearInterval(interval);
  }, [banners.length, autoplayInterval]);

  const goToNext = () => {
    setCurrentIndex((prev) => (prev + 1) % banners.length);
  };

  const goToPrevious = () => {
    setCurrentIndex((prev) => (prev - 1 + banners.length) % banners.length);
  };

  const goToSlide = (index) => {
    setCurrentIndex(index);
  };

  if (!banners || banners.length === 0) {
    return (
      <div className="bg-slate-100 py-24 text-center">
        <p className="text-slate-500">No banners configured</p>
      </div>
    );
  }

  const currentBanner = banners[currentIndex];

  return (
    <div id={anchor || undefined} className="relative w-full overflow-hidden">
      {/* Banner Container */}
      <div className="relative h-[500px] md:h-[600px]">
        {/* Background Image */}
        <div
          className="absolute inset-0 bg-cover bg-center transition-all duration-700"
          style={{
            backgroundImage: currentBanner.backgroundImage
              ? `url(${currentBanner.backgroundImage})`
              : 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)'
          }}
        >
          <div className="absolute inset-0 bg-black/40" />
        </div>

        {/* Content */}
        <div className="relative h-full flex items-center justify-center text-center px-4">
          <div className="max-w-4xl mx-auto text-white">
            {currentBanner.headerText && (
              <h1 className="text-4xl md:text-6xl font-bold mb-6 animate-fade-in">
                {currentBanner.headerText}
              </h1>
            )}
            {currentBanner.paragraphText && (
              <p className="text-lg md:text-xl mb-8 max-w-2xl mx-auto opacity-90 animate-fade-in">
                {currentBanner.paragraphText}
              </p>
            )}
            {currentBanner.ctaText && currentBanner.ctaLink && (
              <a
                href={currentBanner.ctaLink}
                className="inline-block px-8 py-4 bg-white text-slate-900 font-semibold rounded-lg hover:bg-slate-100 transition-colors shadow-lg animate-fade-in"
              >
                {currentBanner.ctaText}
              </a>
            )}
          </div>
        </div>

        {/* Navigation Arrows */}
        {banners.length > 1 && (
          <>
            <button
              onClick={goToPrevious}
              className="absolute left-4 top-1/2 -translate-y-1/2 w-12 h-12 rounded-full bg-white/20 hover:bg-white/30 backdrop-blur-sm flex items-center justify-center transition-colors"
              aria-label="Previous banner"
            >
              <ChevronLeft className="w-6 h-6 text-white" />
            </button>
            <button
              onClick={goToNext}
              className="absolute right-4 top-1/2 -translate-y-1/2 w-12 h-12 rounded-full bg-white/20 hover:bg-white/30 backdrop-blur-sm flex items-center justify-center transition-colors"
              aria-label="Next banner"
            >
              <ChevronRight className="w-6 h-6 text-white" />
            </button>
          </>
        )}

        {/* Dots Navigation */}
        {banners.length > 1 && (
          <div className="absolute bottom-8 left-1/2 -translate-x-1/2 flex gap-2">
            {banners.map((_, index) => (
              <button
                key={index}
                onClick={() => goToSlide(index)}
                className={`w-3 h-3 rounded-full transition-all ${
                  index === currentIndex
                    ? 'bg-white w-8'
                    : 'bg-white/50 hover:bg-white/70'
                }`}
                aria-label={`Go to banner ${index + 1}`}
              />
            ))}
          </div>
        )}
      </div>

      <style>{`
        @keyframes fade-in {
          from {
            opacity: 0;
            transform: translateY(20px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
        .animate-fade-in {
          animation: fade-in 0.6s ease-out;
        }
      `}</style>
    </div>
  );
}