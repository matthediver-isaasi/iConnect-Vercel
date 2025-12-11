import { useState, useEffect, useRef } from "react";

export function LazyImage({ 
  src, 
  alt, 
  className = "", 
  style = {},
  fallback = null,
  placeholderClassName = "",
  rootMargin = "100px",
  threshold = 0.1
}) {
  const [isLoaded, setIsLoaded] = useState(false);
  const [isError, setIsError] = useState(false);
  const [isInView, setIsInView] = useState(false);
  const imgRef = useRef(null);
  const containerRef = useRef(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setIsInView(true);
            observer.unobserve(container);
          }
        });
      },
      {
        rootMargin,
        threshold
      }
    );

    observer.observe(container);

    return () => {
      observer.disconnect();
    };
  }, [rootMargin, threshold]);

  const handleLoad = () => {
    setIsLoaded(true);
    setIsError(false);
  };

  const handleError = () => {
    setIsError(true);
    setIsLoaded(true);
  };

  return (
    <div ref={containerRef} className={`relative ${className}`} style={style}>
      {!isLoaded && (
        <div 
          className={`absolute inset-0 flex items-center justify-center bg-slate-100 dark:bg-slate-800 animate-pulse ${placeholderClassName}`}
          style={style}
        >
          <div className="w-8 h-8 rounded-full border-2 border-slate-300 dark:border-slate-600 border-t-blue-500 animate-spin" />
        </div>
      )}
      
      {isError && fallback ? (
        <div className="absolute inset-0 flex items-center justify-center">
          {fallback}
        </div>
      ) : (
        isInView && (
          <img
            ref={imgRef}
            src={src}
            alt={alt}
            className={`${className} ${isLoaded && !isError ? 'opacity-100' : 'opacity-0'} transition-opacity duration-300`}
            style={style}
            onLoad={handleLoad}
            onError={handleError}
          />
        )
      )}
    </div>
  );
}

export default LazyImage;
