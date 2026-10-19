export const CATEGORIES = Object.freeze(['SRT项目', '各类竞赛', '课外科技活动', '课外文化活动', '课外体育活动']);
export const LIMITS = Object.freeze({ rows: 40, name: 200, student: 80, title: 120, scope: 2000 });
export const MONTH_PATTERN = /^(19\d{2}|20\d{2}|2100)-(0[1-9]|1[0-2])$/;
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function newRequestId() {
  return crypto.randomUUID();
}

export function validateSubmission(payload) {
  const errors = [];
  const add = (field, message) => errors.push({ field, message });
  if (!UUID_PATTERN.test(payload.student_id || '')) add('student_id', '请选择你的姓名。');
  for (const [key, flag, label] of [['activities', 'has_activities', '活动'], ['awards', 'has_awards', '获奖']]) {
    if (typeof payload[flag] !== 'boolean') add(flag, `请选择是否有${label}信息。`);
    const rows = payload[key];
    if (!Array.isArray(rows)) { add(key, `请检查${label}内容。`); continue; }
    if (rows.length > LIMITS.rows) add(key, `每次最多填写${LIMITS.rows}项${label}，其他内容可另行补充。`);
    if (payload[flag] === true && !rows.length) add(key, `请至少添加一项${label}。`);
    if (payload[flag] === false && rows.length) add(key, `选择“无”时不能同时提交${label}明细。`);
    rows.forEach((row, index) => {
      const path = `${key}.${index}`;
      if (key === 'activities' && !CATEGORIES.includes(row?.category)) add(`${path}.category`, '请选择活动类别。');
      if (key === 'awards' && !MONTH_PATTERN.test(row?.month || '')) add(`${path}.month`, '请选择有效的获奖年月（1900—2100年）。');
      if (typeof row?.name !== 'string' || !row.name.trim()) add(`${path}.name`, `请填写${label === '活动' ? '活动或项目名称' : '奖项完整名称'}。`);
      else if ([...row.name.trim()].length > LIMITS.name) add(`${path}.name`, `名称不能超过${LIMITS.name}字。`);
    });
  }
  return errors;
}

/** All counts, visible valid rows and exports derive from the same effective records. */
export function deriveData(raw) {
  const students = raw.students || [];
  const byStudent = new Map(students.map(s => [s.id, s]));
  const submissions = (raw.submissions || []).map(s => ({ ...s, display_name: byStudent.get(s.student_id)?.display_name || '名单外成员', included: byStudent.get(s.student_id)?.included === true }));
  const bySubmission = new Map(submissions.map(s => [s.id, s]));
  const group = (records, kind) => {
    const groups = new Map();
    for (const item of records || []) {
      const submission = bySubmission.get(item.submission_id);
      if (!submission) continue;
      const student = byStudent.get(submission.student_id);
      const key = JSON.stringify([submission.student_id, kind === 'activity' ? item.category : item.month, item.name]);
      const effective = !item.is_void && !submission.is_void;
      let entry = groups.get(key);
      if (!entry) {
        entry = { ...item, student_id: submission.student_id, display_name: student?.display_name || '名单外成员', included: student?.included === true, is_void: true, ids: [], submission_ids: [], void_by_submission: true };
        groups.set(key, entry);
      }
      entry.ids.push(item.id);
      if (!entry.submission_ids.includes(submission.id)) entry.submission_ids.push(submission.id);
      if (!submission.is_void) entry.void_by_submission = false;
      if (effective) { entry.is_void = false; entry.id = item.id; }
    }
    return [...groups.values()].sort((a, b) => a.display_name.localeCompare(b.display_name, 'zh-CN') || a.name.localeCompare(b.name, 'zh-CN'));
  };
  const activities = group(raw.activities, 'activity');
  const awards = group(raw.awards, 'award');
  const validActivities = activities.filter(r => !r.is_void && r.included);
  const validAwards = awards.filter(r => !r.is_void && r.included);
  const progress = students.map(student => {
    const valid = submissions.filter(s => s.student_id === student.id && !s.is_void);
    const timestamps = valid.map(s => s.submitted_at).filter(Boolean).sort();
    return { student_id: student.id, display_name: student.display_name, included: student.included, submitted: valid.length > 0, last_submitted_at: timestamps.at(-1) || null };
  });
  const expected = progress.filter(p => p.included);
  const submitted = expected.filter(p => p.submitted).length;
  return {
    collection: raw.collection,
    students, submissions, progress, activities, awards,
    counts: {
      expected: expected.length, submitted, missing: expected.length - submitted,
      participants: new Set(validActivities.map(a => a.student_id)).size,
      awardees: new Set(validAwards.map(a => a.student_id)).size,
      award_items: validAwards.length,
    },
    categoryCounts: CATEGORIES.map(category => ({ category, count: new Set(validActivities.filter(a => a.category === category).map(a => a.student_id)).size })),
  };
}
