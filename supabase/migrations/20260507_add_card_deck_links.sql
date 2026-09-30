-- task-737: Add up to 10 link rows per Card Deck card.
-- Stores an ordered array of { text, url } objects. Cap of 10 is enforced
-- in client-side and server-side application logic.
ALTER TABLE card_deck ADD COLUMN IF NOT EXISTS links jsonb NOT NULL DEFAULT '[]'::jsonb;
COMMENT ON COLUMN card_deck.links IS 'Ordered array of { text, url } link rows shown below the card description (max 10).';
