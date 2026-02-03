import { format, parseISO } from "date-fns";

/**
 * Check if 24-hour format is enabled from system settings
 * @param {Array} systemSettings - Array of system settings objects
 * @returns {boolean} - True if 24-hour format is enabled
 */
export const is24HourFormat = (systemSettings) => {
  if (!systemSettings?.length) return false;
  const timeFormatSetting = systemSettings.find(s => s.setting_key === 'event_time_format_24h');
  return timeFormatSetting?.setting_value === 'true';
};

/**
 * Format a date/time for display, respecting the 12/24 hour setting
 * No timezone conversion - displays time as stored
 * @param {Date|string} date - Date object or ISO string
 * @param {Array} systemSettings - Array of system settings objects
 * @returns {string|null} - Formatted time string or null if no date
 */
export const formatEventTime = (date, systemSettings = []) => {
  if (!date) return null;
  try {
    const dateObj = typeof date === 'string' ? parseISO(date) : date;
    const use24Hour = is24HourFormat(systemSettings);
    return format(dateObj, use24Hour ? "HH:mm" : "h:mm a");
  } catch (e) {
    console.error('Error formatting time:', e);
    return format(new Date(date), "h:mm a");
  }
};

/**
 * Format a date for display, no timezone conversion
 * @param {Date|string} date - Date object or ISO string
 * @param {string} formatStr - date-fns format string
 * @returns {string|null} - Formatted date string or null if no date
 */
export const formatEventDate = (date, formatStr = "MMM d, yyyy") => {
  if (!date) return null;
  try {
    const dateObj = typeof date === 'string' ? parseISO(date) : date;
    return format(dateObj, formatStr);
  } catch (e) {
    console.error('Error formatting date:', e);
    return format(new Date(date), formatStr);
  }
};

/**
 * Format a date and time together for display
 * @param {Date|string} date - Date object or ISO string
 * @param {Array} systemSettings - Array of system settings objects
 * @returns {string} - Formatted date and time string
 */
export const formatEventDateTime = (date, systemSettings = []) => {
  if (!date) return '';
  try {
    const dateObj = typeof date === 'string' ? parseISO(date) : date;
    const use24Hour = is24HourFormat(systemSettings);
    return format(dateObj, use24Hour ? "MMM d, yyyy 'at' HH:mm" : "MMM d, yyyy 'at' h:mm a");
  } catch (e) {
    console.error('Error formatting datetime:', e);
    return '';
  }
};
