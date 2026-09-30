-- Add focal point column to news_post and blog_post tables
-- Stores { x: number, y: number } as percentage coordinates (0-100)
-- Used to control object-position when displaying cropped feature images

ALTER TABLE news_post ADD COLUMN IF NOT EXISTS feature_image_focal_point jsonb DEFAULT NULL;
ALTER TABLE blog_post ADD COLUMN IF NOT EXISTS feature_image_focal_point jsonb DEFAULT NULL;
