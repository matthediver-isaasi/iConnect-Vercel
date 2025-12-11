import { useState, useRef, useEffect } from "react";

export function LazyImage({ 
  src, 
  alt, 
  className = "", 
  style = {},
  fallback = null,
  placeholderClassName = ""
}) {
  const [status, setStatus] = useState('loading');
  const imgRef = useRef(null);

  useEffect(() => {
    const img = imgRef.current;
    if (!img) return;

    if (img.complete && img.naturalWidth > 0) {
      setStatus('loaded');
    }
  }, [src]);

  const handleLoad = () => {
    setStatus('loaded');
  };

  const handleError = () => {
    setStatus('error');
  };

  if (status === 'error' && fallback) {
    return (
      <div 
        className={`relative flex items-center justify-center bg-slate-100 dark:bg-slate-800 ${className}`}
        style={style}
      >
        {fallback}
      </div>
    );
  }

  return (
    <div 
      className={`relative ${className}`} 
      style={style}
    >
      {status === 'loading' && (
        <div 
          className={`absolute inset-0 z-10 flex items-center justify-center bg-slate-100 dark:bg-slate-800 ${placeholderClassName}`}
          style={style}
        >
          <div className="w-6 h-6 rounded-full border-2 border-slate-300 dark:border-slate-600 border-t-blue-500 animate-spin" />
        </div>
      )}
      
      <img
        ref={imgRef}
        src={src}
        alt={alt}
        className="w-full h-full object-cover"
        style={{ borderRadius: style.borderRadius }}
        onLoad={handleLoad}
        onError={handleError}
      />
    </div>
  );
}

export default LazyImage;
