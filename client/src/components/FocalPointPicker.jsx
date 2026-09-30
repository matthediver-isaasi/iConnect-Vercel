import { useState, useRef, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Crosshair, RotateCcw } from "lucide-react";

export function FocalPointPicker({ 
  imageUrl, 
  focalPoint = { x: 50, y: 50 }, 
  onChange,
  className = ""
}) {
  const containerRef = useRef(null);
  const [isDragging, setIsDragging] = useState(false);

  const handleClick = useCallback((e) => {
    if (!containerRef.current) return;
    
    const rect = containerRef.current.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;
    
    const clampedX = Math.max(0, Math.min(100, x));
    const clampedY = Math.max(0, Math.min(100, y));
    
    onChange({ x: Math.round(clampedX), y: Math.round(clampedY) });
  }, [onChange]);

  const handleMouseDown = (e) => {
    setIsDragging(true);
    handleClick(e);
  };

  const handleMouseMove = (e) => {
    if (isDragging) {
      handleClick(e);
    }
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  const handleReset = () => {
    onChange({ x: 50, y: 50 });
  };

  if (!imageUrl) {
    return null;
  }

  const fpX = focalPoint?.x ?? 50;
  const fpY = focalPoint?.y ?? 50;

  return (
    <div className={`space-y-2 ${className}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Crosshair className="h-4 w-4" />
          <span>Click image to set focal point</span>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={handleReset}
          className="gap-1"
          data-testid="button-reset-focal-point"
        >
          <RotateCcw className="h-3 w-3" />
          Reset to center
        </Button>
      </div>
      
      <div 
        ref={containerRef}
        className="relative cursor-crosshair rounded-lg overflow-hidden border"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        data-testid="focal-point-picker"
      >
        <img 
          src={imageUrl} 
          alt="Event image with focal point picker"
          className="w-full h-auto max-h-[300px] object-contain"
          draggable={false}
        />
        
        <div 
          className="absolute w-8 h-8 -translate-x-1/2 -translate-y-1/2 pointer-events-none"
          style={{ 
            left: `${fpX}%`, 
            top: `${fpY}%` 
          }}
        >
          <div className="absolute inset-0 rounded-full border-2 border-white shadow-lg" />
          <div className="absolute inset-[6px] rounded-full border-2 border-primary bg-primary/20" />
          <div className="absolute inset-[12px] rounded-full bg-primary" />
        </div>
        
        <div 
          className="absolute top-0 bottom-0 w-px bg-white/50 pointer-events-none"
          style={{ left: `${fpX}%` }}
        />
        <div 
          className="absolute left-0 right-0 h-px bg-white/50 pointer-events-none"
          style={{ top: `${fpY}%` }}
        />
      </div>
      
      <div className="flex items-center justify-center gap-4 text-xs text-muted-foreground">
        <span>X: {fpX}%</span>
        <span>Y: {fpY}%</span>
      </div>
      
      <div className="rounded-lg overflow-hidden border bg-muted/50">
        <p className="text-xs text-muted-foreground px-3 py-2">Preview (cropped to 16:9)</p>
        <div className="relative w-full aspect-video overflow-hidden">
          <img 
            src={imageUrl} 
            alt="Focal point preview"
            className="absolute inset-0 w-full h-full object-cover"
            style={{ objectPosition: `${fpX}% ${fpY}%` }}
          />
        </div>
      </div>
    </div>
  );
}

export function getFocalPointStyle(focalPoint) {
  const x = focalPoint?.x ?? 50;
  const y = focalPoint?.y ?? 50;
  return { objectPosition: `${x}% ${y}%` };
}
