-- Drop base44_id columns and indexes from all tables
-- Run this script in your Supabase SQL Editor to clean up legacy Base44 migration columns
-- Generated: January 2026

-- Organization
DROP INDEX IF EXISTS idx_organization_base44_id;
ALTER TABLE organization DROP COLUMN IF EXISTS base44_id;

-- Event
DROP INDEX IF EXISTS idx_event_base44_id;
ALTER TABLE event DROP COLUMN IF EXISTS base44_id;

-- Booking
DROP INDEX IF EXISTS idx_booking_base44_id;
ALTER TABLE booking DROP COLUMN IF EXISTS base44_id;

-- Program Ticket Transaction
DROP INDEX IF EXISTS idx_program_ticket_transaction_base44_id;
ALTER TABLE program_ticket_transaction DROP COLUMN IF EXISTS base44_id;

-- Magic Link
DROP INDEX IF EXISTS idx_magic_link_base44_id;
ALTER TABLE magic_link DROP COLUMN IF EXISTS base44_id;

-- Organization Contact
DROP INDEX IF EXISTS idx_organization_contact_base44_id;
ALTER TABLE organization_contact DROP COLUMN IF EXISTS base44_id;

-- Program
DROP INDEX IF EXISTS idx_program_base44_id;
ALTER TABLE program DROP COLUMN IF EXISTS base44_id;

-- Blog Post
DROP INDEX IF EXISTS idx_blog_post_base44_id;
ALTER TABLE blog_post DROP COLUMN IF EXISTS base44_id;

-- Team Member
DROP INDEX IF EXISTS idx_team_member_base44_id;
ALTER TABLE team_member DROP COLUMN IF EXISTS base44_id;

-- Discount Code
DROP INDEX IF EXISTS idx_discount_code_base44_id;
ALTER TABLE discount_code DROP COLUMN IF EXISTS base44_id;

-- System Settings
DROP INDEX IF EXISTS idx_system_settings_base44_id;
ALTER TABLE system_settings DROP COLUMN IF EXISTS base44_id;

-- Resource
DROP INDEX IF EXISTS idx_resource_base44_id;
ALTER TABLE resource DROP COLUMN IF EXISTS base44_id;

-- Resource Category
DROP INDEX IF EXISTS idx_resource_category_base44_id;
ALTER TABLE resource_category DROP COLUMN IF EXISTS base44_id;

-- File Repository
DROP INDEX IF EXISTS idx_file_repository_base44_id;
ALTER TABLE file_repository DROP COLUMN IF EXISTS base44_id;

-- File Repository Folder
DROP INDEX IF EXISTS idx_file_repository_folder_base44_id;
ALTER TABLE file_repository_folder DROP COLUMN IF EXISTS base44_id;

-- Job Posting
DROP INDEX IF EXISTS idx_job_posting_base44_id;
ALTER TABLE job_posting DROP COLUMN IF EXISTS base44_id;

-- Page Banner
DROP INDEX IF EXISTS idx_page_banner_base44_id;
ALTER TABLE page_banner DROP COLUMN IF EXISTS base44_id;

-- IEdit Page
DROP INDEX IF EXISTS idx_iedit_page_base44_id;
ALTER TABLE iedit_page DROP COLUMN IF EXISTS base44_id;

-- IEdit Page Element
DROP INDEX IF EXISTS idx_iedit_page_element_base44_id;
ALTER TABLE iedit_page_element DROP COLUMN IF EXISTS base44_id;

-- IEdit Element Template
DROP INDEX IF EXISTS idx_iedit_element_template_base44_id;
ALTER TABLE iedit_element_template DROP COLUMN IF EXISTS base44_id;

-- Navigation Item
DROP INDEX IF EXISTS idx_navigation_item_base44_id;
ALTER TABLE navigation_item DROP COLUMN IF EXISTS base44_id;

-- Article Comment
DROP INDEX IF EXISTS idx_article_comment_base44_id;
ALTER TABLE article_comment DROP COLUMN IF EXISTS base44_id;

-- Comment Reaction
DROP INDEX IF EXISTS idx_comment_reaction_base44_id;
ALTER TABLE comment_reaction DROP COLUMN IF EXISTS base44_id;

-- Article Reaction
DROP INDEX IF EXISTS idx_article_reaction_base44_id;
ALTER TABLE article_reaction DROP COLUMN IF EXISTS base44_id;

-- Article View
DROP INDEX IF EXISTS idx_article_view_base44_id;
ALTER TABLE article_view DROP COLUMN IF EXISTS base44_id;

-- Button Style
DROP INDEX IF EXISTS idx_button_style_base44_id;
ALTER TABLE button_style DROP COLUMN IF EXISTS base44_id;

-- Award
DROP INDEX IF EXISTS idx_award_base44_id;
ALTER TABLE award DROP COLUMN IF EXISTS base44_id;

-- Offline Award
DROP INDEX IF EXISTS idx_offline_award_base44_id;
ALTER TABLE offline_award DROP COLUMN IF EXISTS base44_id;

-- Offline Award Assignment
DROP INDEX IF EXISTS idx_offline_award_assignment_base44_id;
ALTER TABLE offline_award_assignment DROP COLUMN IF EXISTS base44_id;

-- Wall of Fame Section
DROP INDEX IF EXISTS idx_wall_of_fame_section_base44_id;
ALTER TABLE wall_of_fame_section DROP COLUMN IF EXISTS base44_id;

-- Wall of Fame Category
DROP INDEX IF EXISTS idx_wall_of_fame_category_base44_id;
ALTER TABLE wall_of_fame_category DROP COLUMN IF EXISTS base44_id;

-- Wall of Fame Person
DROP INDEX IF EXISTS idx_wall_of_fame_person_base44_id;
ALTER TABLE wall_of_fame_person DROP COLUMN IF EXISTS base44_id;

-- Floater
DROP INDEX IF EXISTS idx_floater_base44_id;
ALTER TABLE floater DROP COLUMN IF EXISTS base44_id;

-- Form
DROP INDEX IF EXISTS idx_form_base44_id;
ALTER TABLE form DROP COLUMN IF EXISTS base44_id;

-- Form Submission
DROP INDEX IF EXISTS idx_form_submission_base44_id;
ALTER TABLE form_submission DROP COLUMN IF EXISTS base44_id;

-- Tour Group
DROP INDEX IF EXISTS idx_tour_group_base44_id;
ALTER TABLE tour_group DROP COLUMN IF EXISTS base44_id;

-- Tour Step
DROP INDEX IF EXISTS idx_tour_step_base44_id;
ALTER TABLE tour_step DROP COLUMN IF EXISTS base44_id;

-- News Post
DROP INDEX IF EXISTS idx_news_post_base44_id;
ALTER TABLE news_post DROP COLUMN IF EXISTS base44_id;

-- Resource Author Settings
DROP INDEX IF EXISTS idx_resource_author_settings_base44_id;
ALTER TABLE resource_author_settings DROP COLUMN IF EXISTS base44_id;

-- Zoho Token
DROP INDEX IF EXISTS idx_zoho_token_base44_id;
ALTER TABLE zoho_token DROP COLUMN IF EXISTS base44_id;

-- Xero Token
DROP INDEX IF EXISTS idx_xero_token_base44_id;
ALTER TABLE xero_token DROP COLUMN IF EXISTS base44_id;

-- Portal Menu
DROP INDEX IF EXISTS idx_portal_menu_base44_id;
ALTER TABLE portal_menu DROP COLUMN IF EXISTS base44_id;

-- Article Category
DROP INDEX IF EXISTS idx_article_category_base44_id;
ALTER TABLE article_category DROP COLUMN IF EXISTS base44_id;

-- Portal Navigation Item
DROP INDEX IF EXISTS idx_portal_navigation_item_base44_id;
ALTER TABLE portal_navigation_item DROP COLUMN IF EXISTS base44_id;

-- Member Group
DROP INDEX IF EXISTS idx_member_group_base44_id;
ALTER TABLE member_group DROP COLUMN IF EXISTS base44_id;

-- Member Group Assignment
DROP INDEX IF EXISTS idx_member_group_assignment_base44_id;
ALTER TABLE member_group_assignment DROP COLUMN IF EXISTS base44_id;

-- Guest Writer
DROP INDEX IF EXISTS idx_guest_writer_base44_id;
ALTER TABLE guest_writer DROP COLUMN IF EXISTS base44_id;

-- Award Classification
DROP INDEX IF EXISTS idx_award_classification_base44_id;
ALTER TABLE award_classification DROP COLUMN IF EXISTS base44_id;

-- Award Sublevel
DROP INDEX IF EXISTS idx_award_sublevel_base44_id;
ALTER TABLE award_sublevel DROP COLUMN IF EXISTS base44_id;

-- Member Group Guest
DROP INDEX IF EXISTS idx_member_group_guest_base44_id;
ALTER TABLE member_group_guest DROP COLUMN IF EXISTS base44_id;

-- Discount Code Usage
DROP INDEX IF EXISTS idx_discount_code_usage_base44_id;
ALTER TABLE discount_code_usage DROP COLUMN IF EXISTS base44_id;

-- Resource Folder
DROP INDEX IF EXISTS idx_resource_folder_base44_id;
ALTER TABLE resource_folder DROP COLUMN IF EXISTS base44_id;

-- Support Ticket
DROP INDEX IF EXISTS idx_support_ticket_base44_id;
ALTER TABLE support_ticket DROP COLUMN IF EXISTS base44_id;

-- Support Ticket Response
DROP INDEX IF EXISTS idx_support_ticket_response_base44_id;
ALTER TABLE support_ticket_response DROP COLUMN IF EXISTS base44_id;

-- Voucher
DROP INDEX IF EXISTS idx_voucher_base44_id;
ALTER TABLE voucher DROP COLUMN IF EXISTS base44_id;

-- Member (if it has base44_id)
DROP INDEX IF EXISTS idx_member_base44_id;
ALTER TABLE member DROP COLUMN IF EXISTS base44_id;

-- Role (if it has base44_id)
DROP INDEX IF EXISTS idx_role_base44_id;
ALTER TABLE role DROP COLUMN IF EXISTS base44_id;

-- Done!
SELECT 'base44_id columns dropped successfully!' as result;
