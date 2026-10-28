import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import DOMPurify from 'dompurify';
import { ReadOnlyBlockPreview } from '../components/email-builder/BlockRenderer';
import { campaignPdfDesign, campaignPdfHtml } from './campaignPdfSlots';
import { canDownloadCampaignPdf, campaignPdfFilename } from './campaignPdfEligibility';

const TIMEOUT = 20000;
async function bounded(promise, message) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), TIMEOUT);
    })]);
  } finally { clearTimeout(timer); }
}

export async function downloadCampaignPdf(id) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  let campaign;
  try {
    const response = await fetch(`/api/email-campaigns/${encodeURIComponent(id)}`, { credentials: 'include', signal: controller.signal });
    if (!response.ok) throw new Error('Unable to read this campaign. Refresh the page and try again.');
    campaign = await response.json();
  } finally { clearTimeout(timer); }
  if (!canDownloadCampaignPdf(campaign)) throw new Error('Sending has not begun for this campaign. Refresh the campaign list.');
  return exportCampaignPdf(campaign);
}

export async function exportCampaignPdf(campaign) {
  const design = campaignPdfDesign(campaign.design_json);
  // Generic preview semantics only: never resolve a recipient or linked template.
  const markup = design
    ? renderToStaticMarkup(<ReadOnlyBlockPreview blocks={design.blocks} globalStyles={design.globalStyles} />)
    : campaignPdfHtml(campaign);
  if (!markup) throw new Error('This campaign has no saved email content to export.');
  const html = DOMPurify.sanitize(markup, {
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'video', 'audio'],
    FORBID_ATTR: ['srcset'],
  });
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.setAttribute('sandbox', 'allow-same-origin');
  frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:800px;height:1000px;border:0;pointer-events:none';
  document.body.append(frame);
  try {
    const doc = frame.contentDocument;
    doc.open();
    doc.write('<!doctype html><html><head></head><body></body></html>');
    doc.close();
    // Only trusted application styles, never email-authored stylesheets.
    for (const node of document.querySelectorAll('style,link[rel="stylesheet"]')) doc.head.append(node.cloneNode(true));
    const style = doc.createElement('style');
    style.textContent = 'html,body{margin:0;background:white;color:#222;font:16px Arial,sans-serif} img{max-width:100%} h1,h2,h3,h4,h5,h6{line-height:1.5!important;margin-bottom:.35em!important}';
    doc.head.append(style);
    const surface = doc.createElement('div');
    surface.style.cssText = `width:800px;padding:24px;box-sizing:border-box;background:${design?.globalStyles?.backgroundColor || '#fff'}`;
    surface.innerHTML = html;
    doc.body.append(surface);
    if (!surface.textContent.trim() && !surface.querySelector('img')) throw new Error('The saved email contains no printable content.');
    await bounded(Promise.all([...doc.querySelectorAll('link[rel="stylesheet"]')].map(link => link.sheet ? Promise.resolve() : new Promise((resolve, reject) => {
      link.onload = resolve; link.onerror = () => reject(new Error('Email styles could not load. Please retry.'));
    }))), 'Email styles timed out. Please retry.');
    await bounded(doc.fonts.ready, 'Email fonts timed out. Please retry.');
    if ([...doc.fonts].some(font => font.status === 'error')) throw new Error('An email font failed to load. Check font hosting and retry.');
    // Preflight every image (including CSS backgrounds) with CORS; html2canvas
    // otherwise silently omits images it cannot read. Convert to data URLs.
    const images = new Map();
    const loadImage = url => {
      if (!images.has(url)) images.set(url, bounded(new Promise((resolve, reject) => {
        const image = new Image();
        image.crossOrigin = 'anonymous';
        image.onload = () => {
          try {
            const canvas = document.createElement('canvas');
            canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
            canvas.getContext('2d').drawImage(image, 0, 0);
            resolve(canvas.toDataURL('image/png'));
          } catch { reject(new Error('An email image blocks PDF access. Use an image host that allows cross-origin access, then retry.')); }
        };
        image.onerror = () => reject(new Error('An email image could not load or blocks cross-origin access. Check the image URL/hosting and retry.'));
        image.src = url;
      }), 'An email image timed out. Check image hosting and retry.'));
      return images.get(url);
    };
    await Promise.all([...surface.querySelectorAll('img')].map(async image => {
      image.src = await loadImage(image.src);
      await bounded(image.decode(), 'An email image could not be decoded. Please retry.');
    }));
    await Promise.all([surface, ...surface.querySelectorAll('*')].map(async element => {
      const background = frame.contentWindow.getComputedStyle(element).backgroundImage;
      const urls = [...background.matchAll(/url\(["']?(.*?)["']?\)/g)];
      let next = background;
      for (const match of urls) next = next.replace(match[0], `url("${await loadImage(match[1])}")`);
      if (urls.length) element.style.backgroundImage = next;
    }));
    const [{ jsPDF }, { default: html2canvas }] = await Promise.all([import('jspdf'), import('html2canvas')]);
    const width = Math.max(800, surface.scrollWidth);
    const height = surface.scrollHeight;
    if (!height || width > 2400 || height > 100000) throw new Error('This email is too large to render safely. Try a shorter email.');
    const pdf = new jsPDF({ unit: 'mm', format: 'a4', compress: true });
    pdf.setProperties({ title: campaign.subject || campaign.name || 'Campaign email', subject: 'Generic saved campaign preview, not a recipient delivery archive' });
    const scale = 186 / width;
    const pageHeight = Math.floor(273 / scale);
    // Avoid splitting text lines at page boundaries; oversized images are sliced
    // continuously, with every source pixel included exactly once.
    const lines = [];
    const walker = doc.createTreeWalker(surface, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      if (!walker.currentNode.textContent.trim()) continue;
      const range = doc.createRange();
      range.selectNodeContents(walker.currentNode);
      const parentStyle = frame.contentWindow.getComputedStyle(walker.currentNode.parentElement);
      if (parentStyle.visibility === 'hidden' || parentStyle.opacity === '0') continue;
      for (const rect of range.getClientRects()) if (rect.width && rect.height) lines.push({ top: rect.top, bottom: rect.bottom });
    }
    const visibleImages = [...surface.querySelectorAll('img')].some(image => {
      const rect = image.getBoundingClientRect();
      const style = frame.contentWindow.getComputedStyle(image);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.opacity !== '0';
    });
    if (!lines.length && !visibleImages) throw new Error('The saved email has no visible printable content. No PDF was downloaded.');
    const links = [...surface.querySelectorAll('a[href]')].filter(a => /^(https?:|mailto:|tel:)/i.test(a.getAttribute('href')))
      .flatMap(a => [...a.getClientRects()].map(rect => ({ rect, href: a.href })));
    for (let y = 0, page = 0; y < height; page++) {
      let end = Math.min(height, y + pageHeight);
      for (let attempt = 0; attempt < 100; attempt++) {
        const crossing = lines.filter(line => line.top < end && line.bottom > end && line.top > y);
        if (!crossing.length) break;
        end = Math.floor(Math.min(...crossing.map(line => line.top)));
      }
      if (end <= y + pageHeight / 2 && end < height) end = Math.min(height, y + pageHeight);
      const canvas = await html2canvas(surface, { width, height: end - y, y, scale: 2, backgroundColor: '#ffffff', logging: false, useCORS: true, windowWidth: 800 });
      if (!canvas.width || !canvas.height) throw new Error('Email rendering failed. No PDF was downloaded. Please retry.');
      if (page) pdf.addPage();
      pdf.addImage(canvas.toDataURL('image/png'), 'PNG', 12, 12, 186, (end - y) * scale);
      for (const { rect, href } of links) {
        const top = Math.max(y, rect.top), bottom = Math.min(end, rect.bottom);
        if (bottom > top) pdf.link(12 + rect.left * scale, 12 + (top - y) * scale, rect.width * scale, (bottom - top) * scale, { url: href });
      }
      canvas.width = canvas.height = 0;
      y = end;
    }
    await pdf.save(campaignPdfFilename(campaign), { returnPromise: true });
  } finally { frame.remove(); }
}
