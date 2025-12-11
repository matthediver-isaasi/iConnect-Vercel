import React, { useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { User, Mail, Linkedin, Loader2 } from "lucide-react";
import DOMPurify from 'dompurify';
import { LazyImage } from "@/components/ui/lazy-image";

export default function WallOfFameDisplay({ 
  sectionId,
  showCategoryName = true,
  customTitle,
  titleFontFamily = 'Poppins',
  titleFontWeight = 700,
  titleFontSize = 32,
  titleColor = '#1e293b',
  titleAlign = 'center',
  cardsPerRow = 4,
  rowAlign = 'center',
  backgroundType = 'none',
  backgroundColor = '#f8fafc',
  gradientStartColor = '#3b82f6',
  gradientEndColor = '#8b5cf6',
  gradientAngle = 135,
  backgroundImageUrl,
  backgroundImageFit = 'cover',
  overlayEnabled = false,
  overlayColor = '#000000',
  overlayOpacity = 50,
  headingText,
  headingFontFamily = 'Poppins',
  headingFontSize = 36,
  headingFontSizeMobile,
  headingFontWeight = 700,
  headingLineHeight = 1.2,
  headingLetterSpacing = 0,
  headingColor = '#1e293b',
  subheadingText,
  subheadingFontFamily = 'Poppins',
  subheadingFontSize = 20,
  subheadingFontSizeMobile,
  subheadingFontWeight = 400,
  subheadingLineHeight = 1.5,
  subheadingLetterSpacing = 0,
  subheadingColor = '#475569',
  bodyContent,
  contentFontFamily = 'Poppins',
  contentFontSize = 16,
  contentFontSizeMobile,
  contentFontWeight = 400,
  contentLineHeight = 1.6,
  contentLetterSpacing = 0,
  contentColor = '#64748b',
  textAlign = 'center'
}) {
  const [selectedCategory, setSelectedCategory] = useState(null);
  const [flippedPerson, setFlippedPerson] = useState(null);

  const { data: section, isLoading: sectionLoading } = useQuery({
    queryKey: ['wall-of-fame-section', sectionId],
    queryFn: async () => {
      const sections = await base44.entities.WallOfFameSection.list();
      return sections.find(s => s.id === sectionId);
    },
    enabled: !!sectionId,
  });

  const { data: categories = [], isLoading: categoriesLoading } = useQuery({
    queryKey: ['wall-of-fame-categories', sectionId],
    queryFn: async () => {
      const cats = await base44.entities.WallOfFameCategory.list();
      return cats.filter(c => c.section_id === sectionId && c.is_active).sort((a, b) => (a.display_order || 0) - (b.display_order || 0));
    },
    enabled: !!sectionId,
  });

  // Auto-select category if there's only one
  useEffect(() => {
    if (!categoriesLoading && categories.length === 1 && !selectedCategory) {
      setSelectedCategory(categories[0]);
    }
  }, [categories, categoriesLoading, selectedCategory]);

  // Check if we should show the back button (only when more than one category)
  const showBackButton = categories.length > 1;

  const { data: people = [], isLoading: peopleLoading } = useQuery({
    queryKey: ['wall-of-fame-people', selectedCategory?.id],
    queryFn: async () => {
      const allPeople = await base44.entities.WallOfFamePerson.list();
      return allPeople.filter(p => p.category_id === selectedCategory.id && p.is_active).sort((a, b) => (a.display_order || 0) - (b.display_order || 0));
    },
    enabled: !!selectedCategory,
  });

  const { data: photoSizeSetting } = useQuery({
    queryKey: ['wall-of-fame-photo-size'],
    queryFn: async () => {
      const allSettings = await base44.entities.SystemSettings.list();
      const setting = allSettings.find(s => s.setting_key === 'wall_of_fame_photo_size');
      return setting?.setting_value || 'medium';
    }
  });

  const photoSize = photoSizeSetting || 'medium';
  const sizeClasses = {
    small: 'w-24 h-24',
    medium: 'w-32 h-32',
    large: 'w-40 h-40'
  };

  const isLoading = sectionLoading || categoriesLoading;

  // Get grid column classes based on cardsPerRow
  const getGridCols = () => {
    const cols = parseInt(cardsPerRow) || 4;
    switch (cols) {
      case 1: return 'grid-cols-1';
      case 2: return 'grid-cols-1 sm:grid-cols-2';
      case 3: return 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3';
      case 4: return 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4';
      case 5: return 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5';
      case 6: return 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6';
      default: return 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4';
    }
  };

  // Get justify classes based on rowAlign
  const getRowJustify = () => {
    switch (rowAlign) {
      case 'left': return 'justify-start';
      case 'right': return 'justify-end';
      case 'center':
      default: return 'justify-center';
    }
  };

  // Get the title to display - use customTitle if set, otherwise category name
  const getDisplayTitle = () => {
    if (customTitle && customTitle.trim()) {
      return customTitle;
    }
    if (selectedCategory) {
      return selectedCategory.name;
    }
    return section?.name || '';
  };

  // Get background style
  const getBackgroundStyle = () => {
    if (backgroundType === 'color') {
      return { backgroundColor };
    }
    if (backgroundType === 'gradient') {
      return { 
        background: `linear-gradient(${gradientAngle}deg, ${gradientStartColor}, ${gradientEndColor})` 
      };
    }
    return {};
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  if (!section) {
    return (
      <div className="text-center py-12">
        <p className="text-slate-600">Section not found</p>
      </div>
    );
  }

  // Title style based on props
  const titleStyle = {
    fontFamily: titleFontFamily,
    fontWeight: titleFontWeight,
    fontSize: `${titleFontSize}px`,
    color: titleColor,
    textAlign: titleAlign
  };

  // Check if we have a background
  const hasBackground = backgroundType && backgroundType !== 'none';

  return (
    <div 
      className="relative py-12"
      style={hasBackground && backgroundType !== 'image' ? getBackgroundStyle() : {}}
    >
      {/* Background image layer */}
      {backgroundType === 'image' && backgroundImageUrl && (
        <>
          <img 
            src={backgroundImageUrl} 
            alt="Background" 
            className="absolute inset-0 w-full h-full"
            style={{ objectFit: backgroundImageFit }}
          />
          {overlayEnabled && (
            <div 
              className="absolute inset-0" 
              style={{ 
                backgroundColor: overlayColor, 
                opacity: parseInt(overlayOpacity) / 100 
              }} 
            />
          )}
        </>
      )}

      {/* Content layer */}
      <div className="relative max-w-7xl mx-auto px-4">
        {/* Custom Header, Subheader & Content */}
        {(headingText || subheadingText || bodyContent) && (
          <div className={`mb-8 ${textAlign === 'left' ? 'text-left' : textAlign === 'right' ? 'text-right' : 'text-center'}`}>
            {headingText && (
              <div 
                style={{
                  fontFamily: headingFontFamily,
                  fontSize: `${headingFontSize}px`,
                  fontWeight: headingFontWeight,
                  lineHeight: headingLineHeight,
                  letterSpacing: `${headingLetterSpacing}px`,
                  color: headingColor
                }}
                className="mb-4 prose max-w-none"
                dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(headingText) }}
              />
            )}
            {subheadingText && (
              <div 
                style={{
                  fontFamily: subheadingFontFamily,
                  fontSize: `${subheadingFontSize}px`,
                  fontWeight: subheadingFontWeight,
                  lineHeight: subheadingLineHeight,
                  letterSpacing: `${subheadingLetterSpacing}px`,
                  color: subheadingColor
                }}
                className="mb-4 prose max-w-none"
                dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(subheadingText) }}
              />
            )}
            {bodyContent && (
              <div 
                style={{
                  fontFamily: contentFontFamily,
                  fontSize: `${contentFontSize}px`,
                  fontWeight: contentFontWeight,
                  lineHeight: contentLineHeight,
                  letterSpacing: `${contentLetterSpacing}px`,
                  color: contentColor
                }}
                className="prose max-w-none"
                dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(bodyContent) }}
              />
            )}
          </div>
        )}

        {/* Section header - only show if no category selected OR if multiple categories exist */}
        {!selectedCategory && (
          <div className="text-center mb-12">
            <h2 className="text-3xl md:text-4xl font-bold text-slate-900 mb-4">
              {section.name}
            </h2>
            {section.description && (
              <p className="text-lg text-slate-600 max-w-3xl mx-auto">
                {section.description}
              </p>
            )}
          </div>
        )}

        {!selectedCategory ? (
          <div className={`grid ${getGridCols()} gap-6`}>
            {categories.map(category => (
              <Card
                key={category.id}
                className="p-8 cursor-pointer hover:shadow-xl transition-all duration-300 border-2 border-slate-200 hover:border-blue-500 bg-white"
                onClick={() => setSelectedCategory(category)}
              >
                <div className="text-center">
                  <div className="w-20 h-20 rounded-full bg-gradient-to-br from-blue-100 to-blue-200 flex items-center justify-center mx-auto mb-4">
                    <User className="w-10 h-10 text-blue-600" />
                  </div>
                  <h3 className="text-xl font-bold text-slate-900 mb-2">
                    {category.name}
                  </h3>
                  {category.description && (
                    <p className="text-sm text-slate-600">
                      {category.description}
                    </p>
                  )}
                </div>
              </Card>
            ))}
          </div>
        ) : (
          <div>
            {(showBackButton || showCategoryName) && (
              <div className="mb-8" style={{ textAlign: titleAlign }}>
                {showBackButton && (
                  <div className="mb-4" style={{ textAlign: titleAlign }}>
                    <Button
                      variant="outline"
                      onClick={() => {
                        setSelectedCategory(null);
                        setFlippedPerson(null);
                      }}
                    >
                      ← Back to Categories
                    </Button>
                  </div>
                )}
                {showCategoryName && (
                  <>
                    <h3 style={titleStyle} className="mb-2">
                      {getDisplayTitle()}
                    </h3>
                    {selectedCategory.description && (
                      <p className="text-slate-600" style={{ textAlign: titleAlign }}>
                        {selectedCategory.description}
                      </p>
                    )}
                  </>
                )}
              </div>
            )}

            {peopleLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
              </div>
            ) : (
              <div className={`flex flex-wrap ${getRowJustify()} gap-6`}>
                {people.map(person => (
                  <div
                    key={person.id}
                    className="perspective-1000"
                    style={{ 
                      perspective: '1000px',
                      width: `calc(${100 / (parseInt(cardsPerRow) || 4)}% - 1.5rem)`,
                      minWidth: '280px',
                      maxWidth: '320px'
                    }}
                  >
                    <div
                      className={`relative w-full h-96 transition-all duration-700 cursor-pointer transform-style-3d ${
                        flippedPerson === person.id ? 'rotate-y-180' : ''
                      }`}
                      style={{
                        transformStyle: 'preserve-3d',
                        transform: flippedPerson === person.id ? 'rotateY(180deg)' : 'rotateY(0deg)'
                      }}
                      onClick={() => setFlippedPerson(flippedPerson === person.id ? null : person.id)}
                    >
                      {/* Front of card */}
                      <div
                        className="absolute w-full h-full backface-hidden"
                        style={{ backfaceVisibility: 'hidden' }}
                      >
                        <Card className="w-full h-full p-6 flex flex-col items-center justify-center text-center border-2 border-slate-200 hover:border-blue-500 transition-colors bg-white">
                          <div className={`${sizeClasses[photoSize]} rounded-full bg-slate-100 flex items-center justify-center overflow-hidden mb-4 flex-shrink-0 aspect-square`} style={{ minWidth: photoSize === 'large' ? '10rem' : photoSize === 'medium' ? '8rem' : '6rem', minHeight: photoSize === 'large' ? '10rem' : photoSize === 'medium' ? '8rem' : '6rem' }}>
                            {person.profile_photo_url ? (
                              <LazyImage
                                src={person.profile_photo_url}
                                alt={`${person.first_name} ${person.last_name}`}
                                className="w-full h-full rounded-full"
                                style={{ borderRadius: '50%' }}
                                placeholderClassName="rounded-full"
                                fallback={<User className={`${photoSize === 'large' ? 'w-20 h-20' : photoSize === 'medium' ? 'w-16 h-16' : 'w-12 h-12'} text-slate-400`} />}
                              />
                            ) : (
                              <User className={`${photoSize === 'large' ? 'w-20 h-20' : photoSize === 'medium' ? 'w-16 h-16' : 'w-12 h-12'} text-slate-400`} />
                            )}
                          </div>
                          <h4 className="text-lg font-bold text-slate-900 mb-1">
                            {person.first_name} {person.last_name}
                          </h4>
                          {person.job_title && (
                            <p className="text-sm text-slate-600">{person.job_title}</p>
                          )}
                          {(person.secondary_organisation || person.secondary_job_title) && (
                            <>
                              <div className="w-12 h-px bg-slate-300 mx-auto my-2"></div>
                              {person.secondary_job_title && (
                                <p className="text-xs text-slate-600">{person.secondary_job_title}</p>
                              )}
                              {person.secondary_organisation && (
                                <p className="text-xs text-slate-500">{person.secondary_organisation}</p>
                              )}
                            </>
                          )}
                          <p className="text-xs text-slate-400 mt-4">Click to view details</p>
                        </Card>
                      </div>

                      {/* Back of card */}
                      <div
                        className="absolute w-full h-full backface-hidden"
                        style={{
                          backfaceVisibility: 'hidden',
                          transform: 'rotateY(180deg)'
                        }}
                      >
                        <Card className="w-full h-full p-6 overflow-y-auto border-2 border-blue-500 bg-gradient-to-br from-blue-50 to-white">
                          <div className="flex flex-col h-full">
                            <div className="text-center mb-4">
                              <h4 className="text-lg font-bold text-slate-900 mb-1">
                                {person.first_name} {person.last_name}
                              </h4>
                              {person.job_title && (
                                <p className="text-sm text-blue-600 font-medium">{person.job_title}</p>
                              )}
                              {(person.secondary_organisation || person.secondary_job_title) && (
                                <>
                                  <div className="w-16 h-px bg-slate-300 mx-auto my-2"></div>
                                  {person.secondary_job_title && (
                                    <p className="text-xs text-slate-700">{person.secondary_job_title}</p>
                                  )}
                                  {person.secondary_organisation && (
                                    <p className="text-xs text-slate-600">{person.secondary_organisation}</p>
                                  )}
                                </>
                              )}
                            </div>

                            {person.biography && (
                              <div className="flex-1 overflow-y-auto mb-4">
                                <p className="text-sm text-slate-700 leading-relaxed">
                                  {person.biography}
                                </p>
                              </div>
                            )}

                            <div className="flex flex-col gap-2 mt-auto">
                              {person.email && (
                                <a
                                  href={`mailto:${person.email}`}
                                  className="flex items-center justify-center gap-2 px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  <Mail className="w-4 h-4" />
                                  Email
                                </a>
                              )}
                              {person.linkedin_url && (
                                <a
                                  href={person.linkedin_url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="flex items-center justify-center gap-2 px-3 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  <Linkedin className="w-4 h-4" />
                                  LinkedIn
                                </a>
                              )}
                            </div>

                            <p className="text-xs text-slate-400 mt-4 text-center">Click to flip back</p>
                          </div>
                        </Card>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
