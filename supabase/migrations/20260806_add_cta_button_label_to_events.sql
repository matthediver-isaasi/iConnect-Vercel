-- Per-event CTA button label override (blank/null = tenant default from Event Settings)
ALTER TABLE event ADD COLUMN IF NOT EXISTS cta_button_label TEXT;
ALTER TABLE complex_event ADD COLUMN IF NOT EXISTS cta_button_label TEXT;
