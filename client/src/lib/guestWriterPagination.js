export function normalizeGuestWriterPage(response) {
  if (!response || !Array.isArray(response.data) || !Number.isInteger(response.count) || response.count < 0) {
    throw new Error('Guest writer search returned an invalid paginated response.');
  }

  return {
    data: response.data,
    count: response.count,
  };
}

export function getGuestWriterPageCount(total, pageSize) {
  return Math.max(1, Math.ceil(total / pageSize));
}

export function getGuestWriterRange(page, pageSize, total) {
  if (total === 0) return { start: 0, end: 0 };
  const start = (page - 1) * pageSize + 1;
  return {
    start,
    end: Math.min(page * pageSize, total),
  };
}