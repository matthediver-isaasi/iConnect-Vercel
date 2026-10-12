-- Supabase's owner default ACL grants service_role ALL on new objects.
-- GRANT SELECT alone is additive, not a restriction. Keep writes exclusively
-- inside the validated SECURITY DEFINER RPCs and acceptance trigger.
REVOKE ALL ON public.sales_task_automation_config,public.sales_acceptance_task_request
 FROM service_role;
GRANT SELECT ON public.sales_task_automation_config,public.sales_acceptance_task_request
 TO service_role;
REVOKE ALL ON FUNCTION public.queue_sales_acceptance_tasks() FROM service_role;
