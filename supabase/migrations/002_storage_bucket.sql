insert into storage.buckets (id, name, public)
values ('note-images', 'note-images', true)
on conflict (id) do nothing;

create policy "Public read note-images"
  on storage.objects for select
  using ( bucket_id = 'note-images' );

create policy "Service role insert note-images"
  on storage.objects for insert
  with check ( bucket_id = 'note-images' );
