import { useQuery, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";

const TAG_COLOR_PALETTE = [
  "#ef4444",
  "#f97316",
  "#f59e0b",
  "#84cc16",
  "#22c55e",
  "#14b8a6",
  "#06b6d4",
  "#3b82f6",
  "#6366f1",
  "#8b5cf6",
  "#d946ef",
  "#ec4899",
];

function getContrastTextColor(hexColor) {
  if (!hexColor) return undefined;
  const hex = hexColor.replace("#", "");
  const r = parseInt(hex.substring(0, 2), 16);
  const g = parseInt(hex.substring(2, 4), 16);
  const b = parseInt(hex.substring(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.55 ? "#000000" : "#ffffff";
}

function useTagColors(entityType) {
  const queryClient = useQueryClient();

  const { data: tagColors = [] } = useQuery({
    queryKey: ["crm-tag-colors", entityType],
    queryFn: async () => {
      const results = await base44.entities.CrmTagColor.list({
        filter: { entity_type: entityType },
      });
      return results || [];
    },
    staleTime: 2 * 60 * 1000,
  });

  const colorMap = {};
  tagColors.forEach((tc) => {
    colorMap[tc.tag_name] = tc.color;
  });

  const getTagColor = (tagName) => colorMap[tagName] || null;

  const getTagStyle = (tagName) => {
    const color = getTagColor(tagName);
    if (!color) return {};
    return {
      backgroundColor: color,
      color: getContrastTextColor(color),
      borderColor: color,
    };
  };

  const setTagColor = async (tagName, color) => {
    const existing = tagColors.find((tc) => tc.tag_name === tagName);
    if (existing) {
      await base44.entities.CrmTagColor.update(existing.id, { color });
    } else {
      await base44.entities.CrmTagColor.create({
        entity_type: entityType,
        tag_name: tagName,
        color,
      });
    }
    queryClient.invalidateQueries({ queryKey: ["crm-tag-colors", entityType] });
  };

  const removeTagColor = async (tagName) => {
    const existing = tagColors.find((tc) => tc.tag_name === tagName);
    if (existing) {
      await base44.entities.CrmTagColor.delete(existing.id);
      queryClient.invalidateQueries({
        queryKey: ["crm-tag-colors", entityType],
      });
    }
  };

  const renameTagColor = async (oldName, newName) => {
    const existingOld = tagColors.find((tc) => tc.tag_name === oldName);
    const existingNew = tagColors.find((tc) => tc.tag_name === newName);
    if (existingOld && existingNew) {
      await base44.entities.CrmTagColor.delete(existingOld.id);
    } else if (existingOld) {
      await base44.entities.CrmTagColor.update(existingOld.id, {
        tag_name: newName,
      });
    }
    queryClient.invalidateQueries({
      queryKey: ["crm-tag-colors", entityType],
    });
  };

  return {
    tagColors,
    colorMap,
    getTagColor,
    getTagStyle,
    setTagColor,
    removeTagColor,
    renameTagColor,
    TAG_COLOR_PALETTE,
  };
}

export { useTagColors, TAG_COLOR_PALETTE, getContrastTextColor };
