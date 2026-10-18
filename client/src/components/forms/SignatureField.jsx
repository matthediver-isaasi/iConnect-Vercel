import { useRef, useState, useEffect, useCallback } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Eraser, Check, PenLine, Type, Upload } from 'lucide-react';

export default function SignatureField({ 
  fieldId, 
  value, 
  onChange, 
  disabled = false,
  required = false,
  label = 'Signature',
  allowUpload = false
}) {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const uploadId = useRef(0);
  const [uploadError, setUploadError] = useState('');
  const [uploading, setUploading] = useState(false);
  const canvasRef = useRef(null);
  const canvasWrapperRef = useRef(null);
  const cachedWidthRef = useRef(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [hasSignature, setHasSignature] = useState(false);
  const [mode, setMode] = useState(() => {
    if (allowUpload && value?.mode === 'uploaded') return 'upload';
    if (value && typeof value === 'object' && value.mode === 'typed') {
      return 'type';
    }
    return 'draw';
  });
  const [typedName, setTypedName] = useState(() => {
    if (value && typeof value === 'object' && value.typedName) {
      return value.typedName;
    }
    return '';
  });

  const setupCanvas = useCallback((forceWidthUpdate = false) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    const container = canvasWrapperRef.current;
    if (!container) return;
    
    if (forceWidthUpdate || cachedWidthRef.current === null) {
      const rect = container.getBoundingClientRect();
      cachedWidthRef.current = Math.max(rect.width, 200);
    }
    
    const width = cachedWidthRef.current;
    const dpr = window.devicePixelRatio || 1;
    
    canvas.width = width * dpr;
    canvas.height = 150 * dpr;
    
    ctx.scale(dpr, dpr);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 2;
  }, []);

  useEffect(() => {
    let active = true;
    setupCanvas(true);
    setHasSignature(Boolean(value));
    
    if (value && canvasRef.current && canvasWrapperRef.current) {
      const canvas = canvasRef.current;
      const ctx = canvas.getContext('2d');
      const width = cachedWidthRef.current;
      
      const img = new Image();
      img.onload = () => {
        if (!active) return;
        ctx.drawImage(img, 0, 0, width, 150);
        setHasSignature(true);
      };
      img.src = value.data || value;
    }

    const handleResize = () => {
      const saved = canvasRef.current?.toDataURL('image/png');
      setupCanvas(true);
      if (saved && canvasRef.current) {
        const img = new Image();
        img.onload = () => canvasRef.current?.getContext('2d').drawImage(img, 0, 0, cachedWidthRef.current, 150);
        img.src = saved;
      }
    };
    window.addEventListener('resize', handleResize);
    return () => { active = false; window.removeEventListener('resize', handleResize); };
  }, [value, setupCanvas]);

  const renderTypedSignature = useCallback((name) => {
    const canvas = canvasRef.current;
    if (!canvas || !name.trim() || cachedWidthRef.current === null) return;

    const ctx = canvas.getContext('2d');
    const width = cachedWidthRef.current;
    const dpr = window.devicePixelRatio || 1;
    
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, 150);
    
    ctx.fillStyle = '#1e293b';
    ctx.font = '48px "Caveat", cursive';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    
    ctx.fillText(name.trim(), width / 2, 75, Math.max(100, width - 24));
    
    setHasSignature(true);
    
    const dataUrl = canvas.toDataURL('image/png');
    onChangeRef.current({
      type: 'signature',
      mode: 'typed',
      typedName: name,
      data: dataUrl,
      signed_at: new Date().toISOString()
    });
  }, []);

  useEffect(() => {
    if (mode === 'type' && typedName.trim()) {
      const timeoutId = setTimeout(() => {
        renderTypedSignature(typedName);
      }, 300);
      return () => clearTimeout(timeoutId);
    }
  }, [typedName, mode, renderTypedSignature]);

  const getCoordinates = (e) => {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    
    if (e.touches) {
      return {
        x: e.touches[0].clientX - rect.left,
        y: e.touches[0].clientY - rect.top
      };
    }
    
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top
    };
  };

  const startDrawing = (e) => {
    if (disabled || mode !== 'draw') return;
    e.preventDefault();
    
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const { x, y } = getCoordinates(e);
    
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + 0.1, y + 0.1);
    ctx.stroke();
    setIsDrawing(true);
    setHasSignature(true);
  };

  const draw = (e) => {
    if (!isDrawing || disabled || mode !== 'draw') return;
    e.preventDefault();
    
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    const { x, y } = getCoordinates(e);
    
    ctx.lineTo(x, y);
    ctx.stroke();
  };

  const stopDrawing = () => {
    if (!isDrawing) return;
    setIsDrawing(false);
    
    const canvas = canvasRef.current;
    const dataUrl = canvas.toDataURL('image/png');
    onChange({
      type: 'signature',
      mode: 'drawn',
      data: dataUrl,
      signed_at: new Date().toISOString()
    });
  };

  const clearSignature = () => {
    uploadId.current += 1;
    setUploading(false);
    setUploadError('');
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    
    if (cachedWidthRef.current !== null) {
      ctx.clearRect(0, 0, cachedWidthRef.current, 150);
    }
    
    setHasSignature(false);
    setTypedName('');
    onChange(null);
  };

  const handleModeChange = (newMode) => {
    if (newMode === mode) return;
    
    clearSignature();
    setMode(newMode);
    
    setTimeout(() => {
      setupCanvas();
    }, 0);
  };

  const handleTypedNameChange = (e) => {
    const name = e.target.value;
    onChangeRef.current(null);
    setHasSignature(false);
    setTypedName(name);
    
    if (!name.trim()) {
      clearSignature();
    }
  };

  const uploadSignature = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    clearSignature();
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 2 * 1024 * 1024) {
      setUploadError('Choose a PNG, JPEG or WebP image smaller than 2 MB.');
      return;
    }
    const id = ++uploadId.current;
    setUploading(true);
    const url = URL.createObjectURL(file);
    try {
      const image = new Image();
      await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; image.src = url; });
      if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > 24000000) throw new Error('Image is too large.');
      const output = document.createElement('canvas');
      output.width = 1000;
      output.height = 300;
      const context = output.getContext('2d');
      const ratio = Math.min(1000 / image.naturalWidth, 300 / image.naturalHeight);
      const width = image.naturalWidth * ratio;
      const height = image.naturalHeight * ratio;
      context.drawImage(image, (1000 - width) / 2, (300 - height) / 2, width, height);
      if (id !== uploadId.current) return;
      onChangeRef.current({ type: 'signature', mode: 'uploaded', data: output.toDataURL('image/png'), signed_at: new Date().toISOString() });
      setHasSignature(true);
    } catch {
      if (id === uploadId.current) setUploadError('This image could not be read. Choose another signature image.');
    } finally {
      URL.revokeObjectURL(url);
      if (id === uploadId.current) setUploading(false);
    }
  };

  useEffect(() => () => { uploadId.current += 1; }, []);

  return (
    <div className="space-y-3 w-full max-w-full overflow-hidden">
      {!disabled && (
        <div className="flex flex-wrap gap-1 p-1 bg-muted rounded-lg w-fit" aria-label={label}>
          <Button
            type="button"
            variant={mode === 'draw' ? 'default' : 'ghost'}
            size="sm"
            onClick={() => handleModeChange('draw')}
            data-testid={`button-signature-mode-draw-${fieldId}`}
          >
            <PenLine className="w-4 h-4 mr-2" />
            Draw
          </Button>
          <Button
            type="button"
            variant={mode === 'type' ? 'default' : 'ghost'}
            size="sm"
            onClick={() => handleModeChange('type')}
            data-testid={`button-signature-mode-type-${fieldId}`}
          >
            <Type className="w-4 h-4 mr-2" />
            Type
          </Button>
          {allowUpload && <Button type="button" variant={mode === 'upload' ? 'default' : 'ghost'} size="sm" onClick={() => handleModeChange('upload')} data-testid={`button-signature-mode-upload-${fieldId}`}><Upload className="w-4 h-4 mr-2" />Upload</Button>}
        </div>
      )}
      {mode === 'upload' && !disabled && <div className="space-y-2"><label htmlFor={`signature-upload-${fieldId}`} className="text-sm">Upload your signature (PNG, JPEG or WebP, up to 2 MB)</label><Input id={`signature-upload-${fieldId}`} type="file" accept="image/png,image/jpeg,image/webp" disabled={uploading} onChange={uploadSignature} />{uploading && <p role="status" className="text-sm text-muted-foreground">Preparing signature image…</p>}{uploadError && <p role="alert" className="text-sm text-destructive">{uploadError}</p>}</div>}

      {mode === 'type' && !disabled && (
        <Input
          type="text"
          placeholder="Type your full name"
          value={typedName}
          onChange={handleTypedNameChange}
          className="max-w-xs"
          data-testid={`input-signature-typed-name-${fieldId}`}
        />
      )}
      
      <div 
        ref={canvasWrapperRef}
        className={`relative border-2 rounded-lg overflow-hidden h-[150px] w-full ${
          disabled ? 'bg-slate-100 dark:bg-slate-800 cursor-not-allowed' : mode === 'draw' ? 'bg-white dark:bg-slate-900 cursor-crosshair' : 'bg-white dark:bg-slate-900'
        } ${hasSignature ? 'border-green-300 dark:border-green-700' : 'border-slate-300 dark:border-slate-600'}`}
        style={{ contain: 'inline-size' }}
      >
        <canvas
          ref={canvasRef}
          className="touch-none block"
          style={{ width: '100%', height: '150px' }}
          onMouseDown={startDrawing}
          onMouseMove={draw}
          onMouseUp={stopDrawing}
          onMouseLeave={stopDrawing}
          onTouchStart={startDrawing}
          onTouchMove={draw}
          onTouchEnd={stopDrawing}
          data-testid={`signature-canvas-${fieldId}`}
        />
        
        {!hasSignature && !disabled && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <p className="text-slate-400 dark:text-slate-500 text-sm">
              {mode === 'draw' ? 'Sign here' : mode === 'upload' ? 'Upload your signature above' : 'Type your name above'}
            </p>
          </div>
        )}
        
        {hasSignature && (
          <div className="absolute top-2 right-2">
            <Check className="w-5 h-5 text-green-500" />
          </div>
        )}
      </div>
      
      {!disabled && (
        <div className="flex justify-end">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={clearSignature}
            disabled={!hasSignature && !typedName}
            data-testid={`button-clear-signature-${fieldId}`}
          >
            <Eraser className="w-4 h-4 mr-2" />
            Clear
          </Button>
        </div>
      )}
    </div>
  );
}
