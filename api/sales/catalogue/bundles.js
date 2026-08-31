import { createSalesCatalogueHandler } from './[...path].js';

const handler = createSalesCatalogueHandler();
export default (req, res) => ((req.query = { ...req.query, path: ['bundles'] }), handler(req, res));