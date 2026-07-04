import { isFieldValueFilled } from '@/lib/formFieldPrefill';

// Shared multi-page form navigation + per-page validation logic.
// Used by both the standalone FormView page and the embedded Canvas form block
// (IEditFormElement) so the two render paths behave identically.
//
// This is a plain function (not a hook) so it can be called safely at any point
// in a component body, including after conditional early returns. Callers own
// their own state (currentPageIndex/setCurrentPageIndex), refs and the
// filterVisibleFields helper, and pass them in.
export function getFormPagination({
  form,
  formValues,
  hiddenPageIds,
  currentPageIndex,
  setCurrentPageIndex,
  filterVisibleFields,
  formContainerRef,
  toast,
}) {
  const pages = form?.pages || [];
  const visiblePages = pages.filter(p => !hiddenPageIds.has(p.id));
  const hasPages = visiblePages.length > 0 && form?.layout_type === 'standard';

  // Fields for the current page (or all fields when the form is not paginated).
  // Unassigned fields (no page_id) are shown on the first page for backwards
  // compatibility.
  const getCurrentPageFields = () => {
    if (!hasPages) {
      return form?.fields || [];
    }
    const currentPage = visiblePages[currentPageIndex];
    if (currentPageIndex === 0) {
      return (form?.fields || []).filter(f => f.page_id === currentPage?.id || !f.page_id);
    }
    return (form?.fields || []).filter(f => f.page_id === currentPage?.id);
  };

  // Validate the visible required fields + character/word limits on the current
  // page before allowing navigation to the next page.
  const validateCurrentPage = () => {
    const pageFields = filterVisibleFields(getCurrentPageFields());
    const missingFields = pageFields.filter(field =>
      field.required && !isFieldValueFilled(field, formValues[field.id])
    );
    if (missingFields.length > 0) {
      toast.error(`Please fill in required fields: ${missingFields.map(f => f.label).join(', ')}`);
      return false;
    }

    const overLimitFields = pageFields.filter(field => {
      if (field.type !== 'textarea' || !field.max_characters) return false;
      const text = formValues[field.id] || '';
      if (field.limit_type === 'words') {
        const wordCount = text.trim() === '' ? 0 : text.trim().split(/\s+/).length;
        return wordCount > field.max_characters;
      }
      return text.length > field.max_characters;
    });
    if (overLimitFields.length > 0) {
      toast.error(`${overLimitFields[0]?.limit_type === 'words' ? 'Word' : 'Character'} limit exceeded: ${overLimitFields.map(f => f.label).join(', ')}`);
      return false;
    }

    return true;
  };

  const scrollToForm = () => {
    if (formContainerRef?.current) {
      const header = document.querySelector('header');
      const headerHeight = header ? header.getBoundingClientRect().height : 0;
      const targetTop = formContainerRef.current.getBoundingClientRect().top + window.scrollY - headerHeight;
      window.scrollTo({ top: targetTop, behavior: 'smooth' });
    } else {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  const goToNextPage = () => {
    if (validateCurrentPage()) {
      setCurrentPageIndex(prev => Math.min(prev + 1, visiblePages.length - 1));
      scrollToForm();
    }
  };

  const goToPreviousPage = () => {
    setCurrentPageIndex(prev => Math.max(prev - 1, 0));
    scrollToForm();
  };

  const isFirstPage = currentPageIndex === 0;
  const isLastPage = !hasPages || currentPageIndex === visiblePages.length - 1;
  const currentPage = hasPages ? visiblePages[currentPageIndex] : null;
  const displayFields = filterVisibleFields(getCurrentPageFields());

  return {
    pages,
    visiblePages,
    hasPages,
    getCurrentPageFields,
    validateCurrentPage,
    scrollToForm,
    goToNextPage,
    goToPreviousPage,
    isFirstPage,
    isLastPage,
    currentPage,
    displayFields,
  };
}
