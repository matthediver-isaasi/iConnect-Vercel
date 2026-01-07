-- Drop base44_id columns and indexes from all tables (safe version)
-- This script skips tables that don't exist
-- Run this script in your Supabase SQL Editor
-- Generated: January 2026

DO $$ 
BEGIN
  -- Organization
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'organization') THEN
    DROP INDEX IF EXISTS idx_organization_base44_id;
    ALTER TABLE organization DROP COLUMN IF EXISTS base44_id;
  END IF;

  -- Event
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'event') THEN
    DROP INDEX IF EXISTS idx_event_base44_id;
    ALTER TABLE event DROP COLUMN IF EXISTS base44_id;
  END IF;

  -- Booking
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'booking') THEN
    DROP INDEX IF EXISTS idx_booking_base44_id;
    ALTER TABLE booking DROP COLUMN IF EXISTS base44_id;
  END IF;

  -- Program Ticket Transaction
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'program_ticket_transaction') THEN
    DROP INDEX IF EXISTS idx_program_ticket_transaction_base44_id;
    ALTER TABLE program_ticket_transaction DROP COLUMN IF EXISTS base44_id;
  END IF;

  -- Magic Link
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'magic_link') THEN
    DROP INDEX IF EXISTS idx_magic_link_base44_id;
    ALTER TABLE magic_link DROP COLUMN IF EXISTS base44_id;
  END IF;

  -- Organization Contact
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'organization_contact') THEN
    DROP INDEX IF EXISTS idx_organization_contact_base44_id;
    ALTER TABLE organization_contact DROP COLUMN IF EXISTS base44_id;
  END IF;

  -- Program
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'program') THEN
    DROP INDEX IF EXISTS idx_program_base44_id;
    ALTER TABLE program DROP COLUMN IF EXISTS base44_id;
  END IF;

  -- Blog Post
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'blog_post') THEN
    DROP INDEX IF EXISTS idx_blog_post_base44_id;
    ALTER TABLE blog_post DROP COLUMN IF EXISTS base44_id;
  END IF;

  -- Team Member
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'team_member') THEN
    DROP INDEX IF EXISTS idx_team_member_base44_id;
    ALTER TABLE team_member DROP COLUMN IF EXISTS base44_id;
  END IF;

  -- Discount Code
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'discount_code') THEN
    DROP INDEX IF EXISTS idx_discount_code_base44_id;
    ALTER TABLE discount_code DROP COLUMN IF EXISTS base44_id;
  END IF;

  -- System Settings
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'system_settings') THEN
    DROP INDEX IF EXISTS idx_system_settings_base44_id;
    ALTER TABLE system_settings DROP COLUMN IF EXISTS base44_id;
  END IF;

  -- Resource
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'resource') THEN
    DROP INDEX IF EXISTS idx_resource_base44_id;
    ALTER TABLE resource DROP COLUMN IF EXISTS base44_id;
  END IF;

  -- Resource Category
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'resource_category') THEN
    DROP INDEX IF EXISTS idx_resource_category_base44_id;
    ALTER TABLE resource_category DROP COLUMN IF EXISTS base44_id;
  END IF;

  -- File Repository
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'file_repository') THEN
    DROP INDEX IF EXISTS idx_file_repository_base44_id;
    ALTER TABLE file_repository DROP COLUMN IF EXISTS base44_id;
  END IF;

  -- File Repository Folder
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'file_repository_folder') THEN
    DROP INDEX IF EXISTS idx_file_repository_folder_base44_id;
    ALTER TABLE file_repository_folder DROP COLUMN IF EXISTS base44_id;
  END IF;

  -- Job Posting
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'job_posting') THEN
    DROP INDEX IF EXISTS idx_job_posting_base44_id;
    ALTER TABLE job_posting DROP COLUMN IF EXISTS base44_id;
  END IF;

  -- Page Banner
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'page_banner') THEN
    DROP INDEX IF EXISTS idx_page_banner_base44_id;
    ALTER TABLE page_banner DROP COLUMN IF EXISTS base44_id;
  END IF;

  -- IEdit Page
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'iedit_page') THEN
    DROP INDEX IF EXISTS idx_iedit_page_base44_id;
    ALTER TABLE iedit_page DROP COLUMN IF EXISTS base44_id;
  END IF;

  -- IEdit Page Element
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'iedit_page_element') THEN
    DROP INDEX IF EXISTS idx_iedit_page_element_base44_id;
    ALTER TABLE iedit_page_element DROP COLUMN IF EXISTS base44_id;
  END IF;

  -- IEdit Element Template
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'iedit_element_template') THEN
    DROP INDEX IF EXISTS idx_iedit_element_template_base44_id;
    ALTER TABLE iedit_element_template DROP COLUMN IF EXISTS base44_id;
  END IF;

  -- Navigation Item
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'navigation_item') THEN
    DROP INDEX IF EXISTS idx_navigation_item_base44_id;
    ALTER TABLE navigation_item DROP COLUMN IF EXISTS base44_id;
  END IF;

  -- Article Comment
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'article_comment') THEN
    DROP INDEX IF EXISTS idx_article_comment_base44_id;
    ALTER TABLE article_comment DROP COLUMN IF EXISTS base44_id;
  END IF;

  -- Comment Reaction
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'comment_reaction') THEN
    DROP INDEX IF EXISTS idx_comment_reaction_base44_id;
    ALTER TABLE comment_reaction DROP COLUMN IF EXISTS base44_id;
  END IF;

  -- Article Reaction
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'article_reaction') THEN
    DROP INDEX IF EXISTS idx_article_reaction_base44_id;
    ALTER TABLE article_reaction DROP COLUMN IF EXISTS base44_id;
  END IF;

  -- Article View
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'article_view') THEN
    DROP INDEX IF EXISTS idx_article_view_base44_id;
    ALTER TABLE article_view DROP COLUMN IF EXISTS base44_id;
  END IF;

  -- Button Style
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'button_style') THEN
    DROP INDEX IF EXISTS idx_button_style_base44_id;
    ALTER TABLE button_style DROP COLUMN IF EXISTS base44_id;
  END IF;

  -- Award
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'award') THEN
    DROP INDEX IF EXISTS idx_award_base44_id;
    ALTER TABLE award DROP COLUMN IF EXISTS base44_id;
  END IF;

  -- Offline Award
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'offline_award') THEN
    DROP INDEX IF EXISTS idx_offline_award_base44_id;
    ALTER TABLE offline_award DROP COLUMN IF EXISTS base44_id;
  END IF;

  -- Offline Award Assignment
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'offline_award_assignment') THEN
    DROP INDEX IF EXISTS idx_offline_award_assignment_base44_id;
    ALTER TABLE offline_award_assignment DROP COLUMN IF EXISTS base44_id;
  END IF;

  -- Wall of Fame Section
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'wall_of_fame_section') THEN
    DROP INDEX IF EXISTS idx_wall_of_fame_section_base44_id;
    ALTER TABLE wall_of_fame_section DROP COLUMN IF EXISTS base44_id;
  END IF;

  -- Wall of Fame Category
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'wall_of_fame_category') THEN
    DROP INDEX IF EXISTS idx_wall_of_fame_category_base44_id;
    ALTER TABLE wall_of_fame_category DROP COLUMN IF EXISTS base44_id;
  END IF;

  -- Wall of Fame Person
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'wall_of_fame_person') THEN
    DROP INDEX IF EXISTS idx_wall_of_fame_person_base44_id;
    ALTER TABLE wall_of_fame_person DROP COLUMN IF EXISTS base44_id;
  END IF;

  -- Floater
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'floater') THEN
    DROP INDEX IF EXISTS idx_floater_base44_id;
    ALTER TABLE floater DROP COLUMN IF EXISTS base44_id;
  END IF;

  -- Form
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'form') THEN
    DROP INDEX IF EXISTS idx_form_base44_id;
    ALTER TABLE form DROP COLUMN IF EXISTS base44_id;
  END IF;

  -- Form Submission
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'form_submission') THEN
    DROP INDEX IF EXISTS idx_form_submission_base44_id;
    ALTER TABLE form_submission DROP COLUMN IF EXISTS base44_id;
  END IF;

  -- Tour Group
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'tour_group') THEN
    DROP INDEX IF EXISTS idx_tour_group_base44_id;
    ALTER TABLE tour_group DROP COLUMN IF EXISTS base44_id;
  END IF;

  -- Tour Step
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'tour_step') THEN
    DROP INDEX IF EXISTS idx_tour_step_base44_id;
    ALTER TABLE tour_step DROP COLUMN IF EXISTS base44_id;
  END IF;

  -- News Post
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'news_post') THEN
    DROP INDEX IF EXISTS idx_news_post_base44_id;
    ALTER TABLE news_post DROP COLUMN IF EXISTS base44_id;
  END IF;

  -- Resource Author Settings
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'resource_author_settings') THEN
    DROP INDEX IF EXISTS idx_resource_author_settings_base44_id;
    ALTER TABLE resource_author_settings DROP COLUMN IF EXISTS base44_id;
  END IF;

  -- Zoho Token (drop the entire table since it's no longer used)
  DROP TABLE IF EXISTS zoho_token;

  -- Xero Token
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'xero_token') THEN
    DROP INDEX IF EXISTS idx_xero_token_base44_id;
    ALTER TABLE xero_token DROP COLUMN IF EXISTS base44_id;
  END IF;

  -- Portal Menu
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'portal_menu') THEN
    DROP INDEX IF EXISTS idx_portal_menu_base44_id;
    ALTER TABLE portal_menu DROP COLUMN IF EXISTS base44_id;
  END IF;

  -- Article Category
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'article_category') THEN
    DROP INDEX IF EXISTS idx_article_category_base44_id;
    ALTER TABLE article_category DROP COLUMN IF EXISTS base44_id;
  END IF;

  -- Portal Navigation Item
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'portal_navigation_item') THEN
    DROP INDEX IF EXISTS idx_portal_navigation_item_base44_id;
    ALTER TABLE portal_navigation_item DROP COLUMN IF EXISTS base44_id;
  END IF;

  -- Member Group
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'member_group') THEN
    DROP INDEX IF EXISTS idx_member_group_base44_id;
    ALTER TABLE member_group DROP COLUMN IF EXISTS base44_id;
  END IF;

  -- Member Group Assignment
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'member_group_assignment') THEN
    DROP INDEX IF EXISTS idx_member_group_assignment_base44_id;
    ALTER TABLE member_group_assignment DROP COLUMN IF EXISTS base44_id;
  END IF;

  -- Guest Writer
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'guest_writer') THEN
    DROP INDEX IF EXISTS idx_guest_writer_base44_id;
    ALTER TABLE guest_writer DROP COLUMN IF EXISTS base44_id;
  END IF;

  -- Award Classification
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'award_classification') THEN
    DROP INDEX IF EXISTS idx_award_classification_base44_id;
    ALTER TABLE award_classification DROP COLUMN IF EXISTS base44_id;
  END IF;

  -- Award Sublevel
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'award_sublevel') THEN
    DROP INDEX IF EXISTS idx_award_sublevel_base44_id;
    ALTER TABLE award_sublevel DROP COLUMN IF EXISTS base44_id;
  END IF;

  -- Member Group Guest
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'member_group_guest') THEN
    DROP INDEX IF EXISTS idx_member_group_guest_base44_id;
    ALTER TABLE member_group_guest DROP COLUMN IF EXISTS base44_id;
  END IF;

  -- Discount Code Usage
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'discount_code_usage') THEN
    DROP INDEX IF EXISTS idx_discount_code_usage_base44_id;
    ALTER TABLE discount_code_usage DROP COLUMN IF EXISTS base44_id;
  END IF;

  -- Resource Folder
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'resource_folder') THEN
    DROP INDEX IF EXISTS idx_resource_folder_base44_id;
    ALTER TABLE resource_folder DROP COLUMN IF EXISTS base44_id;
  END IF;

  -- Support Ticket
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'support_ticket') THEN
    DROP INDEX IF EXISTS idx_support_ticket_base44_id;
    ALTER TABLE support_ticket DROP COLUMN IF EXISTS base44_id;
  END IF;

  -- Support Ticket Response
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'support_ticket_response') THEN
    DROP INDEX IF EXISTS idx_support_ticket_response_base44_id;
    ALTER TABLE support_ticket_response DROP COLUMN IF EXISTS base44_id;
  END IF;

  -- Voucher
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'voucher') THEN
    DROP INDEX IF EXISTS idx_voucher_base44_id;
    ALTER TABLE voucher DROP COLUMN IF EXISTS base44_id;
  END IF;

  -- Member
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'member') THEN
    DROP INDEX IF EXISTS idx_member_base44_id;
    ALTER TABLE member DROP COLUMN IF EXISTS base44_id;
  END IF;

  -- Role
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'role') THEN
    DROP INDEX IF EXISTS idx_role_base44_id;
    ALTER TABLE role DROP COLUMN IF EXISTS base44_id;
  END IF;

  RAISE NOTICE 'base44_id columns dropped successfully!';
END $$;
