import { useQuery } from "@tanstack/react-query";
import { publicClient } from "@/api/publicClient";
import { format } from "date-fns";

const DATE_FORMAT_OPTIONS = [
  { value: 'dd/MM/yyyy', label: 'DD/MM/YYYY (31/12/2024)' },
  { value: 'MM/dd/yyyy', label: 'MM/DD/YYYY (12/31/2024)' },
  { value: 'yyyy-MM-dd', label: 'YYYY-MM-DD (2024-12-31)' },
  { value: 'dd MMM yyyy', label: 'DD Mon YYYY (31 Dec 2024)' },
  { value: 'MMM dd, yyyy', label: 'Mon DD, YYYY (Dec 31, 2024)' },
  { value: 'MMMM dd, yyyy', label: 'Month DD, YYYY (December 31, 2024)' },
  { value: 'dd MMMM yyyy', label: 'DD Month YYYY (31 December 2024)' },
];

const DEFAULT_DATE_FORMAT = 'dd MMM yyyy';

export function useDateFormat() {
  const { data: systemSettings = [] } = useQuery({
    queryKey: ['public-system-settings-date-format'],
    queryFn: () => publicClient.listSystemSettings(),
    staleTime: 60000,
  });

  const dateFormatSetting = systemSettings.find(s => s.setting_key === 'date_display_format');
  const dateFormat = dateFormatSetting?.setting_value || DEFAULT_DATE_FORMAT;

  const formatDate = (dateValue) => {
    if (!dateValue) return '-';
    try {
      const date = new Date(dateValue);
      if (isNaN(date.getTime())) return '-';
      return format(date, dateFormat);
    } catch {
      return '-';
    }
  };

  return {
    dateFormat,
    formatDate,
    DATE_FORMAT_OPTIONS,
    DEFAULT_DATE_FORMAT
  };
}

export { DATE_FORMAT_OPTIONS, DEFAULT_DATE_FORMAT };
