import { Badge } from "@/components/ui/badge";
import { recipientDeliveryStatus } from "./bounceModel.mjs";

export default function RecipientDeliveryStatus({ recipient }) {
  const status = recipientDeliveryStatus(recipient);
  return <Badge variant="outline" className={status.className}>{status.label}</Badge>;
}
