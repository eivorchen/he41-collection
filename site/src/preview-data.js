// Synthetic fixtures are reachable only through the localhost development preview.
export function makePreviewData() {
  const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  return {
    collection: { id: '41414141-2026-4000-8000-000000000001', title: '核41班优良学风班申报信息收集', activity_scope: '2025.8-今', award_scope: '2025.8-今', is_open: true },
    students: [
      { id: id(1), display_name: '示例同学甲', included: true },
      { id: id(2), display_name: '示例同学乙', included: true },
      { id: id(3), display_name: '示例同学丙', included: true },
      { id: id(4), display_name: '示例同学丁', included: true },
    ],
    submissions: [
      { id: id(11), request_id: id(101), student_id: id(1), has_activities: true, has_awards: true, submitted_at: '2026-10-19T02:30:00Z', is_void: false },
      { id: id(12), request_id: id(102), student_id: id(2), has_activities: true, has_awards: false, submitted_at: '2026-10-19T03:10:00Z', is_void: false },
      { id: id(13), request_id: id(103), student_id: id(3), has_activities: false, has_awards: false, submitted_at: '2026-10-19T03:45:00Z', is_void: false },
    ],
    activities: [
      { id: id(21), submission_id: id(11), category: 'SRT项目', name: '材料性能研究（示例）', is_void: false },
      { id: id(22), submission_id: id(11), category: '课外体育活动', name: '班级体育联赛（示例）', is_void: false },
      { id: id(23), submission_id: id(12), category: '课外文化活动', name: '校园合唱活动（示例）', is_void: false },
    ],
    awards: [{ id: id(31), submission_id: id(11), month: '2026-05', name: '学科竞赛二等奖（示例）', is_void: false }],
  };
}
