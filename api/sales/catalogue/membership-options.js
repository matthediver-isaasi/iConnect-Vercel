import { createSalesCatalogueHandler } from './[...path].js';

// Match the explicit catalogue entry points used by plain Vercel functions.
export function createMembershipOptionsHandler(dependencies = {}) {
  const handler = createSalesCatalogueHandler(dependencies);
  return (req, res) => {
    req.query = { ...req.query, path: ['membership-options'] };
    return handler(req, res);
  };
}

export default createMembershipOptionsHandler();
