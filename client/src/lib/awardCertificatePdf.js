export async function validatedPdf(response) {
  if (!response.ok || response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/pdf') throw new Error('The server did not return a PDF. Nothing was downloaded.');
  const blob = await response.blob();
  if (!blob.size || !new TextDecoder().decode(await blob.slice(0, 1024).arrayBuffer()).includes('%PDF-')) throw new Error('The returned PDF is empty or invalid.');
  return blob;
}
export function downloadCertificate(blob, name = 'award-certificate.pdf') {
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = name.replace(/[\\/\0\r\n]/g, '_'); link.referrerPolicy = 'no-referrer';
  document.body.appendChild(link);
  try { link.click(); } finally { link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000); }
}
