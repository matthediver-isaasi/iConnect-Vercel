import { useState } from "react";

export function LazyImage({ 
  src, 
  alt, 
  className = "", 
  style = {},
  fallback = null,
  placeholderClassName = ""
}) {
  const [loadState, setLoadState] = useState('loading');

  const handleLoad = () => {
    setLoadState('loaded');
  };

  const handleError = () => {
    setLoadState('error');
  };

  const isLoading = loadState === 'loading';
  const isError = loadState === 'error';
  const isLoaded = loadState === 'loaded';

  return (
    <div 
      className={`relative overflow-hidden ${className}`} 
      style={style}
    >
      {isLoading && (
        <div 
          className={`absolute inset-0 flex items-center justify-center bg-slate-100 dark:bg-slate-800 ${placeholderClassName}`}
        >
          <div className="w-6 h-6 rounded-full border-2 border-slate-300 dark:border-slate-600 border-t-blue-500 animate-spin" />
        </div>
      )}
      
      {isError && fallback && (
        <div className="absolute inset-0 flex items-center justify-center bg-slate-100 dark:bg-slate-800">
          {fallback}
        </div>
      )}
      
      <img
        src={src}
        alt={alt}
        loading="lazy"
        className={`absolute inset-0 w-full h-full object-cover transition-opacity duration-200 ${isLoaded ? 'opacity-100' : 'opacity-0'}`}
        style={{ borderRadius: style.borderRadius }}
        onLoad={handleLoad}
        onError={handleError}
      />
    </div>
  );
}

export default LazyImage;
