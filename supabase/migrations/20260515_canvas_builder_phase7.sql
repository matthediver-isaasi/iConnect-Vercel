-- Canvas Builder Phase 7 — Templates, symbols, media library, version history, tenant theming.
--
-- All new tables are tenant-scoped (except canvas_template which allows a
-- NULL tenant_id for global starter templates). Foreign keys cascade so a
-- tenant deletion cleans everything up automatically.

CREATE TABLE IF NOT EXISTS canvas_template (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID REFERENCES tenant(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  category TEXT,
  preview_image_url TEXT,
  design JSONB NOT NULL,
  is_starter BOOLEAN NOT NULL DEFAULT false,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_canvas_template_tenant ON canvas_template(tenant_id);
COMMENT ON TABLE canvas_template IS 'Canvas Builder page templates. tenant_id NULL = global starter template.';

CREATE TABLE IF NOT EXISTS canvas_symbol (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  design JSONB NOT NULL,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_canvas_symbol_tenant ON canvas_symbol(tenant_id);
COMMENT ON TABLE canvas_symbol IS 'Canvas Builder reusable section symbols, tenant-scoped.';

CREATE TABLE IF NOT EXISTS media_asset (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'image',
  mime_type TEXT,
  byte_size BIGINT,
  alt_text TEXT,
  width INTEGER,
  height INTEGER,
  uploaded_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_media_asset_tenant ON media_asset(tenant_id);
CREATE INDEX IF NOT EXISTS idx_media_asset_tenant_url ON media_asset(tenant_id, url);
COMMENT ON TABLE media_asset IS 'Canvas Builder / media library asset registry with alt text and metadata.';

CREATE TABLE IF NOT EXISTS canvas_page_version (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id UUID NOT NULL REFERENCES i_edit_page(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  design JSONB NOT NULL,
  label TEXT,
  source TEXT NOT NULL DEFAULT 'publish',
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_canvas_page_version_page ON canvas_page_version(page_id, created_at DESC);
COMMENT ON TABLE canvas_page_version IS 'Canvas page snapshots taken on publish or manual save; supports rollback.';

CREATE TABLE IF NOT EXISTS tenant_canvas_theme (
  tenant_id UUID PRIMARY KEY REFERENCES tenant(id) ON DELETE CASCADE,
  theme JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE tenant_canvas_theme IS 'Per-tenant Canvas Builder design tokens (colours, typography, spacing).';

-- Phase 7 — Starter template library (global, tenant_id NULL). These rows
-- seed the page-template picker shown on canvas page creation so every
-- new tenant has a baseline of professionally-structured starting points
-- without having to author one from scratch. Inserts are idempotent on
-- the (tenant_id IS NULL, name) pair via the helper guard below.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM canvas_template WHERE tenant_id IS NULL AND name = 'Landing page') THEN
    INSERT INTO canvas_template (tenant_id, name, description, category, is_starter, design) VALUES
    (NULL, 'Landing page', 'Hero, value props, CTA — drop-in marketing homepage.', 'landing', true, jsonb_build_object(
      'version', 1,
      'root', jsonb_build_object('background', null, 'sections', jsonb_build_array(jsonb_build_object(
        'id', 'root-section',
        'children', jsonb_build_array(
          jsonb_build_object('id','tpl-landing-hero','type','hero','name','Hero','locked',false,
            'style', jsonb_build_object('background','var(--cb-color-primary, #0f172a)','borderWidth',0),
            'a11y', jsonb_build_object(),
            'content', jsonb_build_object('headline','Welcome to our community','headingLevel',1,'subheadline','Membership, events, and resources in one place.','bgType','color','bgColor','var(--cb-color-primary, #0f172a)','darkWash',0.4,'alignment','center','textColor','var(--cb-color-on-primary, #ffffff)','ctas', jsonb_build_array(jsonb_build_object('label','Become a member','href','#','variant','primary'))),
            'bp', jsonb_build_object('desktop', jsonb_build_object('x',0,'y',0,'w',1200,'h',420,'hidden',false), 'tablet', jsonb_build_object(), 'mobile', jsonb_build_object())),
          jsonb_build_object('id','tpl-landing-cards','type','columns','name','Value props','locked',false,
            'style', jsonb_build_object('background','transparent','borderWidth',0),
            'a11y', jsonb_build_object(),
            'content', jsonb_build_object('count',3,'gap',16,'stackOnMobile',true,'widths', jsonb_build_object('desktop', jsonb_build_array(33,33,34),'tablet', jsonb_build_array(50,50,100),'mobile', jsonb_build_array(100,100,100)),'items', jsonb_build_array(
              jsonb_build_object('html','<h3>Join us</h3><p>Become a member and connect.</p>'),
              jsonb_build_object('html','<h3>Attend events</h3><p>RSVP to upcoming sessions.</p>'),
              jsonb_build_object('html','<h3>Find resources</h3><p>Library, guides, and downloads.</p>'))),
            'bp', jsonb_build_object('desktop', jsonb_build_object('x',0,'y',440,'w',1200,'h',240,'hidden',false), 'tablet', jsonb_build_object(), 'mobile', jsonb_build_object()))
        )
      )))
    ));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM canvas_template WHERE tenant_id IS NULL AND name = 'About us') THEN
    INSERT INTO canvas_template (tenant_id, name, description, category, is_starter, design) VALUES
    (NULL, 'About us', 'Mission, team, story — narrative page for new visitors.', 'about', true, jsonb_build_object(
      'version', 1,
      'root', jsonb_build_object('background', null, 'sections', jsonb_build_array(jsonb_build_object(
        'id','root-section','children', jsonb_build_array(
          jsonb_build_object('id','tpl-about-hero','type','hero','name','About hero','locked',false,
            'style', jsonb_build_object('background','var(--cb-color-primary, #0f172a)','borderWidth',0),
            'a11y', jsonb_build_object(),
            'content', jsonb_build_object('headline','About us','headingLevel',1,'subheadline','Our story, mission, and the people behind it.','bgType','color','bgColor','var(--cb-color-primary, #0f172a)','darkWash',0.4,'alignment','left','textColor','var(--cb-color-on-primary, #ffffff)','ctas', jsonb_build_array()),
            'bp', jsonb_build_object('desktop', jsonb_build_object('x',0,'y',0,'w',1200,'h',320,'hidden',false), 'tablet', jsonb_build_object(), 'mobile', jsonb_build_object())),
          jsonb_build_object('id','tpl-about-text','type','text','name','Mission','locked',false,
            'style', jsonb_build_object('background','transparent','borderWidth',0),
            'a11y', jsonb_build_object(),
            'content', jsonb_build_object('html','<h2>Our mission</h2><p>Write a short paragraph about who you are and why you exist.</p>','colorRole','default'),
            'bp', jsonb_build_object('desktop', jsonb_build_object('x',40,'y',360,'w',720,'h',200,'hidden',false), 'tablet', jsonb_build_object(), 'mobile', jsonb_build_object()))
        )
      )))
    ));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM canvas_template WHERE tenant_id IS NULL AND name = 'Events landing') THEN
    INSERT INTO canvas_template (tenant_id, name, description, category, is_starter, design) VALUES
    (NULL, 'Events landing', 'Upcoming events grid with intro hero.', 'events', true, jsonb_build_object(
      'version', 1,
      'root', jsonb_build_object('background', null, 'sections', jsonb_build_array(jsonb_build_object(
        'id','root-section','children', jsonb_build_array(
          jsonb_build_object('id','tpl-events-hero','type','hero','name','Events hero','locked',false,
            'style', jsonb_build_object('background','var(--cb-color-primary, #0f172a)','borderWidth',0),
            'a11y', jsonb_build_object(),
            'content', jsonb_build_object('headline','Upcoming events','headingLevel',1,'subheadline','What is on this season.','bgType','color','bgColor','var(--cb-color-primary, #0f172a)','darkWash',0.4,'alignment','center','textColor','var(--cb-color-on-primary, #ffffff)','ctas', jsonb_build_array()),
            'bp', jsonb_build_object('desktop', jsonb_build_object('x',0,'y',0,'w',1200,'h',280,'hidden',false), 'tablet', jsonb_build_object(), 'mobile', jsonb_build_object())),
          jsonb_build_object('id','tpl-events-list','type','event-list','name','Event list','locked',false,
            'style', jsonb_build_object('background','transparent','borderWidth',0),
            'a11y', jsonb_build_object(),
            'content', jsonb_build_object('title','Coming up','headingLevel',2,'limit',6,'filter','upcoming','featuredOnly',false,'sortBy','start-asc','columns', jsonb_build_object('desktop',3,'tablet',2,'mobile',1),'gap',16,'ctaLabel','View details','emptyText','No upcoming events to show yet.'),
            'bp', jsonb_build_object('desktop', jsonb_build_object('x',0,'y',300,'w',1200,'h',520,'hidden',false), 'tablet', jsonb_build_object(), 'mobile', jsonb_build_object()))
        )
      )))
    ));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM canvas_template WHERE tenant_id IS NULL AND name = 'Fundraising campaign') THEN
    INSERT INTO canvas_template (tenant_id, name, description, category, is_starter, design) VALUES
    (NULL, 'Fundraising campaign', 'Campaign progress and donate CTA.', 'fundraising', true, jsonb_build_object(
      'version', 1,
      'root', jsonb_build_object('background', null, 'sections', jsonb_build_array(jsonb_build_object(
        'id','root-section','children', jsonb_build_array(
          jsonb_build_object('id','tpl-fund-hero','type','hero','name','Campaign hero','locked',false,
            'style', jsonb_build_object('background','var(--cb-color-primary, #0f172a)','borderWidth',0),
            'a11y', jsonb_build_object(),
            'content', jsonb_build_object('headline','Help us reach our goal','headingLevel',1,'subheadline','Every donation makes a difference.','bgType','color','bgColor','var(--cb-color-primary, #0f172a)','darkWash',0.4,'alignment','center','textColor','var(--cb-color-on-primary, #ffffff)','ctas', jsonb_build_array(jsonb_build_object('label','Donate now','href','#','variant','primary'))),
            'bp', jsonb_build_object('desktop', jsonb_build_object('x',0,'y',0,'w',1200,'h',360,'hidden',false), 'tablet', jsonb_build_object(), 'mobile', jsonb_build_object())),
          jsonb_build_object('id','tpl-fund-embed','type','campaign-embed','name','Campaign embed','locked',false,
            'style', jsonb_build_object('background','var(--cb-color-surface, #ffffff)','borderWidth',1,'borderRadius',8),
            'a11y', jsonb_build_object(),
            'content', jsonb_build_object('campaignSlug','','showProgress',true,'showImage',true,'ctaLabel','Donate now'),
            'bp', jsonb_build_object('desktop', jsonb_build_object('x',40,'y',400,'w',560,'h',380,'hidden',false), 'tablet', jsonb_build_object(), 'mobile', jsonb_build_object()))
        )
      )))
    ));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM canvas_template WHERE tenant_id IS NULL AND name = 'Contact us') THEN
    INSERT INTO canvas_template (tenant_id, name, description, category, is_starter, design) VALUES
    (NULL, 'Contact us', 'Intro plus embedded contact form.', 'contact', true, jsonb_build_object(
      'version', 1,
      'root', jsonb_build_object('background', null, 'sections', jsonb_build_array(jsonb_build_object(
        'id','root-section','children', jsonb_build_array(
          jsonb_build_object('id','tpl-contact-text','type','text','name','Intro','locked',false,
            'style', jsonb_build_object('background','transparent','borderWidth',0),
            'a11y', jsonb_build_object(),
            'content', jsonb_build_object('html','<h1>Get in touch</h1><p>We would love to hear from you. Drop us a message below.</p>','colorRole','default'),
            'bp', jsonb_build_object('desktop', jsonb_build_object('x',40,'y',40,'w',720,'h',160,'hidden',false), 'tablet', jsonb_build_object(), 'mobile', jsonb_build_object())),
          jsonb_build_object('id','tpl-contact-form','type','form-embed','name','Contact form','locked',false,
            'style', jsonb_build_object('background','transparent','borderWidth',0),
            'a11y', jsonb_build_object(),
            'content', jsonb_build_object('formSlug','contact','mode','inline','title','','ctaLabel','Send'),
            'bp', jsonb_build_object('desktop', jsonb_build_object('x',40,'y',220,'w',640,'h',480,'hidden',false), 'tablet', jsonb_build_object(), 'mobile', jsonb_build_object()))
        )
      )))
    ));
  END IF;
END $$;
