-- 核41信息收集：在 Supabase SQL Editor 中由数据库所有者执行。
-- 可重复执行；不会覆盖现有名单、配置或填报数据。
begin;

create schema if not exists h41;
revoke all on schema h41 from public, anon, authenticated;
alter default privileges in schema h41 revoke all on tables from public, anon, authenticated;
alter default privileges in schema h41 revoke all on sequences from public, anon, authenticated;
alter default privileges in schema h41 revoke execute on functions from public, anon, authenticated;

create table if not exists h41.collections (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(title) between 1 and 120),
  activity_scope text not null check (char_length(activity_scope) between 1 and 2000),
  award_scope text not null default '' check (char_length(award_scope) <= 2000),
  is_open boolean not null default false,
  check (not is_open or char_length(btrim(award_scope)) > 0)
);
create table if not exists h41.students (
  id uuid primary key default gen_random_uuid(),
  collection_id uuid not null references h41.collections(id),
  display_name text not null check (char_length(display_name) between 1 and 80),
  included boolean not null default true,
  unique (collection_id, id)
);
create table if not exists h41.admins (
  user_id uuid primary key references auth.users(id) on delete cascade
);
create table if not exists h41.submissions (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique,
  collection_id uuid not null references h41.collections(id),
  student_id uuid not null,
  has_activities boolean not null,
  has_awards boolean not null,
  submitted_at timestamptz not null default clock_timestamp(),
  is_void boolean not null default false,
  -- 永远保存初次请求，管理员改归属或明细不会改变幂等判定。
  request_payload jsonb not null check (octet_length(request_payload::text) <= 65536),
  foreign key (collection_id, student_id) references h41.students(collection_id, id)
);
create table if not exists h41.activities (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references h41.submissions(id),
  category text not null check (category in ('SRT项目','各类竞赛','课外科技活动','课外文化活动','课外体育活动')),
  name text not null check (char_length(name) between 1 and 200),
  is_void boolean not null default false
);
create table if not exists h41.awards (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references h41.submissions(id),
  month text not null check (month ~ '^(19[0-9]{2}|20[0-9]{2}|2100)-(0[1-9]|1[0-2])$'),
  name text not null check (char_length(name) between 1 and 200),
  is_void boolean not null default false
);
create index if not exists submissions_collection_student on h41.submissions(collection_id,student_id);
create index if not exists activities_submission on h41.activities(submission_id);
create index if not exists awards_submission on h41.awards(submission_id);
create index if not exists students_collection on h41.students(collection_id);

alter table h41.collections enable row level security;
alter table h41.students enable row level security;
alter table h41.admins enable row level security;
alter table h41.submissions enable row level security;
alter table h41.activities enable row level security;
alter table h41.awards enable row level security;
-- 故意不创建客户端 RLS policy：所有读写均只经过下面职责受限的 RPC。
revoke all on all tables in schema h41 from public, anon, authenticated;
revoke all on all sequences in schema h41 from public, anon, authenticated;

create or replace function h41.trim_text(p_value text)
returns text language sql immutable set search_path = '' as $$
  select pg_catalog.btrim(p_value, E' \t\n\r\f\v' || pg_catalog.chr(160) || pg_catalog.chr(5760)
    || pg_catalog.chr(8192) || pg_catalog.chr(8193) || pg_catalog.chr(8194)
    || pg_catalog.chr(8195) || pg_catalog.chr(8196) || pg_catalog.chr(8197)
    || pg_catalog.chr(8198) || pg_catalog.chr(8199) || pg_catalog.chr(8200)
    || pg_catalog.chr(8201) || pg_catalog.chr(8202) || pg_catalog.chr(8232)
    || pg_catalog.chr(8233) || pg_catalog.chr(8239) || pg_catalog.chr(8287)
    || pg_catalog.chr(12288) || pg_catalog.chr(65279));
$$;

create or replace function h41.require_admin()
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or not exists (select 1 from h41.admins where user_id = auth.uid()) then
    raise exception using errcode = '42501', message = '仅指定管理员可执行此操作';
  end if;
end;
$$;

create or replace function public.h41_public_form(p_collection_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_collection h41.collections%rowtype;
begin
  select * into v_collection from h41.collections where id = p_collection_id;
  if not found then raise exception '未找到本次收集'; end if;
  return pg_catalog.jsonb_build_object(
    'collection', pg_catalog.jsonb_build_object('id',v_collection.id,'title',v_collection.title,
      'activity_scope',v_collection.activity_scope,'award_scope',v_collection.award_scope,'is_open',v_collection.is_open),
    'students', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id',id,'display_name',display_name) order by display_name,id)
      from h41.students where collection_id = p_collection_id and included), '[]'::jsonb));
end;
$$;

create or replace function public.h41_submit_form(
  p_request_id uuid, p_collection_id uuid, p_student_id uuid,
  p_has_activities boolean, p_has_awards boolean, p_activities jsonb, p_awards jsonb
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_payload jsonb;
  v_existing h41.submissions%rowtype;
  v_collection h41.collections%rowtype;
  v_submission h41.submissions%rowtype;
  v_item jsonb;
  v_name text;
  v_category text;
  v_month text;
begin
  if p_request_id is null or p_collection_id is null or p_student_id is null then raise exception '缺少请求、收集或学生标识'; end if;
  v_payload := pg_catalog.jsonb_build_object('p_request_id',p_request_id,'p_collection_id',p_collection_id,'p_student_id',p_student_id,
    'p_has_activities',p_has_activities,'p_has_awards',p_has_awards,'p_activities',p_activities,'p_awards',p_awards);
  if pg_catalog.octet_length(v_payload::text) > 65536 then raise exception '提交内容超过 65536 字节上限'; end if;

  -- 所有变更均先锁本次收集行；关闭、名单变更、补交及管理员整理按同一顺序串行。
  select * into v_collection from h41.collections where id = p_collection_id for update;
  if not found then raise exception '未找到本次收集'; end if;
  select * into v_existing from h41.submissions where request_id = p_request_id;
  if found then
    if v_existing.request_payload is distinct from v_payload then raise exception '同一请求标识不能用于不同内容，请开始新的填报'; end if;
    return pg_catalog.jsonb_build_object('receipt_id',v_existing.id,'submitted_at',v_existing.submitted_at);
  end if;
  if not v_collection.is_open then raise exception '本次收集尚未开放或已经结束'; end if;
  if not exists (select 1 from h41.students where id = p_student_id and collection_id = p_collection_id and included) then
    raise exception '请选择本次名单中的有效姓名';
  end if;
  if p_has_activities is null or p_has_awards is null then raise exception '请分别选择是否有活动和获奖'; end if;
  if pg_catalog.jsonb_typeof(p_activities) is distinct from 'array' or pg_catalog.jsonb_typeof(p_awards) is distinct from 'array' then
    raise exception '活动和获奖明细必须为数组';
  end if;
  if pg_catalog.jsonb_array_length(p_activities) > 40 or pg_catalog.jsonb_array_length(p_awards) > 40 then raise exception '活动和获奖每部分最多填写 40 项'; end if;
  if p_has_activities <> (pg_catalog.jsonb_array_length(p_activities) > 0) or p_has_awards <> (pg_catalog.jsonb_array_length(p_awards) > 0) then
    raise exception '有无选择与明细不一致，选择有时请至少填写一项';
  end if;

  insert into h41.submissions(request_id,collection_id,student_id,has_activities,has_awards,request_payload)
    values(p_request_id,p_collection_id,p_student_id,p_has_activities,p_has_awards,v_payload) returning * into v_submission;
  for v_item in select value from pg_catalog.jsonb_array_elements(p_activities) loop
    if pg_catalog.jsonb_typeof(v_item) is distinct from 'object'
      or pg_catalog.jsonb_typeof(v_item->'category') is distinct from 'string'
      or pg_catalog.jsonb_typeof(v_item->'name') is distinct from 'string' then raise exception '活动明细格式不正确'; end if;
    if (v_item - 'category' - 'name') <> '{}'::jsonb then raise exception '活动明细包含不支持的字段'; end if;
    v_category := h41.trim_text(v_item->>'category');
    v_name := h41.trim_text(v_item->>'name');
    if v_category not in ('SRT项目','各类竞赛','课外科技活动','课外文化活动','课外体育活动') then raise exception '请选择规定的五类活动之一'; end if;
    if pg_catalog.char_length(v_name) not between 1 and 200 then raise exception '活动名称需为 1 至 200 个字符'; end if;
    insert into h41.activities(submission_id,category,name) values(v_submission.id,v_category,v_name);
  end loop;
  for v_item in select value from pg_catalog.jsonb_array_elements(p_awards) loop
    if pg_catalog.jsonb_typeof(v_item) is distinct from 'object'
      or pg_catalog.jsonb_typeof(v_item->'month') is distinct from 'string'
      or pg_catalog.jsonb_typeof(v_item->'name') is distinct from 'string' then raise exception '获奖明细格式不正确'; end if;
    if (v_item - 'month' - 'name') <> '{}'::jsonb then raise exception '获奖明细包含不支持的字段'; end if;
    v_month := h41.trim_text(v_item->>'month');
    v_name := h41.trim_text(v_item->>'name');
    if v_month !~ '^(19[0-9]{2}|20[0-9]{2}|2100)-(0[1-9]|1[0-2])$' then raise exception '获奖年月必须为 1900 至 2100 年的 YYYY-MM 格式'; end if;
    if pg_catalog.char_length(v_name) not between 1 and 200 then raise exception '奖项名称需为 1 至 200 个字符'; end if;
    insert into h41.awards(submission_id,month,name) values(v_submission.id,v_month,v_name);
  end loop;
  return pg_catalog.jsonb_build_object('receipt_id',v_submission.id,'submitted_at',v_submission.submitted_at);
end;
$$;

create or replace function public.h41_admin_data(p_collection_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_result jsonb;
begin
  perform h41.require_admin();
  -- 单条 SQL 返回一个一致快照；不把不可变的原始请求负载暴露给前端。
  select pg_catalog.jsonb_build_object(
    'collection',pg_catalog.to_jsonb(c),
    'students',coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id',st.id,'display_name',st.display_name,'included',st.included) order by st.display_name,st.id)
      from h41.students st where st.collection_id = c.id),'[]'::jsonb),
    'submissions',coalesce((select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(s) - 'request_payload' - 'collection_id' order by s.submitted_at,s.id)
      from h41.submissions s where s.collection_id = c.id),'[]'::jsonb),
    'activities',coalesce((select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(a) order by a.id)
      from h41.activities a join h41.submissions s on s.id = a.submission_id where s.collection_id = c.id),'[]'::jsonb),
    'awards',coalesce((select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(a) order by a.id)
      from h41.awards a join h41.submissions s on s.id = a.submission_id where s.collection_id = c.id),'[]'::jsonb)
  ) into v_result from h41.collections c where c.id = p_collection_id;
  if v_result is null then raise exception '未找到本次收集'; end if;
  return v_result;
end;
$$;

create or replace function public.h41_save_settings(p_collection_id uuid,p_title text,p_activity_scope text,p_award_scope text,p_is_open boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform h41.require_admin();
  perform 1 from h41.collections where id = p_collection_id for update;
  if not found then raise exception '未找到本次收集'; end if;
  if p_title is null or pg_catalog.char_length(h41.trim_text(p_title)) not between 1 and 120 then raise exception '标题需为 1 至 120 个字符'; end if;
  if p_activity_scope is null or pg_catalog.char_length(h41.trim_text(p_activity_scope)) not between 1 and 2000 then raise exception '活动范围说明需为 1 至 2000 个字符'; end if;
  if p_award_scope is null or pg_catalog.char_length(h41.trim_text(p_award_scope)) > 2000 then raise exception '获奖范围说明最多 2000 个字符'; end if;
  if p_is_open is null then raise exception '请选择开放状态'; end if;
  if p_is_open and (h41.trim_text(p_award_scope) = '' or not exists(select 1 from h41.students where collection_id = p_collection_id and included)) then
    raise exception '开放前请添加有效名单并填写获奖统计范围';
  end if;
  update h41.collections set title = h41.trim_text(p_title),activity_scope = h41.trim_text(p_activity_scope),
    award_scope = h41.trim_text(p_award_scope),is_open = p_is_open where id = p_collection_id;
  return pg_catalog.jsonb_build_object('ok',true);
end;
$$;

create or replace function public.h41_upsert_student(p_collection_id uuid,p_student_id uuid,p_display_name text,p_included boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_open boolean; v_id uuid;
begin
  perform h41.require_admin();
  select is_open into v_open from h41.collections where id = p_collection_id for update;
  if not found then raise exception '未找到本次收集'; end if;
  if p_display_name is null or pg_catalog.char_length(h41.trim_text(p_display_name)) not between 1 and 80 then raise exception '显示姓名需为 1 至 80 个字符'; end if;
  if p_included is null then raise exception '请选择是否纳入统计'; end if;
  -- 收集行锁覆盖检查和写入，避免两位管理员并发创建或响应丢失后重试产生重复成员。
  -- 不对历史表加唯一索引；已有同名记录仍保留稳定 ID，管理员可逐一补充区分信息。
  if exists(select 1 from h41.students where collection_id = p_collection_id
      and h41.trim_text(display_name) = h41.trim_text(p_display_name) and id is distinct from p_student_id) then
    raise exception '名单已有此显示姓名，请使用能区分重名同学的显示方式';
  end if;
  if v_open and not p_included and not exists(select 1 from h41.students where collection_id = p_collection_id and included and id is distinct from p_student_id) then
    raise exception '开放期间名单不能为空，请先关闭收集';
  end if;
  if p_student_id is null then
    insert into h41.students(collection_id,display_name,included) values(p_collection_id,h41.trim_text(p_display_name),p_included) returning id into v_id;
  else
    update h41.students set display_name = h41.trim_text(p_display_name),included = p_included where id = p_student_id and collection_id = p_collection_id returning id into v_id;
    if not found then raise exception '未找到本次名单中的学生'; end if;
  end if;
  return pg_catalog.jsonb_build_object('ok',true,'student_id',v_id);
end;
$$;

create or replace function public.h41_update_submission(p_submission_id uuid,p_student_id uuid,p_is_void boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_collection_id uuid;
begin
  perform h41.require_admin();
  select collection_id into v_collection_id from h41.submissions where id = p_submission_id;
  if not found then raise exception '未找到该提交'; end if;
  perform 1 from h41.collections where id = v_collection_id for update;
  if p_is_void is null then raise exception '请选择作废状态'; end if;
  if not exists(select 1 from h41.students where id = p_student_id and collection_id = v_collection_id) then raise exception '归属姓名必须在本次名单内'; end if;
  -- 明细只关联 submission_id，因此归属修改对全部明细原子生效；保留明细自身的作废状态。
  update h41.submissions set student_id = p_student_id,is_void = p_is_void where id = p_submission_id;
  return pg_catalog.jsonb_build_object('ok',true);
end;
$$;

create or replace function public.h41_update_activity(p_activity_id uuid,p_category text,p_name text,p_is_void boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_collection_id uuid; v_student_id uuid; v_category text; v_name text;
begin
  perform h41.require_admin();
  select s.collection_id into v_collection_id from h41.activities a join h41.submissions s on s.id = a.submission_id where a.id = p_activity_id;
  if not found then raise exception '未找到该活动'; end if;
  perform 1 from h41.collections where id = v_collection_id for update;
  select s.student_id,a.category,a.name into v_student_id,v_category,v_name from h41.activities a join h41.submissions s on s.id = a.submission_id where a.id = p_activity_id;
  if p_category is null or h41.trim_text(p_category) not in ('SRT项目','各类竞赛','课外科技活动','课外文化活动','课外体育活动') then raise exception '请选择规定的五类活动之一'; end if;
  if p_name is null or pg_catalog.char_length(h41.trim_text(p_name)) not between 1 and 200 then raise exception '活动名称需为 1 至 200 个字符'; end if;
  if p_is_void is null then raise exception '请选择作废状态'; end if;
  -- 更新去重键对应的所有原始行，包括已作废行和作废提交中的行，恢复时不会漏掉重复副本。
  update h41.activities a set category = h41.trim_text(p_category),name = h41.trim_text(p_name),is_void = p_is_void
    from h41.submissions s where s.id = a.submission_id and s.collection_id = v_collection_id
      and s.student_id = v_student_id and a.category = v_category and a.name = v_name;
  return pg_catalog.jsonb_build_object('ok',true);
end;
$$;

create or replace function public.h41_update_award(p_award_id uuid,p_month text,p_name text,p_is_void boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_collection_id uuid; v_student_id uuid; v_month text; v_name text;
begin
  perform h41.require_admin();
  select s.collection_id into v_collection_id from h41.awards a join h41.submissions s on s.id = a.submission_id where a.id = p_award_id;
  if not found then raise exception '未找到该奖项'; end if;
  perform 1 from h41.collections where id = v_collection_id for update;
  select s.student_id,a.month,a.name into v_student_id,v_month,v_name from h41.awards a join h41.submissions s on s.id = a.submission_id where a.id = p_award_id;
  if p_month is null or h41.trim_text(p_month) !~ '^(19[0-9]{2}|20[0-9]{2}|2100)-(0[1-9]|1[0-2])$' then raise exception '获奖年月必须为 1900 至 2100 年的 YYYY-MM 格式'; end if;
  if p_name is null or pg_catalog.char_length(h41.trim_text(p_name)) not between 1 and 200 then raise exception '奖项名称需为 1 至 200 个字符'; end if;
  if p_is_void is null then raise exception '请选择作废状态'; end if;
  update h41.awards a set month = h41.trim_text(p_month),name = h41.trim_text(p_name),is_void = p_is_void
    from h41.submissions s where s.id = a.submission_id and s.collection_id = v_collection_id
      and s.student_id = v_student_id and a.month = v_month and a.name = v_name;
  return pg_catalog.jsonb_build_object('ok',true);
end;
$$;

revoke all on all functions in schema h41 from public, anon, authenticated;
revoke all on function public.h41_public_form(uuid) from public, anon, authenticated;
revoke all on function public.h41_submit_form(uuid,uuid,uuid,boolean,boolean,jsonb,jsonb) from public, anon, authenticated;
revoke all on function public.h41_admin_data(uuid) from public, anon, authenticated;
revoke all on function public.h41_save_settings(uuid,text,text,text,boolean) from public, anon, authenticated;
revoke all on function public.h41_upsert_student(uuid,uuid,text,boolean) from public, anon, authenticated;
revoke all on function public.h41_update_submission(uuid,uuid,boolean) from public, anon, authenticated;
revoke all on function public.h41_update_activity(uuid,text,text,boolean) from public, anon, authenticated;
revoke all on function public.h41_update_award(uuid,text,text,boolean) from public, anon, authenticated;
grant execute on function public.h41_public_form(uuid) to anon, authenticated;
grant execute on function public.h41_submit_form(uuid,uuid,uuid,boolean,boolean,jsonb,jsonb) to anon, authenticated;
grant execute on function public.h41_admin_data(uuid) to authenticated;
grant execute on function public.h41_save_settings(uuid,text,text,text,boolean) to authenticated;
grant execute on function public.h41_upsert_student(uuid,uuid,text,boolean) to authenticated;
grant execute on function public.h41_update_submission(uuid,uuid,boolean) to authenticated;
grant execute on function public.h41_update_activity(uuid,text,text,boolean) to authenticated;
grant execute on function public.h41_update_award(uuid,text,text,boolean) to authenticated;

insert into h41.collections(id,title,activity_scope,award_scope,is_open) values (
  '41414141-2026-4000-8000-000000000001', '核41班 · 优良学风班信息收集',
  '2025.8-今',
  '2025.8-今',false
) on conflict(id) do nothing;

commit;
