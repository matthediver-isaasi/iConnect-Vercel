// Deliberately consumes only the schedule's already-filtered inputs. Never fetch
// sessions, tracks or speakers here, and never serialize whole API records.
const MARGIN = 32;
const LINE_HEIGHT = 13;
const namesFor = session => session.track_names || (session.track_name ? [session.track_name] : []);
const text = value => typeof value === "string" || typeof value === "number"
  ? String(value).replace(/[\u0000-\u001f]/g, " ").trim() : "";

function dateLabel(value, timezone, options) {
  if (!value || Number.isNaN(new Date(value).getTime())) return "";
  return new Intl.DateTimeFormat("en-GB", { timeZone: timezone, ...options }).format(new Date(value));
}

export function buildSchedulePdfModel({
  event = {}, sessions = [], eventTracks = [], trackColorMap = {}, speakerMap = {}, timezone,
}) {
  const zone = timezone || event.timezone || "Europe/London";
  // Validate up front rather than silently using the browser's timezone.
  new Intl.DateTimeFormat("en-GB", { timeZone: zone }).format();
  const allowed = new Set(Object.keys(trackColorMap));
  const used = new Set(sessions.flatMap(namesFor).filter(name => allowed.has(name)));
  const ordered = [...new Set([
    ...eventTracks.map(track => track.name).filter(name => used.has(name)),
    ...used,
  ])];
  const tracks = ordered.map(name => ({ name, key: name, color: trackColorMap[name]?.accent }));
  if (sessions.some(session => namesFor(session).length === 0)) {
    tracks.push({ key: null, name: "General", color: "#64748b" });
  }
  const days = new Map();
  const sorted = [...sessions].sort((a, b) =>
    (Date.parse(a.start_time) || Infinity) - (Date.parse(b.start_time) || Infinity));
  for (const session of sorted) {
    const visibleKeys = namesFor(session).filter(name => allowed.has(name));
    if (namesFor(session).length && !visibleKeys.length) continue;
    const dayKey = dateLabel(session.start_time, zone, { year: "numeric", month: "2-digit", day: "2-digit" });
    const label = dateLabel(session.start_time, zone, { weekday: "long", day: "numeric", month: "long", year: "numeric" }) || "Date to be confirmed";
    if (!days.has(dayKey)) days.set(dayKey, { label, sessions: [] });
    const resolvedSpeakers = (session.speaker_ids || []).map(id => speakerMap[id]).filter(Boolean)
      .map(speaker => text(speaker.full_name || speaker.name)).filter(Boolean);
    const speakers = resolvedSpeakers.length ? resolvedSpeakers : (session.speaker_names || []).map(text).filter(Boolean);
    const start = dateLabel(session.start_time, zone, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    const endValue = session.end_time || (start && Number(session.duration_minutes) > 0
      ? new Date(Date.parse(session.start_time) + Number(session.duration_minutes) * 60000) : null);
    const end = dateLabel(endValue, zone, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    const endDay = dateLabel(endValue, zone, { year: "numeric", month: "2-digit", day: "2-digit" });
    const time = start ? `${start}${end ? ` - ${end}${endDay !== dayKey ? " (next day)" : ""}` : ""}` : "Time to be confirmed";
    days.get(dayKey).sessions.push({
      title: text(session.title) || "Untitled session",
      time,
      speakers: speakers.join(", "),
      trackKeys: namesFor(session).length ? [...new Set(visibleKeys)] : [null],
    });
  }
  const dateOptions = { day: "numeric", month: "long", year: "numeric" };
  const startDate = dateLabel(event.start_date, zone, dateOptions);
  const endDate = dateLabel(event.end_date, zone, dateOptions);
  return {
    title: text(event.title) || "Event programme",
    date: startDate ? `${startDate}${endDate && endDate !== startDate ? ` - ${endDate}` : ""}` : "Dates to be confirmed",
    location: text(event.location) || "Location to be confirmed",
    timezone: zone, tracks, days: [...days.values()],
  };
}

// Image decoding (including SVG) stays in the browser's inert image context;
// never insert tenant-controlled SVG markup into the document or jsPDF.
export function rasterizeScheduleLogo(source, { ImageClass = globalThis.Image, documentObject = globalThis.document } = {}) {
  if (!source) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    let image;
    let timer;
    const fail = () => {
      clearTimeout(timer);
      if (image) { image.onload = null; image.onerror = null; }
      reject(new Error("The tenant logo could not be included. Check the image and its cross-origin permissions, then retry."));
    };
    try {
      const url = new URL(source, documentObject.baseURI);
      if (!["https:", "http:", "blob:"].includes(url.protocol) && !/^data:image\/(?:png|jpeg|webp|gif|svg\+xml)[;,]/i.test(source)) {
        fail(); return;
      }
      image = new ImageClass();
      image.crossOrigin = "anonymous";
      image.onload = () => {
        try {
          if (!image.naturalWidth || !image.naturalHeight) { fail(); return; }
          const scale = Math.min(1, 1200 / Math.max(image.naturalWidth, image.naturalHeight));
          const canvas = documentObject.createElement("canvas");
          canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
          canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
          const context = canvas.getContext("2d");
          if (!context) { fail(); return; }
          context.drawImage(image, 0, 0, canvas.width, canvas.height);
          const data = canvas.toDataURL("image/png");
          clearTimeout(timer);
          image.onload = null;
          image.onerror = null;
          resolve({ data, width: canvas.width, height: canvas.height });
        } catch { fail(); }
      };
      image.onerror = fail;
      timer = setTimeout(fail, 15000);
      image.src = url.href;
    } catch { fail(); }
  });
}

// A flowing agenda per column, not a screenshot of the scroll viewport. Long
// content continues onto another page, including within a single session.
export function renderSchedulePdf(doc, model, logo = null) {
  const width = doc.internal.pageSize.getWidth();
  const height = doc.internal.pageSize.getHeight();
  const bottom = height - 40;
  let page = 1;
  doc.setLineHeightFactor(1.3);
  doc.setFont("helvetica", "normal");
  const footer = () => {
    doc.setFontSize(9);
    doc.setTextColor("#64748b");
    doc.text(`Programme | ${model.timezone} | Page ${page}`, MARGIN, height - 20);
  };
  const nextPage = () => { footer(); doc.addPage(); page++; };
  const wrap = (value, maxWidth, size = 10) => {
    doc.setFontSize(size);
    return doc.splitTextToSize(value, maxWidth);
  };
  let y = MARGIN;
  if (logo) {
    const scale = Math.min(150 / logo.width, 48 / logo.height);
    doc.addImage(logo.data, "PNG", MARGIN, y, logo.width * scale, logo.height * scale);
    y += 64;
  }
  // Allow even unusually long event metadata to flow without clipping.
  for (const [value, size] of [[model.title, 20], [model.date, 11], [model.location, 11], [`Timezone: ${model.timezone}`, 11]]) {
    const lineHeight = size * 1.4;
    for (const line of wrap(value, width - 2 * MARGIN, size)) {
      if (y + lineHeight > bottom) { nextPage(); y = MARGIN; }
      doc.setFontSize(size);
      doc.setTextColor("#0f172a");
      doc.text(line, MARGIN, y + size);
      y += lineHeight;
    }
    y += 10;
  }
  if (!model.days.length) {
    if (y + 20 > bottom) { nextPage(); y = MARGIN; }
    doc.setFontSize(11);
    doc.text("No sessions in this schedule.", MARGIN, y + 15);
  }
  for (const day of model.days) {
    // Four columns at A4 landscape keep a minimum ~180pt readable width.
    for (let offset = 0; offset < model.tracks.length; offset += 4) {
      const tracks = model.tracks.slice(offset, offset + 4);
      const gap = 14;
      const colWidth = (width - 2 * MARGIN - gap * (tracks.length - 1)) / tracks.length;
      const columns = tracks.map(track => {
        const lines = wrap(track.name, colWidth).map(value => ({ value, kind: "track" }));
        for (const session of day.sessions.filter(item => item.trackKeys.includes(track.key))) {
          lines.push({ value: "", kind: "space" });
          for (const [value, kind] of [[session.time, "time"], [session.title, "title"], [session.speakers && `Speakers: ${session.speakers}`, "speaker"]]) {
            if (value) lines.push(...wrap(value, colWidth).map(part => ({ value: part, kind })));
          }
        }
        return lines;
      });
      let continuation = false;
      do {
        // Use the overview's remaining space on the first sheet only if useful.
        if (continuation || y + 150 > bottom) { nextPage(); y = MARGIN; }
        doc.setFontSize(12);
        doc.setTextColor("#0f172a");
        doc.text(day.label, MARGIN, y + 12);
        doc.setFontSize(9);
        doc.text(`Tracks ${offset + 1}-${offset + tracks.length} of ${model.tracks.length}${continuation ? " | continued" : ""}`, MARGIN, y + 28);
        const top = y + 62;
        const capacity = Math.floor((bottom - top) / LINE_HEIGHT);
        tracks.forEach((track, index) => {
          const x = MARGIN + index * (colWidth + gap);
          doc.setDrawColor(/^#[0-9a-f]{6}$/i.test(track.color) ? track.color : "#64748b");
          doc.setLineWidth(2);
          doc.line(x, top - 23, x + colWidth, top - 23);
          doc.setFontSize(9);
          doc.setTextColor("#64748b");
          doc.text(`Track ${offset + index + 1}${continuation ? " (continued)" : ""}`, x, top - 9);
          columns[index].splice(0, capacity).forEach((line, lineIndex) => {
            doc.setFontSize(10);
            doc.setTextColor(line.kind === "time" || line.kind === "speaker" ? "#475569" : "#0f172a");
            if (line.value) doc.text(line.value, x, top + lineIndex * LINE_HEIGHT);
          });
        });
        continuation = columns.some(column => column.length > 0);
        y = bottom; // next day / track batch starts on a new page
      } while (continuation);
    }
  }
  footer();
  return doc;
}

export async function downloadSchedulePdf(inputs, logoUrl) {
  const model = buildSchedulePdfModel(inputs);
  const [{ jsPDF }, logo] = await Promise.all([import("jspdf"), rasterizeScheduleLogo(logoUrl)]);
  const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });
  renderSchedulePdf(doc, model, logo);
  const filename = model.title.normalize("NFKD").replace(/[^a-z0-9 -]/gi, "").trim().replace(/\s+/g, "-").slice(0, 90) || "event";
  await doc.save(`${filename}-programme.pdf`, { returnPromise: true });
}
