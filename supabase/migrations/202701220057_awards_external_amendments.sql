BEGIN;
ALTER TABLE public.awards_amendment ALTER COLUMN member_id DROP NOT NULL;
ALTER TABLE public.awards_amendment ADD COLUMN access_id uuid;
ALTER TABLE public.awards_amendment ADD CONSTRAINT awards_amendment_owner
  CHECK(num_nonnulls(member_id,access_id)=1);
ALTER TABLE public.awards_amendment ADD CONSTRAINT awards_amendment_access_owner
  FOREIGN KEY(tenant_id,application_id,access_id) REFERENCES public.awards_applicant_access(tenant_id,application_id,id);
COMMIT;
