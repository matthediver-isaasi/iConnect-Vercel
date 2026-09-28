// Deliberately separate, server-selected public mode. Do not merge this with a
// browser `public: true` flag: authentication state must be ignored by design.
import { handleMemberAiAsk } from './ask.js';

export default async function publicAskHandler(req, res) {
  return handleMemberAiAsk(req, res, { publicOnly: true });
}