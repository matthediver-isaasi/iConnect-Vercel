function hasExplicitLabel(control) {
  if (control.getAttribute?.('aria-label') || control.getAttribute?.('aria-labelledby')) {
    return true;
  }
  if (control.labels?.length) return true;
  const id = control.getAttribute?.('id');
  if (!id || !control.ownerDocument?.querySelector) return false;
  const escapedId = globalThis.CSS?.escape ? globalThis.CSS.escape(id) : id.replace(/["\\]/g, '\\$&');
  return !!control.ownerDocument.querySelector(`label[for="${escapedId}"]`);
}

function labelCombobox(control, container, headingId, contextId) {
  const existingIds = (control.getAttribute('aria-labelledby') || '')
    .split(/\s+/)
    .filter(Boolean);
  const ownValueLabelId = contextId ? `${contextId}-value` : '';
  if (ownValueLabelId && existingIds.includes(ownValueLabelId)) {
    const valueLabel = control.ownerDocument?.getElementById(ownValueLabelId);
    const valueText = control.textContent?.replace(/\s+/g, ' ').trim() || '';
    if (valueLabel && valueText) valueLabel.textContent = valueText;
    control.setAttribute(
      'aria-labelledby',
      [...new Set([headingId, ...existingIds])].join(' '),
    );
    return true;
  }
  if (existingIds.length) {
    control.setAttribute('aria-labelledby', [...new Set([headingId, ...existingIds])].join(' '));
    return true;
  }
  const valueText = control.textContent?.replace(/\s+/g, ' ').trim()
    || control.getAttribute('aria-label')?.trim()
    || '';
  if (!valueText || !contextId || !control.ownerDocument?.createElement) return false;
  const valueLabelId = ownValueLabelId;
  let valueLabel = control.ownerDocument.getElementById(valueLabelId);
  if (!valueLabel) {
    valueLabel = control.ownerDocument.createElement('span');
    valueLabel.id = valueLabelId;
    valueLabel.className = 'sr-only';
    valueLabel.dataset.repeatableSpreadsheetValue = 'true';
    container.appendChild(valueLabel);
  }
  valueLabel.textContent = valueText;
  control.removeAttribute('aria-label');
  control.setAttribute('aria-labelledby', `${headingId} ${valueLabelId}`);
  return true;
}

export function labelSpreadsheetControls(container, headingId, contextId = headingId) {
  if (!container?.querySelectorAll || !headingId) return 0;
  const controls = container.querySelectorAll([
    'input',
    'textarea',
    'select',
    'button',
    '[role="combobox"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="switch"]',
  ].join(','));
  let labelled = 0;
  controls.forEach((control) => {
    if (control.getAttribute?.('role') === 'combobox') {
      if (labelCombobox(control, container, headingId, contextId)) labelled += 1;
      return;
    }
    if (hasExplicitLabel(control)) return;
    control.setAttribute('aria-labelledby', headingId);
    labelled += 1;
  });
  return labelled;
}