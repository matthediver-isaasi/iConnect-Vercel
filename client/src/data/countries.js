// Thin re-export so existing `@/data/countries` imports keep working.
// The canonical list lives in `shared/countries.js` so server-side code
// can import the same source of truth without duplication.
export {
  COUNTRIES,
  getCountryByCode,
  getCountryByName,
  resolveCountryToIso2,
} from "@shared/countries";
