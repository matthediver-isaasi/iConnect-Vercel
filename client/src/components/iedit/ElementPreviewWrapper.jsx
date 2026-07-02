import { useState } from "react";
import { Edit3 } from "lucide-react";

export default function ElementPreviewWrapper({ 
  children, 
  element, 
  onEdit,
  isEditing = false
}) {
  const [isHovered, setIsHovered] = useState(false);

  return (
    <div 
      className="relative group"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {children}
      
      {(isHovered || isEditing) && (
        <div 
          className={`absolute inset-0 transition-all duration-200 ${
            isEditing 
              ? 'ring-2 ring-blue-500 ring-offset-2' 
              : 'ring-2 ring-blue-400/50 ring-offset-1'
          }`}
          style={{ zIndex: 10, pointerEvents: 'none' }}
        />
      )}
      
      {isHovered && !isEditing && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onEdit(element);
          }}
          className="absolute top-3 right-3 z-20 flex items-center gap-2 px-3 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg shadow-lg transition-all transform hover:scale-105"
          title={`Edit ${element.element_type.replace(/_/g, ' ')}`}
          data-testid={`button-inline-edit-${element.id}`}
        >
          <Edit3 className="w-4 h-4" />
          <span className="text-sm font-medium">Edit</span>
        </button>
      )}
      
      {isHovered && !isEditing && (
        <div className="absolute bottom-3 left-3 z-20 px-2 py-1 bg-slate-800/80 text-white rounded text-xs capitalize">
          {element.element_type.replace(/_/g, ' ')}
        </div>
      )}
    </div>
  );
}
