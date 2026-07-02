import { useState, useEffect } from "react";

export default function PostImageGallery({ images, updateId, onImageClick }) {
  const [mainIndex, setMainIndex] = useState(0);

  useEffect(() => {
    setMainIndex(0);
  }, [images, updateId]);

  if (!images || images.length === 0) return null;

  const mainImage = images[mainIndex];

  return (
    <div className="space-y-2">
      <img
        src={mainImage}
        alt=""
        className="w-full rounded-md object-cover max-h-80 cursor-pointer"
        onClick={() => onImageClick?.(mainImage)}
        data-testid={`img-update-main-${updateId}`}
      />
      {images.length > 1 && (
        <div className="flex gap-2 overflow-x-auto">
          {images.map((imgUrl, idx) => (
            <img
              key={idx}
              src={imgUrl}
              alt=""
              className={`w-16 h-16 rounded-md object-cover cursor-pointer border-2 shrink-0 transition-colors ${
                idx === mainIndex
                  ? "border-primary opacity-100"
                  : "border-transparent opacity-70 hover:opacity-100"
              }`}
              onClick={() => setMainIndex(idx)}
              data-testid={`img-update-thumb-${updateId}-${idx}`}
            />
          ))}
        </div>
      )}
    </div>
  );
}
