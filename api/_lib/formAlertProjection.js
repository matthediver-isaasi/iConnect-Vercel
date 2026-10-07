import { redactIdentityAnswers } from './surveyScoring.js';
import { isRepeatableRowField, repeatableRowChildren } from '../../shared/formRepeatableRows.js';
import { scopedFormAlertAttachment } from './formAlertAttachments.js';
import { formatRelationshipAnswerDisplayValue } from '../../client/src/lib/relationshipDisplayLabels.js';

const OMIT = new Set(['instructions','image']);
const PRIVATE = new Set(['file','signature','contact','address_lookup','phone','tel','url',
  'communication_preferences','payment','membership_payment','custom_field']);
const scalar = value => value == null ? '' : typeof value === 'boolean'
  ? (value ? 'Yes' : 'No') : ['string','number'].includes(typeof value) ? String(value) : '';
const plain = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};

// Only schema-defined fields and explicitly supported composite properties may
// leave the server. Never serialize arbitrary submitted objects as JSON.
export function projectFormAlertAnswers(fields, answers, options = {}) {
  const { anonymous = false, attachments, tenantId, submissionId, relationshipLabels = {},
    organizationLabels = {}, groupLabels = {} } = options;
  const values = plain(answers);
  const output = [];
  for (const field of Array.isArray(fields) ? fields : []) {
    if (!field?.id || OMIT.has(field.type)) continue;
    if (anonymous && (PRIVATE.has(field.type)
      || !Object.hasOwn(redactIdentityAnswers([field], { [field.id]: true }).data, field.id))) continue;
    const value = values[field.id];
    const node = { label: String(field.label || field.name || field.id), value: '' };
    if (isRepeatableRowField(field)) {
      node.rows = (Array.isArray(value) ? value : []).map(row =>
        projectFormAlertAnswers(repeatableRowChildren(field), row, options));
    } else if (field.type === 'grouped_question') {
      node.children = projectFormAlertAnswers(field.sub_questions || [], value, options);
    } else if (field.type === 'file' || field.type === 'signature') {
      // Never return a submitted URL: a file reference is not proof of ownership.
      node.value = value ? 'Attachment unavailable in this view' : '';
      const file = field.type === 'file' && !anonymous && attachments
        ? scopedFormAlertAttachment(value, tenantId, submissionId) : null;
      if (file) {
        node.attachment = { id: String(attachments.length), name: file.name };
        attachments.push(file);
        node.value = '';
      }
    } else if (field.type === 'score') {
      node.value = value?.na === true ? 'Not applicable' : scalar(plain(value).score ?? value);
    } else if (field.type === 'contact') {
      node.children = ['first_name','last_name','name','email','phone','job_title','organization']
        .filter(key => Object.hasOwn(plain(value), key))
        .map(key => ({ label: key.replaceAll('_',' '), value: scalar(value[key]) }));
    } else if (field.type === 'address_lookup') {
      node.children = ['line_1','line_2','line_3','post_town','county','postcode','country']
        .filter(key => Object.hasOwn(plain(value),key))
        .map(key => ({label:key.replaceAll('_',' '),value:scalar(value[key])}));
    } else if (field.type === 'relationship_dropdown') {
      node.value = formatRelationshipAnswerDisplayValue(field,value,relationshipLabels,values);
    } else if (['organisation_dropdown','organisation_group_dropdown'].includes(field.type)) {
      const labels=field.type==='organisation_dropdown'?organizationLabels:groupLabels;
      node.value=(Array.isArray(value)?value:[value]).filter(Boolean).map(id=>labels[id]||'Unavailable record').join(', ');
    } else {
      node.value = Array.isArray(value) ? value.map(scalar).filter(Boolean).join(', ') : scalar(value);
    }
    if (node.children && !node.children.length && anonymous) continue;
    output.push(node);
  }
  return output;
}
