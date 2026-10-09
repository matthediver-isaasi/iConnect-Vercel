import { useSearchParams } from "react-router-dom";
import SalesProjectCardEditor from "./SalesProjectCardEditor";

// Mount inside the existing guarded ProjectBoard route. The shared wrapper
// resolves the card from this board and checks Projects permissions.
export default function ProjectBoardTaskDeepLink({ boardId }) {
  const [params, setParams] = useSearchParams();
  const cardId = params.get("card");
  if (!cardId) return null;
  return <SalesProjectCardEditor boardId={boardId} cardId={cardId} open onOpenChange={(open) => {
    if (!open) {
      const next = new URLSearchParams(params);
      next.delete("card");
      setParams(next, { replace: true });
    }
  }} />;
}
