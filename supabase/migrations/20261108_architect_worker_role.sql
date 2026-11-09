-- The Cloudflare Worker connects (through Hyperdrive) as `architect_worker`, a login that can only
-- call Architect's own functions. Its password is set outside the repo (stored as a SCRAM hash).
-- The functions are SECURITY DEFINER, so the role needs no table rights at all.
grant usage on schema public to architect_worker;
do $$
declare f text;
begin
  foreach f in array array[
    'architect_save_run(jsonb)', 'architect_get_run(text)', 'architect_list_runs(int)',
    'architect_append_event(jsonb)', 'architect_events(text)',
    'architect_put_file(text, text, text)', 'architect_get_file(text, text)'
  ] loop
    execute format('grant execute on function public.%s to architect_worker', f);
  end loop;
end $$;
