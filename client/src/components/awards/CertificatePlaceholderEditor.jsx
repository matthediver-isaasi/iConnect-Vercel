import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { normalizeBox } from '@/lib/cpdCertificateGeometry';
import { certificateKeys } from './useAwardCertificates';

export function editablePlaceholder(p) {
  return { ...p, key: p.placeholder_key, page: p.page_number, align: p.alignment || 'left',
    field_type: p.placeholder_key === 'issued.date' ? 'date' : 'text',
    font_family: p.font_family || 'Helvetica', font_size: p.font_size || 12, minimum_font_size: p.minimum_font_size || 4,
    color: p.color || '#000000', vertical_align: p.vertical_align || p.vertical_alignment || 'middle',
    font_weight: /bold/.test(p.font_style || '') ? 'bold' : 'normal', font_style: /italic/.test(p.font_style || '') ? 'italic' : 'normal',
    required: p.missing_policy === 'error', shrink_to_fit: p.shrink_to_fit ?? p.overflow_policy === 'shrink',
    date_format: p.format || 'YYYY-MM-DD' };
}
export default function CertificatePlaceholderEditor({ fields, pages, onChange, disabled }) {
  const patch = (index, key, value) => onChange(fields.map((field, i) => i === index ? { ...field, [key]: value } : field));
  const add = () => onChange([...fields, { ...normalizeBox({ x: 36, y: 72, width: 300, height: 32 }, pages[0]),
    key: 'recipient.name', page: 1, field_type: 'text', font_family: 'Helvetica', font_size: 18, font_weight: 'normal', font_style: 'normal',
    align: 'center', color: '#173F42', line_height: 1.2, minimum_font_size: 4, vertical_align: 'middle', multiline: false, shrink_to_fit: true, required: false }]);
  return <fieldset disabled={disabled} className="space-y-4">
    <legend className="font-semibold">Text placement</legend>
    <p className="awards-help">PDF points (72 per inch), measured from the displayed page’s top-left. Signatures must already be embedded in the source PDF. No CPD data or live image lookup is used.</p>
    {pages.length > 0 && <p className="awards-help">{pages.map((page, i) => `Page ${i + 1}: ${page.width.toFixed(1)} × ${page.height.toFixed(1)} pt`).join(' · ')}</p>}
    {!fields.length && <div className="rounded-lg border border-dashed p-5 awards-help">The source artwork is unchanged. Add text placements to print the approved award details.</div>}
    {fields.map((field, index) => <fieldset key={index} className="rounded-lg border p-4 space-y-4">
      <legend className="px-2 text-sm font-semibold">Placement {index + 1}</legend>
      <div className="grid gap-3 md:grid-cols-2">
        <label className="text-sm">Value<select className="awards-select mt-1 w-full" disabled={field.text_template != null} value={field.key} onChange={e => { const key = e.target.value; onChange(fields.map((item, i) => i === index ? { ...item, key, field_type: key === 'issued.date' ? 'date' : 'text' } : item)); }}>
          {certificateKeys.map(key => <option key={key} value={key}>{key}</option>)}</select></label>
        <label className="text-sm">PDF page<input className="awards-input mt-1 w-full" type="number" min="1" max={pages.length || undefined} step="1" value={field.page} onChange={e => patch(index, 'page', e.target.value)} /></label>
      </div>
      {field.text_template != null && <div className="space-y-2"><label className="text-sm">Retained authored text from this source version<Textarea readOnly value={field.text_template} /></label><Button type="button" size="sm" variant="outline" onClick={() => { if (window.confirm('Replace this authored text with the selected dynamic award value?')) { const next = { ...field }; delete next.text_template; onChange(fields.map((item, i) => i === index ? next : item)); } }}>Use dynamic value instead</Button></div>}
      {field.missing_policy === 'literal' && !field.required && <p className="awards-help">This historical placement retains literal-key output if its value and fallback are missing. Select “Fail if missing” to refuse generation instead.</p>}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {[['x', 'Left (pt)'], ['y', 'Top (pt)'], ['width', 'Width (pt)'], ['height', 'Height (pt)']].map(([key, title]) => <label className="text-sm" key={key}>{title}<input className="awards-input mt-1 w-full" type="number" min={key === 'x' || key === 'y' ? '0' : '0.1'} step="0.1" value={field[key]} onChange={e => patch(index, key, e.target.value)} /></label>)}
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        <label className="text-sm">PDF font<select className="awards-select mt-1 w-full" value={field.font_family || 'Helvetica'} onChange={e => patch(index, 'font_family', e.target.value)}>{['Helvetica', 'Times', 'Courier'].map(font => <option key={font}>{font}</option>)}</select></label>
        <label className="text-sm">Font size (pt)<input className="awards-input mt-1 w-full" type="number" min="4" max="144" step="0.5" value={field.font_size} onChange={e => patch(index, 'font_size', e.target.value)} /></label>
        <label className="text-sm">Alignment<select className="awards-select mt-1 w-full" value={field.align} onChange={e => patch(index, 'align', e.target.value)}>{['left', 'center', 'right'].map(value => <option key={value}>{value}</option>)}</select></label>
        <label className="text-sm">Text colour<input className="block h-10 w-full mt-1" type="color" value={field.color || '#173F42'} onChange={e => patch(index, 'color', e.target.value)} /></label>
        <label className="text-sm">Minimum font (pt)<input className="awards-input mt-1 w-full" type="number" min="4" max={field.font_size} step="0.5" value={field.minimum_font_size || 4} onChange={e => patch(index, 'minimum_font_size', e.target.value)} /></label>
        <label className="text-sm">Vertical alignment<select className="awards-select mt-1 w-full" value={field.vertical_align || 'middle'} onChange={e => patch(index, 'vertical_align', e.target.value)}>{['top', 'middle', 'bottom'].map(value => <option key={value}>{value}</option>)}</select></label>
        {field.key === 'issued.date' && <label className="text-sm">Date format<select className="awards-select mt-1 w-full" value={field.date_format || 'YYYY-MM-DD'} onChange={e => patch(index, 'date_format', e.target.value)}>{['YYYY-MM-DD', 'D MMMM YYYY', 'DD/MM/YYYY', 'date:long'].map(value => <option key={value}>{value}</option>)}</select></label>}
        {field.key !== 'issued.date' && <label className="text-sm">Text case<select className="awards-select mt-1 w-full" value={field.format || ''} onChange={e => patch(index, 'format', e.target.value || null)}><option value="">As supplied</option><option value="uppercase">Uppercase</option><option value="lowercase">Lowercase</option></select></label>}
        <label className="text-sm">Fallback text if missing<Input value={field.default_value ?? ''} onChange={e => patch(index, 'default_value', e.target.value)} /></label>
      </div>
      <div className="flex flex-wrap gap-4 text-sm">
        {[['multiline', 'Wrap lines'], ['shrink_to_fit', 'Shrink to fit'], ['required', 'Fail if missing']].map(([key, label]) => <label key={key} className="flex gap-2 items-center"><input type="checkbox" checked={!!field[key]} onChange={e => patch(index, key, e.target.checked)} />{label}</label>)}
        <label className="flex gap-2 items-center"><input type="checkbox" checked={field.font_weight === 'bold'} onChange={e => patch(index, 'font_weight', e.target.checked ? 'bold' : 'normal')} />Bold</label>
        <label className="flex gap-2 items-center"><input type="checkbox" checked={field.font_style === 'italic'} onChange={e => patch(index, 'font_style', e.target.checked ? 'italic' : 'normal')} />Italic</label>
      </div>
      <div className="flex gap-2"><Button type="button" size="sm" variant="outline" disabled={index === 0} onClick={() => { const next = [...fields]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; onChange(next); }}>Move up</Button><Button type="button" size="sm" variant="outline" disabled={index === fields.length - 1} onClick={() => { const next = [...fields]; [next[index + 1], next[index]] = [next[index], next[index + 1]]; onChange(next); }}>Move down</Button><Button type="button" size="sm" variant="ghost" onClick={() => { if (window.confirm('Remove this text placement from the draft?')) onChange(fields.filter((_, i) => i !== index)); }}>Remove</Button></div>
    </fieldset>)}
    <Button type="button" size="sm" variant="outline" disabled={!pages.length || fields.length >= 100} onClick={add}>Add text placement</Button>
  </fieldset>;
}
