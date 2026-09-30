-- Add optional ticker expiry date to news_post.
-- After this timestamp the article is no longer eligible for the news ticker.
ALTER TABLE news_post ADD COLUMN IF NOT EXISTS ticker_expiry_date timestamptz;
