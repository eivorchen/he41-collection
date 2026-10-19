import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { deriveData } from '../src/domain.js';

const COLLECTION = '41414141-2026-4000-8000-000000000001';
const OTHER_COLLECTION = '41414141-2026-4000-8000-000000000002';
const ADMIN = 'aaaaaaaa-aaaa-4000-8000-000000000001';
const OUTSIDER = 'aaaaaaaa-aaaa-4000-8000-000000000002';
const STUDENT_A = 'bbbbbbbb-bbbb-4000-8000-000000000001';
const STUDENT_B = 'bbbbbbbb-bbbb-4000-8000-000000000002';
const STUDENT_C = 'bbbbbbbb-bbbb-4000-8000-000000000003';
let db;

before(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon;
    create role authenticated;
    create schema auth;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid;
    $$;
    insert into auth.users values ('${ADMIN}'),('${OUTSIDER}');
  `);
  const schema = await readFile(new URL('../supabase/schema.sql', import.meta.url), 'utf8');
  await db.exec(schema);
  await db.exec(schema); // Re-running initialization must be safe and keep configuration.
  const initial = await db.query('select is_open,award_scope from h41.collections');
  assert.deepEqual(initial.rows, [{ is_open: false,
    award_scope: '2025.8-今' }]);
  assert.equal((await db.query('select count(*)::int as n from h41.students')).rows[0].n, 0);
});

beforeEach(async () => {
  await db.exec(`
    truncate h41.activities,h41.awards,h41.submissions,h41.students,h41.admins,h41.collections;
    insert into h41.admins(user_id) values ('${ADMIN}');
    insert into h41.collections(id,title,activity_scope,award_scope,is_open) values
      ('${COLLECTION}','核41信息收集','2025.8-今','2025.8-今',true),
      ('${OTHER_COLLECTION}','另一次收集','另一次活动范围','2026年',true);
    insert into h41.students(id,collection_id,display_name,included) values
      ('${STUDENT_A}','${COLLECTION}','张同学',true),
      ('${STUDENT_B}','${COLLECTION}','李同学',true),
      ('${STUDENT_C}','${OTHER_COLLECTION}','另一批同学',true);
  `);
});

after(async () => { if (db) await db.close(); });

async function withRole(role, userId, run) {
  await db.exec('begin');
  try {
    await db.query("select set_config('request.jwt.claim.sub',$1,true)", [userId ?? '']);
    await db.exec(`set local role ${role}`);
    const result = await run();
    await db.exec('commit');
    return result;
  } catch (error) {
    await db.exec('rollback');
    throw error;
  }
}

async function rpc(name, args, { role = 'authenticated', userId = ADMIN } = {}) {
  return withRole(role, userId, async () => {
    const placeholders = args.map((_, i) => `$${i + 1}`).join(',');
    const result = await db.query(`select public.${name}(${placeholders}) as result`, args);
    return result.rows[0].result;
  });
}

function form(overrides = {}) {
  return {
    requestId: randomUUID(), collectionId: COLLECTION, studentId: STUDENT_A,
    hasActivities: false, hasAwards: false, activities: [], awards: [], ...overrides,
  };
}

async function submit(payload = form()) {
  return rpc('h41_submit_form', [payload.requestId, payload.collectionId, payload.studentId,
    payload.hasActivities, payload.hasAwards, JSON.stringify(payload.activities), JSON.stringify(payload.awards)],
  { role: 'anon', userId: null });
}

async function data() { return rpc('h41_admin_data', [COLLECTION]); }

async function counts() {
  return (await db.query(`select
    (select count(*)::int from h41.submissions) as submissions,
    (select count(*)::int from h41.activities) as activities,
    (select count(*)::int from h41.awards) as awards`)).rows[0];
}

// Independent SQL oracle for effective/deduplicated outputs returned by the APIs.
async function effective() {
  return (await db.query(`
    with active_submissions as (
      select s.* from h41.submissions s join h41.students st on st.id=s.student_id
      where s.collection_id='${COLLECTION}' and not s.is_void and st.included
    ), activity_items as (
      select distinct s.student_id,a.category,a.name from active_submissions s
      join h41.activities a on a.submission_id=s.id where not a.is_void
    ), award_items as (
      select distinct s.student_id,a.month,a.name from active_submissions s
      join h41.awards a on a.submission_id=s.id where not a.is_void
    ) select
      (select count(distinct student_id)::int from active_submissions) as submitted,
      (select count(distinct student_id)::int from activity_items) as participants,
      (select count(*)::int from activity_items) as activity_items,
      (select count(distinct student_id)::int from activity_items where category='SRT项目') as srt,
      (select count(distinct student_id)::int from activity_items where category='各类竞赛') as competitions,
      (select count(distinct student_id)::int from award_items) as award_students,
      (select count(*)::int from award_items) as award_items
  `)).rows[0];
}

async function assertDerivedMatchesDatabase() {
  const view = deriveData(await data());
  const expected = await effective();
  assert.equal(view.counts.submitted, expected.submitted);
  assert.equal(view.counts.participants, expected.participants);
  assert.equal(view.counts.awardees, expected.award_students);
  assert.equal(view.counts.award_items, expected.award_items);
  assert.equal(view.activities.filter(row => !row.is_void && row.included).length, expected.activity_items);
  assert.equal(view.categoryCounts.find(row => row.category === 'SRT项目').count, expected.srt);
  assert.equal(view.categoryCounts.find(row => row.category === '各类竞赛').count, expected.competitions);
  assert.equal(view.counts.expected, view.students.filter(student => student.included).length);
  assert.equal(view.counts.missing, view.counts.expected - view.counts.submitted);
  return view;
}

test('public form exposes only configuration and included names; private schema and every table deny direct access', async () => {
  await rpc('h41_upsert_student', [COLLECTION, STUDENT_B, '不纳入同学', false]);
  const result = await rpc('h41_public_form', [COLLECTION], { role: 'anon', userId: null });
  assert.deepEqual(Object.keys(result).sort(), ['collection', 'students']);
  assert.deepEqual(result.students, [{ id: STUDENT_A, display_name: '张同学' }]);
  for (const role of ['anon', 'authenticated']) {
    for (const table of ['collections', 'students', 'submissions', 'activities', 'awards', 'admins']) {
      await assert.rejects(withRole(role, role === 'authenticated' ? ADMIN : null,
        () => db.query(`select * from h41.${table}`)), /permission denied/);
    }
    await assert.rejects(withRole(role, ADMIN, () => db.exec(`insert into h41.admins values ('${OUTSIDER}')`)), /permission denied/);
  }
  const policies = await db.query("select relname,relrowsecurity from pg_class join pg_namespace n on n.oid=relnamespace where n.nspname='h41' and relkind='r'");
  assert.equal(policies.rows.length, 6);
  assert.ok(policies.rows.every(row => row.relrowsecurity));
});

test('all management RPCs reject anonymous and ordinary authenticated users', async () => {
  const absent = randomUUID();
  const calls = [
    ['h41_admin_data', [COLLECTION]],
    ['h41_save_settings', [COLLECTION, '标题', '活动范围', '获奖范围', true]],
    ['h41_upsert_student', [COLLECTION, null, '新增', true]],
    ['h41_update_submission', [absent, STUDENT_A, false]],
    ['h41_update_activity', [absent, 'SRT项目', '项目', false]],
    ['h41_update_award', [absent, '2026-01', '奖项', false]],
  ];
  for (const [name, args] of calls) {
    await assert.rejects(rpc(name, args, { role: 'anon', userId: null }), /permission denied/);
    await assert.rejects(rpc(name, args, { role: 'authenticated', userId: OUTSIDER }), /仅指定管理员/);
    await assert.rejects(rpc(name, args, { role: 'authenticated', userId: null }), /仅指定管理员/);
  }
  const definitions = await db.query(`select p.proname,p.prosecdef,p.proconfig
    from pg_proc p join pg_namespace n on p.pronamespace=n.oid
    where n.nspname='public' and p.proname like 'h41_%'`);
  assert.equal(definitions.rows.length, 8);
  assert.ok(definitions.rows.every(row => row.prosecdef && row.proconfig.includes('search_path=""')));
});

test('both none saves one successful submission without empty outcomes; supplement none preserves existing outcomes', async () => {
  const receipt = await submit();
  assert.match(receipt.receipt_id, /^[0-9a-f-]{36}$/);
  assert.ok(Date.parse(receipt.submitted_at));
  assert.deepEqual(await counts(), { submissions: 1, activities: 0, awards: 0 });
  await submit(form({ hasActivities: true, activities: [{ category: 'SRT项目', name: '  项目一\n' }] }));
  await submit();
  assert.deepEqual(await counts(), { submissions: 3, activities: 1, awards: 0 });
  assert.equal((await data()).activities[0].name, '项目一');
  assert.equal((await effective()).submitted, 1);
  assert.equal((await effective()).participants, 1);
});

test('server rejects inconsistent flags, invalid payloads, invalid categories/months, row and byte limits atomically', async () => {
  const cases = [
    { hasActivities: null },
    { hasAwards: null },
    { hasActivities: true },
    { activities: [{ category: 'SRT项目', name: '隐藏行' }] },
    { awards: [{ month: '2026-01', name: '隐藏行' }] },
    { activities: null },
    { awards: {} },
    { hasActivities: true, activities: [{ category: '错误类别', name: '活动' }] },
    { hasActivities: true, activities: [{ category: 'SRT项目', name: '\u3000\t\n\u00a0' }] },
    { hasActivities: true, activities: [{ category: 'SRT项目', name: 123 }] },
    { hasActivities: true, activities: [{ category: 'SRT项目', name: '项目', unknown: '禁止字段' }] },
    { hasActivities: true, activities: [{ category: 'SRT项目', name: '长'.repeat(201) }] },
    { hasActivities: true, activities: Array.from({ length: 41 }, () => ({ category: 'SRT项目', name: '项目' })) },
    { hasAwards: true, awards: [{ month: '2026-13', name: '奖项' }] },
    { hasAwards: true, awards: [{ month: '2026-1', name: '奖项' }] },
    { hasAwards: true, awards: [{ month: '1899-12', name: '奖项' }] },
    { hasAwards: true, awards: [{ month: '2101-01', name: '奖项' }] },
    { hasAwards: true, awards: [{ month: '2026-01', name: ' ' }] },
    { hasAwards: true, awards: [{ month: '2026-01', name: '长'.repeat(201) }] },
    { hasAwards: true, awards: Array.from({ length: 41 }, () => ({ month: '2026-01', name: '奖项' })) },
    { hasActivities: true, activities: [{ category: 'SRT项目', name: '大'.repeat(30000) }] },
    { studentId: STUDENT_C },
  ];
  for (const invalid of cases) {
    await assert.rejects(submit(form(invalid)));
    assert.deepEqual(await counts(), { submissions: 0, activities: 0, awards: 0 });
  }
  // Activity insertion succeeds inside RPC, then invalid award must roll it all back.
  await assert.rejects(submit(form({ hasActivities: true, hasAwards: true,
    activities: [{ category: 'SRT项目', name: '本应回滚的活动' }], awards: [{ month: '2026-99', name: '无效月份' }] })));
  assert.deepEqual(await counts(), { submissions: 0, activities: 0, awards: 0 });
});

test('idempotent retry returns the same receipt, rejects changed content, and preserves original payload after admin edits', async () => {
  const payload = form({ hasActivities: true, hasAwards: true,
    activities: [{ category: 'SRT项目', name: '原活动' }], awards: [{ month: '2026-01', name: '原奖项' }] });
  const receipt = await submit(payload);
  assert.deepEqual(await submit(payload), receipt);
  await assert.rejects(submit({ ...payload, studentId: STUDENT_B }), /同一请求标识/);
  await assert.rejects(submit({ ...payload, collectionId: OTHER_COLLECTION, studentId: STUDENT_C }), /同一请求标识/);
  const stored = await data();
  await rpc('h41_update_submission', [receipt.receipt_id, STUDENT_B, true]);
  await rpc('h41_update_activity', [stored.activities[0].id, '各类竞赛', '更正活动', true]);
  await rpc('h41_update_award', [stored.awards[0].id, '2026-02', '更正奖项', true]);
  assert.deepEqual(await submit(payload), receipt);
  assert.deepEqual(await counts(), { submissions: 1, activities: 1, awards: 1 });
  assert.ok(!('request_payload' in (await data()).submissions[0]));
});

test('deduplication is per collection and student; multiple activities in one class count a student once', async () => {
  const payload = form({ hasActivities: true, hasAwards: true,
    activities: [
      { category: 'SRT项目', name: '项目一' },
      { category: 'SRT项目', name: '项目二' },
      { category: '各类竞赛', name: '比赛' },
    ], awards: [{ month: '2026-01', name: '团队二等奖' }] });
  await submit(payload);
  await submit({ ...payload, requestId: randomUUID() });
  await submit({ ...payload, requestId: randomUUID(), studentId: STUDENT_B });
  await submit({ ...payload, requestId: randomUUID(), collectionId: OTHER_COLLECTION, studentId: STUDENT_C });
  assert.deepEqual(await effective(), { submitted: 2, participants: 2, activity_items: 6,
    srt: 2, competitions: 2, award_students: 2, award_items: 2 });
  assert.deepEqual(await counts(), { submissions: 4, activities: 12, awards: 4 });
});

test('editing, voiding and restoring an activity or award handles its complete duplicate group', async () => {
  const payload = form({ hasActivities: true, hasAwards: true,
    activities: [{ category: 'SRT项目', name: '重复活动' }], awards: [{ month: '2026-01', name: '重复奖项' }] });
  await submit(payload);
  await submit({ ...payload, requestId: randomUUID() });
  const original = await data();
  await rpc('h41_update_submission', [original.submissions[1].id, STUDENT_A, true]);
  await rpc('h41_update_activity', [original.activities[0].id, '各类竞赛', '更正活动', true]);
  await rpc('h41_update_award', [original.awards[0].id, '2026-02', '更正奖项', true]);
  let updated = await data();
  assert.ok(updated.activities.every(a => a.category === '各类竞赛' && a.name === '更正活动' && a.is_void));
  assert.ok(updated.awards.every(a => a.month === '2026-02' && a.name === '更正奖项' && a.is_void));
  assert.equal((await effective()).participants, 0);
  assert.equal((await effective()).award_items, 0);
  // Restoring a submission must not bypass independently voided details.
  await rpc('h41_update_submission', [original.submissions[1].id, STUDENT_A, false]);
  assert.equal((await effective()).participants, 0);
  await rpc('h41_update_activity', [original.activities[1].id, '各类竞赛', '更正活动', false]);
  await rpc('h41_update_award', [original.awards[1].id, '2026-02', '更正奖项', false]);
  updated = await data();
  assert.ok(updated.activities.every(a => !a.is_void));
  assert.ok(updated.awards.every(a => !a.is_void));
  assert.deepEqual(await effective(), { submitted: 1, participants: 1, activity_items: 1,
    srt: 0, competitions: 1, award_students: 1, award_items: 1 });
});

test('correcting a mistaken name moves the entire submission; voiding updates progress and all outcomes', async () => {
  const receipt = await submit(form({ hasActivities: true, hasAwards: true,
    activities: [{ category: 'SRT项目', name: '活动一' }, { category: '各类竞赛', name: '活动二' }],
    awards: [{ month: '2026-01', name: '奖项一' }, { month: '2026-02', name: '奖项二' }] }));
  await rpc('h41_update_submission', [receipt.receipt_id, STUDENT_B, false]);
  const owners = await db.query(`select distinct s.student_id from h41.submissions s
    left join h41.activities a on a.submission_id=s.id left join h41.awards w on w.submission_id=s.id`);
  assert.deepEqual(owners.rows, [{ student_id: STUDENT_B }]);
  await assert.rejects(rpc('h41_update_submission', [receipt.receipt_id, STUDENT_C, false]), /本次名单/);
  await rpc('h41_update_submission', [receipt.receipt_id, STUDENT_B, true]);
  assert.deepEqual(await effective(), { submitted: 0, participants: 0, activity_items: 0,
    srt: 0, competitions: 0, award_students: 0, award_items: 0 });
  assert.deepEqual(await counts(), { submissions: 1, activities: 2, awards: 2 });
  await rpc('h41_update_submission', [receipt.receipt_id, STUDENT_B, false]);
  assert.equal((await effective()).activity_items, 2);
  assert.equal((await effective()).award_items, 2);
});

test('closing rejects direct new submissions but existing requests keep their receipts', async () => {
  const payload = form();
  const receipt = await submit(payload);
  await rpc('h41_save_settings', [COLLECTION, '关闭测试', '活动范围', '获奖范围', false]);
  assert.equal((await rpc('h41_public_form', [COLLECTION], { role: 'anon', userId: null })).collection.is_open, false);
  await assert.rejects(submit(), /尚未开放或已经结束/);
  assert.deepEqual(await submit(payload), receipt);
  await assert.rejects(submit({ ...payload, studentId: STUDENT_B }), /同一请求标识/);
  assert.deepEqual(await counts(), { submissions: 1, activities: 0, awards: 0 });
});

test('opening requires roster and award scope; names stay stable across rename and exclusion', async () => {
  const receipt = await submit();
  await rpc('h41_upsert_student', [COLLECTION, STUDENT_A, ' 张同学（甲） ', false]);
  await assert.rejects(submit(), /有效姓名/);
  assert.equal((await effective()).submitted, 0);
  assert.equal((await data()).submissions[0].student_id, STUDENT_A);
  assert.equal((await data()).submissions[0].id, receipt.receipt_id);
  await assert.rejects(rpc('h41_upsert_student', [COLLECTION, STUDENT_B, '李同学', false]), /先关闭/);
  await rpc('h41_save_settings', [COLLECTION, '标题', '活动范围', '', false]);
  await assert.rejects(rpc('h41_save_settings', [COLLECTION, '标题', '活动范围', ' \u3000 ', true]), /开放前/);
  await rpc('h41_upsert_student', [COLLECTION, STUDENT_B, '李同学', false]);
  await assert.rejects(rpc('h41_save_settings', [COLLECTION, '标题', '活动范围', '明确范围', true]), /开放前/);
  await rpc('h41_upsert_student', [COLLECTION, STUDENT_A, '张同学（甲）', true]);
  await rpc('h41_save_settings', [COLLECTION, '标题', '活动范围', '明确范围', true]);
  assert.equal((await effective()).submitted, 1);
  const newStudent = await rpc('h41_upsert_student', [COLLECTION, null, '张同学（乙）', true]);
  assert.notEqual(newStudent.student_id, STUDENT_A);
  const roster = (await data()).students;
  assert.equal(roster.length, 3);
  assert.equal(roster.find(student => student.id === STUDENT_A).display_name, '张同学（甲）');
});

test('administrator updates enforce the same text and date constraints without partial changes', async () => {
  await submit(form({ hasActivities: true, hasAwards: true,
    activities: [{ category: 'SRT项目', name: '活动' }], awards: [{ month: '2026-01', name: '奖项' }] }));
  const original = await data();
  const badCalls = [
    ['h41_save_settings', [COLLECTION, '题'.repeat(121), '范围', '范围', true]],
    ['h41_save_settings', [COLLECTION, '标题', '围'.repeat(2001), '范围', true]],
    ['h41_save_settings', [COLLECTION, '标题', '范围', '围'.repeat(2001), true]],
    ['h41_upsert_student', [COLLECTION, STUDENT_A, '名'.repeat(81), true]],
    ['h41_upsert_student', [COLLECTION, STUDENT_C, '跨批次', true]],
    ['h41_update_activity', [original.activities[0].id, '不存在的类别', '活动', false]],
    ['h41_update_activity', [original.activities[0].id, 'SRT项目', ' ', false]],
    ['h41_update_award', [original.awards[0].id, '2026-00', '奖项', false]],
    ['h41_update_award', [original.awards[0].id, '2026-01', '奖'.repeat(201), false]],
  ];
  for (const [name, args] of badCalls) await assert.rejects(rpc(name, args));
  assert.deepEqual(await data(), original);
});

test('domain and SQL agree on mixed void duplicate groups, including new supplements and voided parent submissions', async () => {
  const payload = form({ hasActivities: true, hasAwards: true,
    activities: [{ category: 'SRT项目', name: '重复活动' }], awards: [{ month: '2026-01', name: '重复奖项' }] });
  const first = await submit(payload);
  let view = await assertDerivedMatchesDatabase();
  await rpc('h41_update_activity', [view.activities[0].id, 'SRT项目', '重复活动', true]);
  await rpc('h41_update_award', [view.awards[0].id, '2026-01', '重复奖项', true]);
  const second = await submit({ ...payload, requestId: randomUUID() });
  view = await assertDerivedMatchesDatabase();
  assert.equal(view.activities.length, 1);
  assert.equal(view.activities[0].ids.length, 2);
  assert.equal(view.activities[0].is_void, false);
  assert.equal(view.awards[0].is_void, false);
  const raw = await data();
  assert.equal(raw.activities.find(item => item.id === view.activities[0].id).submission_id, second.receipt_id);
  assert.equal(raw.awards.find(item => item.id === view.awards[0].id).submission_id, second.receipt_id);

  await rpc('h41_update_submission', [first.receipt_id, STUDENT_A, true]);
  await rpc('h41_update_activity', [view.activities[0].id, '各类竞赛', '整理后的活动', true]);
  await rpc('h41_update_award', [view.awards[0].id, '2026-02', '整理后的奖项', true]);
  view = await assertDerivedMatchesDatabase();
  assert.equal(view.activities[0].ids.length, 2);
  assert.equal(view.activities[0].is_void, true);
  assert.equal(view.activities[0].void_by_submission, false);
  await rpc('h41_update_submission', [first.receipt_id, STUDENT_A, false]);
  view = await assertDerivedMatchesDatabase();
  assert.equal(view.counts.participants, 0);
  assert.equal(view.counts.awardees, 0);

  await rpc('h41_update_activity', [view.activities[0].id, '各类竞赛', '整理后的活动', false]);
  await rpc('h41_update_award', [view.awards[0].id, '2026-02', '整理后的奖项', false]);
  await rpc('h41_update_submission', [first.receipt_id, STUDENT_A, true]);
  await rpc('h41_update_submission', [second.receipt_id, STUDENT_A, true]);
  view = await assertDerivedMatchesDatabase();
  assert.equal(view.activities[0].is_void, true);
  assert.equal(view.activities[0].void_by_submission, true);
  assert.equal(view.counts.submitted, 0);
  await rpc('h41_update_submission', [first.receipt_id, STUDENT_A, false]);
  view = await assertDerivedMatchesDatabase();
  assert.equal(view.activities[0].is_void, false);
  assert.equal(view.activities[0].void_by_submission, false);
  assert.equal(view.counts.participants, 1);
  assert.equal(view.counts.award_items, 1);
});

test('editing into an existing key merges groups; later group void and restore affect every merged original', async () => {
  await submit(form({ hasActivities: true, hasAwards: true,
    activities: [{ category: 'SRT项目', name: '旧名称' }, { category: '各类竞赛', name: '统一名称' }],
    awards: [{ month: '2026-01', name: '旧奖项' }, { month: '2026-02', name: '统一奖项' }] }));
  let view = await assertDerivedMatchesDatabase();
  const activity = view.activities.find(item => item.name === '旧名称');
  const award = view.awards.find(item => item.name === '旧奖项');
  await rpc('h41_update_activity', [activity.id, '各类竞赛', '统一名称', false]);
  await rpc('h41_update_award', [award.id, '2026-02', '统一奖项', false]);
  view = await assertDerivedMatchesDatabase();
  assert.equal(view.activities.length, 1);
  assert.equal(view.awards.length, 1);
  assert.equal(view.activities[0].ids.length, 2);
  assert.equal(view.awards[0].ids.length, 2);
  await rpc('h41_update_activity', [view.activities[0].id, '各类竞赛', '统一名称', true]);
  await rpc('h41_update_award', [view.awards[0].id, '2026-02', '统一奖项', true]);
  view = await assertDerivedMatchesDatabase();
  assert.equal(view.counts.participants, 0);
  assert.equal(view.counts.award_items, 0);
  assert.ok((await data()).activities.every(item => item.is_void));
  assert.ok((await data()).awards.every(item => item.is_void));
  await rpc('h41_update_activity', [activity.id, '各类竞赛', '统一名称', false]);
  await rpc('h41_update_award', [award.id, '2026-02', '统一奖项', false]);
  view = await assertDerivedMatchesDatabase();
  assert.equal(view.counts.participants, 1);
  assert.equal(view.counts.award_items, 1);
});

test('excluded members keep reviewable data and identity, but all progress and outcome totals exclude them', async () => {
  const payload = form({ hasActivities: true, hasAwards: true,
    activities: [{ category: 'SRT项目', name: '同一项目' }], awards: [{ month: '2026-01', name: '同一团队奖' }] });
  await submit(payload);
  await submit({ ...payload, requestId: randomUUID(), studentId: STUDENT_B });
  // Even identical displayed names cannot merge the underlying students.
  // Simulate legacy imported same-name records; new RPC writes require disambiguated names.
  await db.query('update h41.students set display_name=$1 where collection_id=$2', ['同名同学', COLLECTION]);
  let view = await assertDerivedMatchesDatabase();
  assert.equal(view.activities.length, 2);
  assert.equal(view.counts.participants, 2);
  assert.equal(view.counts.award_items, 2);
  await rpc('h41_upsert_student', [COLLECTION, STUDENT_A, '同名同学（甲）', false]);
  view = await assertDerivedMatchesDatabase();
  assert.equal(view.counts.expected, 1);
  assert.equal(view.counts.submitted, 1);
  assert.equal(view.counts.participants, 1);
  assert.equal(view.counts.awardees, 1);
  assert.equal(view.counts.award_items, 1);
  assert.equal(view.activities.length, 2);
  assert.equal(view.activities.find(item => item.student_id === STUDENT_A).included, false);
  assert.equal(view.progress.find(item => item.student_id === STUDENT_A).submitted, true);
  await rpc('h41_upsert_student', [COLLECTION, STUDENT_A, '同名同学（甲）', true]);
  view = await assertDerivedMatchesDatabase();
  assert.equal(view.counts.submitted, 2);
  assert.equal(view.counts.participants, 2);
  assert.equal(view.counts.award_items, 2);
});

test('repeating a roster creation after an uncertain response cannot create a second student; rename collisions also reject', async () => {
  const created = await rpc('h41_upsert_student', [COLLECTION, null, '  王同学  ', true]);
  const beforeRetry = (await data()).students;
  assert.equal(beforeRetry.length, 3);
  await assert.rejects(rpc('h41_upsert_student', [COLLECTION, null, '王同学', true]), /名单已有此显示姓名/);
  await assert.rejects(rpc('h41_upsert_student', [COLLECTION, null, '\u3000王同学\t', false]), /名单已有此显示姓名/);
  await assert.rejects(rpc('h41_upsert_student', [COLLECTION, STUDENT_A, '王同学', true]), /名单已有此显示姓名/);
  assert.deepEqual((await data()).students, beforeRetry);
  await rpc('h41_upsert_student', [COLLECTION, created.student_id, '王同学', true]);
  await rpc('h41_upsert_student', [COLLECTION, created.student_id, '王同学（甲）', false]);
  await assert.rejects(rpc('h41_upsert_student', [COLLECTION, null, '王同学（甲）', true]), /名单已有此显示姓名/);
  // Same display name in another collection does not refer to the same roster member.
  const other = await rpc('h41_upsert_student', [OTHER_COLLECTION, null, '王同学（甲）', true]);
  assert.notEqual(other.student_id, created.student_id);
  assert.equal((await data()).students.length, 3);
});
