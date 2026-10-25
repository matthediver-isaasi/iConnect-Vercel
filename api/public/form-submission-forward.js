import response from './form-alert-response.js';
import { resolveSubmissionForward } from '../_lib/formSubmissionForwards.js';

export default function handler(req, res, deps = {}) {
  return response(req, res, { ...deps, resolveCapability: deps.resolveCapability || resolveSubmissionForward });
}
