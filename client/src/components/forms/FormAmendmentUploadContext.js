import { createContext, useContext } from 'react';

// Present only inside FormView's isolated evidence-only branch: verified
// member ownership or a separate in-memory external applicant grant.
// Standard form upload behavior is unchanged when this context is absent.
export const FormAmendmentUploadContext = createContext(null);
export const useFormAmendmentUpload = () => useContext(FormAmendmentUploadContext);
