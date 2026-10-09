import { Link } from "react-router-dom";
import { ListChecks } from "lucide-react";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { SALES_BASE_PERMISSION } from "@/lib/salesNavigation";
import { Button } from "@/components/ui/button";

export default function ProjectsSalesTasksLink() {
  const { isAccessReady, isFeatureExcluded } = useMemberAccess();
  if (!isAccessReady || isFeatureExcluded(SALES_BASE_PERMISSION) || isFeatureExcluded("sales.tasks") || isFeatureExcluded("projects.board-view")) return null;
  return <Button variant="outline" size="sm" asChild><Link to="/sales/tasks?source=project&scope=my&status=outstanding"><ListChecks className="mr-2 h-4 w-4" />Sales project tasks</Link></Button>;
}
