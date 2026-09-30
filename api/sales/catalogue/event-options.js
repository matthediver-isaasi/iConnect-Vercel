import { createSalesCatalogueHandler } from './[...path].js';

const handler = createSalesCatalogueHandler();
export default (req, res) => ((req.query = { ...req.query, path: ['event-options'] }), handler(req, res));