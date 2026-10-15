-- Aggregate diagnostics only. No source, consent or recipient policy changes.
alter table public.campaign_preparation
  add column if not exists candidate_count integer,
  add column if not exists global_excluded integer not null default 0;
-- Existing generations have no historical counters; never invent zero matches.
alter table public.campaign_preparation alter column candidate_count set default 0;

-- Preserve the reviewed preparation contract, failing closed on unexpected
-- definition drift instead of replacing unrelated lease/quota/consent logic.
do $migration$
declare definition text; original text; needle text;
begin
  select pg_get_functiondef('public.campaign_preparation_step(uuid,uuid,text,jsonb)'::regprocedure) into definition;
  if position('candidate_count=candidate_count+' in definition)>0 then return; end if;
  original:=definition;
  needle:='accepted integer:=0; inserted_count integer;';
  if position(needle in definition)=0 then raise exception 'Preparation declaration contract changed'; end if;
  definition:=replace(definition,needle,needle||' discarded integer:=0;');
  needle:='update campaign_preparation set continuation=case';
  if position(needle in definition)=0 then raise exception 'Preparation stream contract changed'; end if;
  definition:=replace(definition,needle,
    'update campaign_preparation set candidate_count=candidate_count+jsonb_array_length(p_payload->''candidates''), continuation=case');
  needle:='if not eligible then delete from campaign_preparation_candidate';
  if position(needle in definition)=0 then raise exception 'Preparation global consent contract changed'; end if;
  definition:=replace(definition,needle,
    'if not eligible then discarded:=discarded+1; delete from campaign_preparation_candidate');
  needle:='has_consent_checks=p.has_consent_checks,';
  if position(needle in definition)=0 then raise exception 'Preparation counters contract changed'; end if;
  definition:=replace(definition,needle,
    'global_excluded=global_excluded+discarded, '||needle);
  needle:='if n=0 and p_action=''consent'' and p.total=0 then raise exception ''No recipients found for this campaign''; end if;';
  if position(needle in definition)=0 then raise exception 'Preparation empty audience contract changed'; end if;
  definition:=replace(definition,needle,$replacement$
    if n=0 and p_action='consent' and p.total=0 then
      if p.candidate_count is null then
        raise exception 'No eligible recipients remain. Historical preparation counts are unavailable; review a fresh campaign-context preview before creating a new draft. Do not override opt-outs.';
      elsif p.candidate_count=0 then
        raise exception 'No contacts matched the audience. Check the selected event, ticket types and recorded attendance, and confirm attendance processing has completed.';
      else
        raise exception 'No eligible recipients remain from % matching contacts: % excluded by global consent and % by category eligibility. Review the campaign category and subscription eligibility; do not override opt-outs to make the campaign send.',
          p.candidate_count,p.global_excluded,p.candidate_count-p.global_excluded;
      end if;
    end if;
  $replacement$);
  execute definition;
end $migration$;
