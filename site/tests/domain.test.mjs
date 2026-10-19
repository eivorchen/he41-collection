import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveData, validateSubmission, CATEGORIES } from '../src/domain.js';
import { toCsv } from '../src/csv.js';
import { makePreviewData } from '../src/preview-data.js';

test('two empty answers are valid, unanswered and contradictory fields are rejected', () => {
  const payload = { student_id: '00000000-0000-4000-8000-000000000001', has_activities: false, has_awards: false, activities: [], awards: [] };
  assert.deepEqual(validateSubmission(payload), []);
  assert.ok(validateSubmission({ ...payload, has_activities: null }).some(e => e.field === 'has_activities'));
  assert.ok(validateSubmission({ ...payload, has_awards: true }).some(e => e.field === 'awards'));
  assert.ok(validateSubmission({ ...payload, activities: [{ category: CATEGORIES[0], name: '活动' }] }).some(e => e.field === 'activities'));
});

test('validation locates invalid month/category/name and limits Unicode characters', () => {
  const payload = { student_id: '00000000-0000-4000-8000-000000000001', has_activities: true, has_awards: true, activities: [{ category: '其他', name: '  ' }], awards: [{ month: '2026-13', name: '🚀'.repeat(201) }] };
  assert.deepEqual(validateSubmission(payload).map(e => e.field), ['activities.0.category', 'activities.0.name', 'awards.0.month', 'awards.0.name']);
  payload.activities = [{ category: CATEGORIES[0], name: 'SRT' }];
  payload.awards = [{ month: '2026-05', name: '🚀'.repeat(200) }];
  assert.deepEqual(validateSubmission(payload), []);
});

test('multiple activities in a category and duplicate submissions count one student', () => {
  const raw = makePreviewData();
  raw.activities.push({ ...raw.activities[0], id: 'duplicate' }, { ...raw.activities[0], id: 'different', name: '另一项SRT' });
  const view = deriveData(raw);
  assert.equal(view.counts.submitted, 3); // includes the student answering no/no
  assert.equal(view.counts.missing, 1);
  assert.equal(view.counts.participants, 2);
  assert.equal(view.categoryCounts[0].count, 1);
  assert.equal(view.activities.length, 4);
  assert.equal(view.activities.find(r => r.name === raw.activities[0].name).ids.length, 2);
});

test('same team award for different students remains two personal records', () => {
  const raw = makePreviewData();
  raw.awards.push({ ...raw.awards[0], id: 'team-other-student', submission_id: raw.submissions[1].id });
  const view = deriveData(raw);
  assert.equal(view.counts.awardees, 2);
  assert.equal(view.counts.award_items, 2);
});

test('whole submission voiding changes progress and every dependent result', () => {
  const raw = makePreviewData();
  raw.submissions[0].is_void = true;
  const view = deriveData(raw);
  assert.equal(view.counts.submitted, 2);
  assert.equal(view.counts.participants, 1);
  assert.equal(view.counts.awardees, 0);
  assert.equal(view.awards[0].is_void, true);
  assert.equal(view.awards[0].void_by_submission, true);
});

test('excluded members stay inspectable but never inflate active collection counts', () => {
  const raw = makePreviewData();
  raw.students[0].included = false;
  const view = deriveData(raw);
  assert.equal(view.counts.expected, 3);
  assert.equal(view.counts.submitted, 2);
  assert.equal(view.counts.award_items, 0);
  assert.equal(view.activities.filter(r => r.included).length, 1);
  assert.equal(view.progress.length, 4);
});

test('same display names do not merge stable student identities', () => {
  const raw = makePreviewData();
  raw.students[1].display_name = raw.students[0].display_name;
  raw.activities[2].category = raw.activities[0].category;
  raw.activities[2].name = raw.activities[0].name;
  const view = deriveData(raw);
  assert.equal(view.counts.participants, 2);
  assert.equal(view.categoryCounts[0].count, 2);
});

test('mixed void duplicates remain valid until all matching records are void', () => {
  const raw = makePreviewData();
  raw.awards.push({ ...raw.awards[0], id: 'duplicate-award', is_void: true });
  assert.equal(deriveData(raw).counts.award_items, 1);
  raw.awards[0].is_void = true;
  assert.equal(deriveData(raw).counts.award_items, 0);
});

test('CSV carries UTF-8 BOM, quoting, multiline cells and formula neutralization', () => {
  const csv = toCsv(['姓名', '名称'], [['同学', '含"引号",逗号\n换行'], ['=1+1', '  @SUM(A1)'], ['普通内容', '-123']]);
  assert.ok(csv.startsWith('\uFEFF'));
  assert.ok(csv.includes('"含""引号"",逗号\n换行"'));
  assert.ok(csv.includes('"\'=1+1"'));
  assert.ok(csv.includes('"\'  @SUM(A1)"'));
  assert.ok(csv.includes('"\'-123"'));
  assert.ok(csv.endsWith('\r\n'));
});
