export async function apiRequest(method, url, data) {
  const options = {
    method,
    credentials: 'include',
    headers: {}
  };
  
  if (data) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(data);
  }
  
  const response = await fetch(url, options);
  
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error || `Request failed with status ${response.status}`);
  }
  
  return response.json();
}
