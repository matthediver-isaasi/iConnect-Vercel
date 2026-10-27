import { certificateDependencies } from './cpdCertificateDisplay.js';
// A valid historic certificate must actually place the immutable award facts
// on the PDF. Merely having values in the resolver's map is not sufficient.
export function hasHistoricCertificateFields(placeholders) {
  const keys = new Set((placeholders || []).flatMap(certificateDependencies));
  return (keys.has('historic_event_title') || keys.has('cpd.activity_title'))
    && keys.has('cpd.cpd_points');
}
