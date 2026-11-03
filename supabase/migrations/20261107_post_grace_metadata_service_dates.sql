BEGIN;
-- These are service-date mirrors used when a first bank payment precedes local
-- plan creation. The membership_year purchase key and provider cadence stay fixed.
CREATE OR REPLACE FUNCTION public.post_grace_metadata_dates(m jsonb,d jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=public,pg_temp AS $$
DECLARE result jsonb:=coalesce(m,'{}'::jsonb); k text; field text; value jsonb;
BEGIN
  IF jsonb_typeof(result->'commitment')='object' THEN
    result:=jsonb_set(result,'{commitment}',(result->'commitment')||d);
  END IF;
  FOREACH k IN ARRAY ARRAY['card','dd'] LOOP
    IF jsonb_typeof(result#>ARRAY[k,'commitment'])='object' THEN
      result:=jsonb_set(result,ARRAY[k,'commitment'],(result#>ARRAY[k,'commitment'])||d);
    END IF;
    FOREACH field IN ARRAY ARRAY['membership_year_start','membership_year_end','membership_renewal_date'] LOOP
      IF (result->k) ? field THEN
        value:=d->CASE field WHEN 'membership_year_start' THEN 'term_start_date'
          WHEN 'membership_year_end' THEN 'term_end_date' ELSE 'membership_renewal_date' END;
        result:=jsonb_set(result,ARRAY[k,field],value);
      END IF;
    END LOOP;
  END LOOP;
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.post_grace_metadata_dates(jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
