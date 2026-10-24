import { useEffect, useState } from "react";
import { watchGroupCardExpiry } from "../lib/memberGroupCardEligibility.js";

export function useGroupCardExpiryClock() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => watchGroupCardExpiry(setNow, window, document), []);
  return now;
}
