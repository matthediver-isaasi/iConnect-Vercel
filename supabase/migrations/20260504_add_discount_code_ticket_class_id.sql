ALTER TABLE discount_code
ADD COLUMN IF NOT EXISTS ticket_class_id UUID REFERENCES complex_event_ticket_class(id) ON DELETE SET NULL;
