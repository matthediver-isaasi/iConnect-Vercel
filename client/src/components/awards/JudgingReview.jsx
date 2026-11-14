import React from 'react';
import JudgingAttachmentDownload from './JudgingAttachmentDownload';

function ReviewValue({ field }) {
  const value = field.value;
  if (field.type === 'signature') {
    if (!value || typeof value.image !== 'string' || value.image.length > 500000
      || !/^data:image\/png;base64,iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/.test(value.image)) return <p className="awards-help">No displayable signature image was supplied.</p>;
    return <figure className="space-y-2">
      <img src={value.image} alt="Submitted signature image" className="max-w-full max-h-48 object-contain border rounded-lg" referrerPolicy="no-referrer" />
      <figcaption className="awards-help">Signature image as submitted; this display does not verify identity or legal validity.
        {typeof value.signedAt === 'string' && Number.isFinite(Date.parse(value.signedAt)) && <span className="block">Recorded timestamp (UTC): <time dateTime={value.signedAt}>{new Date(value.signedAt).toISOString()}</time></span>}
      </figcaption>
    </figure>;
  }
  if (value === null || value === undefined || value === '') return <p className="awards-help">No response recorded.</p>;
  if (typeof value === 'boolean') return <p>{value ? 'Yes' : 'No'}</p>;
  if (typeof value === 'string' || typeof value === 'number') return <p className="whitespace-pre-wrap break-words">{String(value)}</p>;
  if (Array.isArray(value) && value.every(item => item == null || ['boolean', 'string', 'number'].includes(typeof item))) {
    return value.length ? <ul className="list-disc pl-5 space-y-2">{value.map((item, index) => <li className="whitespace-pre-wrap break-words" key={index}>{item == null ? 'No response recorded' : typeof item === 'boolean' ? (item ? 'Yes' : 'No') : String(item)}</li>)}</ul> : <p className="awards-help">No response recorded.</p>;
  }
  return <p className="awards-help">This response cannot be displayed in this review view.</p>;
}

export default function JudgingReview({ review, assignmentId, authority, requestAttachment, onAccessLost }) {
  return <div>
    {review.fields.length ? <dl className="space-y-6">{review.fields.map(field => <div key={field.id} className="border-b pb-5 last:border-0 last:pb-0">
      <dt className="text-sm font-semibold mb-2 break-words">{field.label}</dt><dd className="text-sm leading-relaxed"><ReviewValue field={field} /></dd>
    </div>)}</dl> : <p className="awards-help rounded-lg border p-5">No fields are included in this authorised evidence projection.</p>}
    {review.attachments.length > 0 && <section className="border-t pt-5 mt-6"><h3 className="font-semibold text-sm mb-3">Included attachments</h3>
      <ul className="space-y-3">{review.attachments.map(attachment => <JudgingAttachmentDownload
        key={JSON.stringify([assignmentId, authority?.scopeKey, attachment.id])}
        attachment={attachment} assignmentId={assignmentId} authority={authority} requestAttachment={requestAttachment} onAccessLost={onAccessLost} />)}</ul>
      <p className="awards-help mt-3">Each download rechecks access for every sequential chunk. The complete retained file is verified with SHA-256 before being handed to your browser. No storage link is used.</p>
    </section>}
  </div>;
}
