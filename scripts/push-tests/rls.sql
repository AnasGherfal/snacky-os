\set ON_ERROR_STOP on
begin;
insert into auth.users values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
insert into public.profiles values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','active'),('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','active');
insert into public.notifications(user_id,type,title,message) values
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','push_test','A','A'),('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','push_test','B','B');
set local role authenticated;
select set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
insert into public.push_subscriptions(user_id,endpoint,p256dh,auth) values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','https://fcm.googleapis.com/test/a','fixture','fixture');
do $$begin
 if (select count(*) from public.notifications) <> 1 then raise exception 'Cross-user notification disclosure'; end if;
 if not public.reserve_push_test_v1() then raise exception 'First test must reserve'; end if;
 if public.reserve_push_test_v1() then raise exception 'Rate limit failed'; end if;
 begin
   insert into public.push_subscriptions(user_id,endpoint,p256dh,auth) values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','https://fcm.googleapis.com/test/forged','fixture','fixture');
   raise exception 'Cross-user subscription allowed';
 exception when insufficient_privilege then null; end;
 begin
   update public.notifications set title='forged';
   raise exception 'Notification content edit allowed';
 exception when insufficient_privilege then null; end;
 begin
   insert into public.notifications(user_id,type,title,message) values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','forged','forged','forged');
   raise exception 'Client notification creation allowed';
 exception when insufficient_privilege then null; end;
end$$;
update public.notifications set read_at=now();
select set_config('request.jwt.claim.sub','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',true);
do $$begin
 if (select count(*) from public.push_subscriptions) <> 0 then raise exception 'Cross-user subscription disclosure'; end if;
 if exists(select 1 from public.notifications where read_at is not null) then raise exception 'Cross-user mark-read'; end if;
 if not public.reserve_push_test_v1() then raise exception 'Rate limit leaked between users'; end if;
 begin
   insert into public.push_subscriptions(user_id,endpoint,p256dh,auth) values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','https://fcm.googleapis.com/test/a','fixture','fixture')
   on conflict(endpoint) do update set user_id=excluded.user_id;
   raise exception 'Endpoint takeover allowed';
 exception when insufficient_privilege then null; end;
end$$;
reset role;
update public.profiles set active_status='inactive' where id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
set local role authenticated;
do $$begin
 begin
   perform public.reserve_push_test_v1(); raise exception 'Inactive account tested';
 exception when insufficient_privilege then null; end;
end$$;
reset role;
set local role anon;
do $$begin
 begin perform 1 from public.push_subscriptions; raise exception 'Anonymous subscription read'; exception when insufficient_privilege then null; end;
 begin perform 1 from public.notifications; raise exception 'Anonymous notification read'; exception when insufficient_privilege then null; end;
 begin perform public.reserve_push_test_v1(); raise exception 'Anonymous test reservation'; exception when insufficient_privilege then null; end;
end$$;
reset role;
rollback;
select 'Push RLS, ownership, permissions and rate limits passed' as result;
