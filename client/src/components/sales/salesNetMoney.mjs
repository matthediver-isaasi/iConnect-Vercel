import { formatSalesMoney } from "../../lib/salesMoney.js";

export function netMoney(value, currency, source) {
  if (value == null || value === "" || !Number.isSafeInteger(Number(value))) return "Net unavailable";
  if (!currency || !/^[A-Z]{3}$/.test(currency)) return "Net currency not recorded";
  return `${currency} ${formatSalesMoney(value, currency, { minorUnits: true })} ${source === "manual" ? "net estimate" : "net"}`;
}
