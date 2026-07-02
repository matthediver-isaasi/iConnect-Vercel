export function extractContactFieldsWithContracts(formSchema, submissionData) {
  if (!formSchema || !submissionData) return [];

  const schema = formSchema.schema || formSchema;
  if (!schema.fields && !schema.pages) return [];

  const contacts = [];

  const processFields = (fields) => {
    if (!fields) return;
    fields.forEach((field) => {
      if (field.type === 'contact' && field.contract_form_id) {
        const fieldKey = field.name || field.id;
        const fieldValue = submissionData[fieldKey] || submissionData[field.id];

        if (fieldValue) {
          let contactData = fieldValue;
          if (typeof fieldValue === 'string') {
            try {
              contactData = JSON.parse(fieldValue);
            } catch {
              contactData = {};
            }
          }

          contacts.push({
            fieldId: field.id,
            fieldKey,
            fieldLabel: field.label || fieldKey,
            contractFormId: field.contract_form_id,
            firstName: contactData.first_name || contactData.firstName || '',
            lastName: contactData.last_name || contactData.lastName || '',
            email: contactData.email || '',
            jobTitle: contactData.job_title || contactData.jobTitle || '',
            organisation: contactData.organisation || contactData.organization || '',
          });
        }
      }
    });
  };

  if (schema.pages && schema.pages.length > 0) {
    schema.pages.forEach((page) => {
      if (page.fields) processFields(page.fields);
    });
  }

  if (schema.fields) {
    processFields(schema.fields);
  }

  return contacts;
}

function findContractsForField(contact, contracts) {
  let contractsForField = contracts.filter(
    (c) => c.sourceContactFieldId === contact.fieldId
  );

  if (contractsForField.length === 0) {
    const legacyCandidates = contracts.filter(
      (c) => c.formId === contact.contractFormId && !c.sourceContactFieldId
    );
    if (legacyCandidates.length === 1) {
      contractsForField = legacyCandidates;
    }
  }

  return contractsForField;
}

function contractHasSignedSigner(contract) {
  const signedSigners = contract.signedSigners || [];
  if (signedSigners.some((s) => !s.demoted_at)) return true;

  const signers = contract.signers || [];
  return signers.some((s) => s.signed && !s.demoted_at);
}

export function getContactFieldFulfillment(formSchema, submissionData, contracts) {
  const fields = extractContactFieldsWithContracts(formSchema, submissionData);
  const contractList = contracts || [];

  return fields.map((contact) => {
    const contractsForField = findContractsForField(contact, contractList);
    const isFulfilled = contractsForField.some((c) => contractHasSignedSigner(c));
    return { ...contact, isFulfilled };
  });
}
