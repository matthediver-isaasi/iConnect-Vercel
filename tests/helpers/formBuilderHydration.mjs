import { readFileSync } from 'node:fs';
import { normalizePipelineMappingEntities } from '../../shared/formCrmNotes.js';
import { normalizeFormWidth } from '../../shared/formWidth.js';

// Execute the builder's actual hydration code, including generated migration IDs.
const source = readFileSync(new URL('../../client/src/pages/FormBuilder.jsx', import.meta.url), 'utf8');
const migration = source.slice(source.indexOf('  const migrateToEntityPipelines ='),
  source.indexOf('\n  useEffect', source.indexOf('  const migrateToEntityPipelines =')));
const start = source.indexOf('      const hydratedForm = ');
const hydration = source.slice(start, source.indexOf('\n      editorBaseline.current =', start));
export const hydrateForm = new Function('normalizePipelineMappingEntities', 'normalizeFormWidth',
  `return (existingForm) => {
    const STRUCTURED_ACTIONS_VERSION = 1;
    ${migration}
    const entityPipelines = migrateToEntityPipelines(existingForm);
    ${hydration}
    return hydratedForm;
  };`)(normalizePipelineMappingEntities, normalizeFormWidth);
