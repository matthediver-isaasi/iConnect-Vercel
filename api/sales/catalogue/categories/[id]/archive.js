import { createSalesCatalogueHandler } from '../../[...path].js';

const handler = createSalesCatalogueHandler();
export default (req, res) => ((req.query = { ...req.query, path: ['categories', req.query.id, 'archive'] }), handler(req, res));