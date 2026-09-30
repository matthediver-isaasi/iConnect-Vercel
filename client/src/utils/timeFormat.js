import { format, parseISO } from "date-fns";
import { formatInTimeZone } from "date-fns-tz";

const DEFAULT_TIMEZONE = 'Europe/London';

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
 * Get timezone abbreviation (e.g., GMT, BST, EST, PST)
 * @param {Date|string} date - Date object or ISO string
 * @param {string} timezone - IANA timezone string
 * @returns {string} - Timezone abbreviation
 */
export const getTimezoneAbbreviation = (date, timezone = null) => {
  const tz = timezone || DEFAULT_TIMEZONE;
  try {
    const dateObj = typeof date === 'string' ? parseISO(date) : date;
    return formatInTimeZone(dateObj, tz, "zzz");
  } catch {
    return "";
  }
};

/**
 * Format a date/time for display, respecting the 12/24 hour setting and timezone
 * @param {Date|string} date - Date object or ISO string (UTC)
 * @param {Array} systemSettings - Array of system settings objects
 * @param {string} timezone - IANA timezone string (e.g., 'Europe/London')
 * @param {boolean} showTimezone - Whether to append timezone abbreviation
 * @returns {string|null} - Formatted time string or null if no date
 */
export const formatEventTime = (date, systemSettings = [], timezone = null, showTimezone = false) => {
  if (!date) return null;
  try {
    const dateObj = typeof date === 'string' ? parseISO(date) : date;
    const use24Hour = is24HourFormat(systemSettings);
    const tz = timezone || DEFAULT_TIMEZONE;
    const timeStr = formatInTimeZone(dateObj, tz, use24Hour ? "HH:mm" : "h:mm a");
    if (showTimezone) {
      const tzAbbr = formatInTimeZone(dateObj, tz, "zzz");
      return `${timeStr} ${tzAbbr}`;
    }
    return timeStr;
  } catch (e) {
    console.error('Error formatting time:', e);
    try {
      return format(new Date(date), "h:mm a");
    } catch {
      return null;
    }
  }
};

/**
 * Format a date for display in the specified timezone
 * @param {Date|string} date - Date object or ISO string (UTC)
 * @param {string} formatStr - date-fns format string
 * @param {string} timezone - IANA timezone string (e.g., 'Europe/London')
 * @returns {string|null} - Formatted date string or null if no date
 */
export const formatEventDate = (date, formatStr = "MMM d, yyyy", timezone = null) => {
  if (!date) return null;
  try {
    const dateObj = typeof date === 'string' ? parseISO(date) : date;
    const tz = timezone || DEFAULT_TIMEZONE;
    return formatInTimeZone(dateObj, tz, formatStr);
  } catch (e) {
    console.error('Error formatting date:', e);
    try {
      return format(new Date(date), formatStr);
    } catch {
      return null;
    }
  }
};

/**
 * Format a date and time together for display in the specified timezone
 * @param {Date|string} date - Date object or ISO string (UTC)
 * @param {Array} systemSettings - Array of system settings objects
 * @param {string} timezone - IANA timezone string (e.g., 'Europe/London')
 * @param {boolean} showTimezone - Whether to append timezone abbreviation
 * @returns {string} - Formatted date and time string
 */
export const formatEventDateTime = (date, systemSettings = [], timezone = null, showTimezone = false) => {
  if (!date) return '';
  try {
    const dateObj = typeof date === 'string' ? parseISO(date) : date;
    const use24Hour = is24HourFormat(systemSettings);
    const tz = timezone || DEFAULT_TIMEZONE;
    const dateTimeStr = formatInTimeZone(dateObj, tz, use24Hour ? "MMM d, yyyy 'at' HH:mm" : "MMM d, yyyy 'at' h:mm a");
    if (showTimezone) {
      const tzAbbr = formatInTimeZone(dateObj, tz, "zzz");
      return `${dateTimeStr} ${tzAbbr}`;
    }
    return dateTimeStr;
  } catch (e) {
    console.error('Error formatting datetime:', e);
    return '';
  }
};

/**
 * Format a time range with timezone (e.g., "10:00 AM - 11:30 AM GMT")
 * @param {Date|string} startDate - Start date/time
 * @param {Date|string} endDate - End date/time
 * @param {Array} systemSettings - Array of system settings objects
 * @param {string} timezone - IANA timezone string
 * @param {boolean} showTimezone - Whether to append timezone abbreviation at the end
 * @returns {string} - Formatted time range string
 */
export const formatEventTimeRange = (startDate, endDate, systemSettings = [], timezone = null, showTimezone = false) => {
  if (!startDate) return '';
  try {
    const tz = timezone || DEFAULT_TIMEZONE;
    const startStr = formatEventTime(startDate, systemSettings, tz, false);
    const endStr = endDate ? formatEventTime(endDate, systemSettings, tz, false) : null;
    
    let rangeStr = endStr ? `${startStr} - ${endStr}` : startStr;
    
    if (showTimezone) {
      const dateObj = typeof startDate === 'string' ? parseISO(startDate) : startDate;
      const tzAbbr = formatInTimeZone(dateObj, tz, "zzz");
      return `${rangeStr} ${tzAbbr}`;
    }
    return rangeStr;
  } catch (e) {
    console.error('Error formatting time range:', e);
    return '';
  }
};
