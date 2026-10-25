import view from './form-alert-view.js';

export default function handler(req, res) {
  return view(req, res, { forward: true });
}
