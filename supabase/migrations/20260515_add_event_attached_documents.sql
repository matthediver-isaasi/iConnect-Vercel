-- task-877: Add public "Documents" section to single events and complex events.
-- Admins upload public files (programmes, agendas, info packs, etc.) with a
-- configurable section title. PDFs open in an in-page modal viewer; other
-- files open in a new tab.

ALTER TABLE event ADD COLUMN IF NOT EXISTS attached_documents jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE event ADD COLUMN IF NOT EXISTS documents_section_title text;
COMMENT ON COLUMN event.attached_documents IS 'Array of public document objects {id, label, url, file_name, mime_type, size} rendered on the public event page.';
COMMENT ON COLUMN event.documents_section_title IS 'Heading shown above the public documents list (e.g. "Programmes"). Falls back to "Documents" when blank.';

ALTER TABLE complex_event ADD COLUMN IF NOT EXISTS attached_documents jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE complex_event ADD COLUMN IF NOT EXISTS documents_section_title text;
COMMENT ON COLUMN complex_event.attached_documents IS 'Array of public document objects {id, label, url, file_name, mime_type, size} rendered on the public complex event page.';
COMMENT ON COLUMN complex_event.documents_section_title IS 'Heading shown above the public documents list (e.g. "Programmes"). Falls back to "Documents" when blank.';
