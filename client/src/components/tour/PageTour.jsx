
import React, { useState, useEffect, useMemo } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { X, Sparkles, ChevronLeft, ChevronRight, AlertCircle } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

export default function PageTour({ tourGroupName, viewId, onComplete, onDismissPermanently, autoShow = false }) {
  const [currentStep, setCurrentStep] = useState(0);
  const [isActive, setIsActive] = useState(autoShow);
  const [showPopup, setShowPopup] = useState(autoShow);
  const [isPopupVisible, setIsPopupVisible] = useState(false);
  const [targetElement, setTargetElement] = useState(null);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const [dontShowAgain, setDontShowAgain] = useState(false);
  const [mandatoryElementMissing, setMandatoryElementMissing] = useState(false);
  const [mandatoryCheckComplete, setMandatoryCheckComplete] = useState(false); // New state to track when mandatory check is done

  // Fetch tour group and steps from database
  const { data: tourGroup } = useQuery({
    queryKey: ['tourGroup', tourGroupName, viewId],
    queryFn: async () => {
      const allGroups = await base44.entities.TourGroup.list() || [];
      
      const found = allGroups.find(g => {
        const pageNameMatch = g.page_name === tourGroupName;
        const viewIdMatch = viewId ? g.view_id === viewId : !g.view_id;
        const isActiveMatch = g.is_active === true;
        
        return pageNameMatch && viewIdMatch && isActiveMatch;
      });
      
      return found;
    },
    enabled: !!tourGroupName
  });

  const { data: steps = [] } = useQuery({
    queryKey: ['tourSteps', tourGroup?.id],
    queryFn: async () => {
      if (!tourGroup?.id) {
        return [];
      }
      const allSteps = await base44.entities.TourStep.list() || [];
      const filteredSteps = allSteps
        .filter(s => s.tour_group_id === tourGroup.id)
        .sort((a, b) => a.step_order - b.step_order);
      return filteredSteps;
    },
    enabled: !!tourGroup?.id,
    staleTime: 0,
    refetchOnMount: true,
  });

  // Allow external trigger to show tour with mandatory selector validation
  useEffect(() => {
    if (autoShow && steps.length > 0 && tourGroup) {
      // Add a delay to ensure page has rendered
      const checkTimeout = setTimeout(() => {
        // Check for mandatory selector before activating
        if (tourGroup.mandatory_selector) {
          const mandatoryElement = document.querySelector(tourGroup.mandatory_selector);
          
          if (!mandatoryElement) {
            setMandatoryElementMissing(true);
            setMandatoryCheckComplete(true);
            setIsActive(true);
            setShowPopup(true);
            setIsPopupVisible(true);
            return;
          }
        }
        
        // If mandatory selector check passes (or no mandatory selector), activate tour
        setMandatoryElementMissing(false);
        setMandatoryCheckComplete(true);
        setIsActive(true);
        setShowPopup(true);
        setCurrentStep(0);
      }, 500);
      
      return () => clearTimeout(checkTimeout);
    }
  }, [autoShow, steps, tourGroup]);

  useEffect(() => {
    // If mandatory element is missing, this useEffect should not proceed to show tour steps
    // Also don't proceed if mandatory check hasn't completed yet
    if (!isActive || currentStep >= steps.length || !showPopup || steps.length === 0 || mandatoryElementMissing || !mandatoryCheckComplete) return;

    // Hide popup immediately when step changes
    setIsPopupVisible(false);

    const step = steps[currentStep];
    let timeoutId;
    let attempts = 0;
    const maxAttempts = 20;

    let currentHighlightedElement = null;

    // Define popup dimensions based on step size
    const getPopupDimensions = () => {
      const size = step.size || 'medium';
      const widths = {
        small: 320,
        medium: 384,
        large: 512
      };
      return {
        width: widths[size] || 384,
        height: 270
      };
    };

    const findAndHighlightElement = () => {
      const { width: popupWidth, height: popupHeight } = getPopupDimensions();
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
      const scrollLeft = window.pageXOffset || document.documentElement.scrollLeft;
      const gap = step.gap || 40;

      if (!step.target_selector) {
        setTargetElement(null);

        let centeredLeft = scrollLeft + (viewportWidth - popupWidth) / 2;
        let centeredTop = scrollTop + (viewportHeight - popupHeight) / 2;

        centeredLeft = Math.max(scrollLeft + gap, centeredLeft);
        centeredTop = Math.max(scrollTop + gap, centeredTop);
        centeredLeft = Math.min(scrollLeft + viewportWidth - popupWidth - gap, centeredLeft);
        centeredTop = Math.min(scrollTop + viewportHeight - popupHeight - gap, centeredTop);

        setPosition({
          top: centeredTop,
          left: centeredLeft
        });
        
        // Show popup immediately for welcome steps (no scroll needed)
        setIsPopupVisible(true);
        return;
      }

      const element = document.querySelector(step.target_selector);

      if (element) {
        currentHighlightedElement = element;
        setTargetElement(element);

        // Scroll the element into view smoothly
        element.scrollIntoView({
          behavior: 'smooth',
          block: 'center',
          inline: 'center'
        });

        // Wait for scroll to complete before calculating position AND showing popup
        setTimeout(() => {
          const currentScrollTop = window.pageYOffset || document.documentElement.scrollTop;
          const currentScrollLeft = window.pageXOffset || document.documentElement.scrollLeft;

          const rect = element.getBoundingClientRect();

          let calculatedTop = 0;
          let calculatedLeft = 0;
          const placement = step.placement || 'bottom';

          switch (placement) {
            case 'top':
              calculatedTop = rect.top + currentScrollTop - popupHeight - gap;
              calculatedLeft = rect.left + currentScrollLeft + (rect.width - popupWidth) / 2;

              if (calculatedTop < currentScrollTop) {
                calculatedTop = rect.bottom + currentScrollTop + gap;
              }
              break;

            case 'bottom':
              calculatedTop = rect.bottom + currentScrollTop + gap;
              calculatedLeft = rect.left + currentScrollLeft + (rect.width - popupWidth) / 2;

              if (calculatedTop + popupHeight > currentScrollTop + viewportHeight) {
                calculatedTop = rect.top + currentScrollTop - popupHeight - gap;
              }
              break;

            case 'left':
              calculatedTop = rect.top + currentScrollTop + (rect.height - popupHeight) / 2;
              calculatedLeft = rect.left + currentScrollLeft - popupWidth - gap;

              if (calculatedLeft < currentScrollLeft) {
                calculatedLeft = rect.right + currentScrollLeft + gap;
              }
              break;

            case 'right':
            default:
              calculatedTop = rect.top + currentScrollTop + (rect.height - popupHeight) / 2;
              calculatedLeft = rect.right + currentScrollLeft + gap;

              if (calculatedLeft + popupWidth > currentScrollLeft + viewportWidth) {
                calculatedLeft = rect.left + currentScrollLeft - popupWidth - gap;
              }
              break;
          }

          calculatedLeft = Math.max(currentScrollLeft + gap, calculatedLeft);
          calculatedTop = Math.max(currentScrollTop + gap, calculatedTop);
          calculatedLeft = Math.min(currentScrollLeft + viewportWidth - popupWidth - gap, calculatedLeft);
          calculatedTop = Math.min(currentScrollTop + viewportHeight - popupHeight - gap, calculatedTop);

          setPosition({ top: calculatedTop, left: calculatedLeft });
          
          // Show popup after scroll completes and position is set
          setIsPopupVisible(true);
        }, 300);

        // Highlight element with brighter yellow
        element.style.position = 'relative';
        element.style.zIndex = '10001';
        element.style.backgroundColor = '#fef08a'; // Changed from #fef9c3 to brighter yellow
        element.style.boxShadow = '0 0 0 4px rgba(234, 179, 8, 0.6)'; // Changed from rgba(250, 204, 21, 0.4) to more opaque and vibrant
        element.style.borderRadius = '8px';
        element.style.transition = 'all 0.3s ease';

        if (step.mode === 'interactive') {
          const handleTargetClick = () => {
            handleNext();
          };
          element.addEventListener('click', handleTargetClick);
          element._tourClickHandler = handleTargetClick;
        }
      } else if (attempts < maxAttempts) {
        attempts++;
        timeoutId = setTimeout(findAndHighlightElement, 100);
      } else {
        setTargetElement(null);
        let centeredLeft = scrollLeft + (viewportWidth - popupWidth) / 2;
        let centeredTop = scrollTop + (viewportHeight - popupHeight) / 2;

        centeredLeft = Math.max(scrollLeft + gap, centeredLeft);
        centeredTop = Math.max(scrollTop + gap, centeredTop);
        centeredLeft = Math.min(scrollLeft + viewportWidth - popupWidth - gap, centeredLeft);
        centeredTop = Math.min(scrollTop + viewportHeight - popupHeight - gap, centeredTop);

        setPosition({
          top: centeredTop,
          left: centeredLeft
        });
        
        setIsPopupVisible(true);
      }
    };

    findAndHighlightElement();

    return () => {
      clearTimeout(timeoutId);
      if (currentHighlightedElement) {
        if (currentHighlightedElement._tourClickHandler) {
          currentHighlightedElement.removeEventListener('click', currentHighlightedElement._tourClickHandler);
          delete currentHighlightedElement._tourClickHandler;
        }

        currentHighlightedElement.style.position = '';
        currentHighlightedElement.style.zIndex = '';
        currentHighlightedElement.style.backgroundColor = '';
        currentHighlightedElement.style.boxShadow = '';
        currentHighlightedElement.style.borderRadius = '';
        currentHighlightedElement.style.transition = '';
      }
    };
  }, [currentStep, isActive, showPopup, steps, mandatoryElementMissing, mandatoryCheckComplete]);

  const handleNext = () => {
    if (currentStep < steps.length - 1) {
      setCurrentStep(currentStep + 1);
    } else {
      handleComplete();
    }
  };

  const handleBack = () => {
    if (currentStep > 0) {
      setCurrentStep(currentStep - 1);
    }
  };

  const handleSkip = () => {
    handleComplete();
  };

  const handleComplete = () => {
    setIsActive(false);
    setShowPopup(false);
    setMandatoryElementMissing(false); // Reset mandatory element missing state
    setMandatoryCheckComplete(false); // Reset mandatory check complete state

    if (dontShowAgain && onDismissPermanently) {
      onDismissPermanently();
    } else if (onComplete) {
      onComplete();
    }
  };

  if (!isActive || !showPopup || !mandatoryCheckComplete || (!mandatoryElementMissing && (currentStep >= steps.length || steps.length === 0))) {
    return null;
  }

  // If mandatory element is missing, show error popup
  if (mandatoryElementMissing) {
    const viewportWidth = window.innerWidth;
    const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
    const scrollLeft = window.pageXOffset || document.documentElement.scrollLeft;
    const popupWidth = 384; // Standard medium size
    const gap = 40;

    // Center horizontally but position at top of viewport
    let centeredLeft = scrollLeft + (viewportWidth - popupWidth) / 2;
    let topPosition = scrollTop + gap; // Position at top with gap padding

    centeredLeft = Math.max(scrollLeft + gap, centeredLeft);
    centeredLeft = Math.min(scrollLeft + viewportWidth - popupWidth - gap, centeredLeft);

    const errorMessage = tourGroup?.mandatory_selector_missing_message || 
                        "Required page elements for this tour are not currently available.";

    return (
      <>
        {showPopup && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[10000] bg-black/20"
            onClick={handleSkip}
          />
        )}

        <AnimatePresence>
          {showPopup && isPopupVisible && ( // Use isPopupVisible for entry/exit animation
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              transition={{ duration: 0.2 }}
              style={{
                position: 'absolute',
                top: `${topPosition}px`,
                left: `${centeredLeft}px`,
                zIndex: 10002,
              }}
              className="w-96"
            >
              <Card className="shadow-2xl border-2 border-red-500 bg-gradient-to-br from-white to-red-50">
                <CardHeader className="pb-4 border-b border-red-100">
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-2">
                      <div className="p-2 bg-red-100 rounded-lg">
                        <AlertCircle className="h-5 w-5 text-red-600" />
                      </div>
                      <CardTitle className="text-xl">Tour Unavailable</CardTitle>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 -mt-1 -mr-2 hover:bg-red-100"
                      onClick={handleSkip}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                </CardHeader>
                <CardContent className="pt-6 space-y-6">
                  <p className="text-base text-slate-700 leading-relaxed">{errorMessage}</p>

                  <div className="flex items-center gap-2 p-3 bg-slate-50 border border-slate-200 rounded-lg">
                    <input
                      type="checkbox"
                      id="dont-show-again"
                      checked={dontShowAgain}
                      onChange={(e) => setDontShowAgain(e.target.checked)}
                      className="h-4 w-4 rounded border-gray-300"
                    />
                    <label htmlFor="dont-show-again" className="text-sm text-slate-700 cursor-pointer">
                      Don't show this tour automatically again
                    </label>
                  </div>

                  <div className="flex justify-end pt-4 border-t border-slate-200">
                    <Button
                      size="sm"
                      onClick={handleComplete}
                      className="bg-red-600 hover:bg-red-700"
                    >
                      Close
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </motion.div>
          )}
        </AnimatePresence>
      </>
    );
  }

  const step = steps[currentStep];
  const isInteractiveMode = step.mode === 'interactive' && step.target_selector;
  const isWelcomeStep = !step.target_selector;
  const isLastStep = currentStep === steps.length - 1;

  const getCardWidth = () => {
    const size = step.size || 'medium';
    const widths = {
      small: 'w-80',
      medium: 'w-96',
      large: 'w-[512px]'
    };
    return widths[size] || 'w-96';
  };

  return (
    <>
      {showPopup && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className={`fixed inset-0 z-[10000] ${isInteractiveMode ? 'bg-black/70' : 'bg-black/20'}`}
          onClick={isInteractiveMode ? undefined : handleSkip}
        />
      )}

      <AnimatePresence>
        {showPopup && isPopupVisible && (
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ duration: 0.2 }}
            style={{
              position: 'absolute',
              top: `${position.top}px`,
              left: `${position.left}px`,
              zIndex: 10002,
            }}
            className={getCardWidth()}
          >
            <Card className="shadow-2xl border-2 border-blue-500 bg-gradient-to-br from-white to-blue-50">
              <CardHeader className="pb-4 border-b border-blue-100">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-2">
                    <div className="p-2 bg-blue-100 rounded-lg">
                      <Sparkles className="h-5 w-5 text-blue-600" />
                    </div>
                    <CardTitle className="text-xl">{step.title}</CardTitle>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 -mt-1 -mr-2 hover:bg-red-100"
                    onClick={handleSkip}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="pt-6 space-y-6">
                <p className="text-base text-slate-700 leading-relaxed">{step.content}</p>

                {(isWelcomeStep || isLastStep) && (
                  <div className="flex items-center gap-2 p-3 bg-slate-50 border border-slate-200 rounded-lg">
                    <input
                      type="checkbox"
                      id="dont-show-again"
                      checked={dontShowAgain}
                      onChange={(e) => setDontShowAgain(e.target.checked)}
                      className="h-4 w-4 rounded border-gray-300"
                    />
                    <label htmlFor="dont-show-again" className="text-sm text-slate-700 cursor-pointer">
                      Don't show this tour automatically again
                    </label>
                  </div>
                )}

                <div className="flex items-center justify-between pt-4 border-t border-slate-200">
                  <div className="flex-shrink-0">
                    {currentStep > 0 ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleBack}
                        className="text-slate-600"
                      >
                        <ChevronLeft className="w-4 h-4 mr-1" />
                        Back
                      </Button>
                    ) : (
                      <div className="w-20" />
                    )}
                  </div>

                  <div className="flex flex-col items-center gap-2 flex-shrink-0">
                    <span className="text-sm font-medium text-slate-600">
                      Step {currentStep + 1} of {steps.length}
                    </span>
                    <div className="flex gap-1">
                      {steps.map((_, index) => (
                        <div
                          key={index}
                          className={`h-2 w-2 rounded-full transition-colors ${
                            index === currentStep ? 'bg-blue-600' : 'bg-slate-300'
                          }`}
                        />
                      ))}
                    </div>
                  </div>

                  <div className="flex-shrink-0">
                    {!isInteractiveMode ? (
                      <Button
                        size="sm"
                        onClick={handleNext}
                        className="bg-blue-600 hover:bg-blue-700"
                      >
                        {isLastStep ? (
                          <>
                            Finish
                            <ChevronRight className="w-4 h-4 ml-1" />
                          </>
                        ) : (
                          <>
                            Next
                            <ChevronRight className="w-4 h-4 ml-1" />
                          </>
                        )}
                      </Button>
                    ) : (
                      // This div acts as a placeholder to maintain symmetrical spacing
                      // when the "Next" button is not present in interactive mode.
                      <div className="w-20" />
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
