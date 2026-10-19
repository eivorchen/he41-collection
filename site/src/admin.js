import './styles.css';
import './admin.css';
import { api, errorMessage } from './api.js';
import { CATEGORIES, LIMITS, MONTH_PATTERN, deriveData } from './domain.js';
import { downloadCsv } from './csv.js';

const $ = (id) => document.getElementById(id);
const state = { raw: null, data: null, session: null, epoch: 0, loading: false, modal: null, modalBusy: false, logoutBusy: false, locallySignedOut: false };
const isPreview = api.mode === 'preview';
const dateFormatter = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });

function node(tag, text, className) {
  const el = document.createElement(tag);
  if (text !== undefined && text !== null) el.textContent = String(text);
  if (className) el.className = className;
  return el;
}

function showMessage(id, message) {
  const el = $(id);
  el.textContent = message || '';
  el.hidden = !message;
}

function notify(message, tone = 'info') {
  $('global-status').dataset.tone = tone;
  showMessage('global-status', message);
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : dateFormatter.format(date);
}

function busy(button, value, text) {
  if (value) {
    button.dataset.label = button.textContent;
    button.textContent = text || '正在保存…';
    button.disabled = true;
  } else {
    button.textContent = button.dataset.label || button.textContent;
    button.disabled = isPreview && button.hasAttribute('data-write');
  }
}

function limitText(input, maxLength, label) {
  input.removeAttribute('maxlength');
  const validate = () => input.setCustomValidity([...input.value.trim()].length > maxLength ? `${label}不能超过 ${maxLength} 字。` : '');
  input.addEventListener('input', validate);
  validate();
}

function requireLength(value, maxLength, label) {
  if ([...value].length > maxLength) throw new Error(`${label}不能超过 ${maxLength} 字。`);
}

function handleWriteError(error, target) {
  const code = String(error?.code || '');
  const status = Number(error?.status || error?.statusCode || 0);
  const message = String(error?.message || '');
  const accessDenied = ['42501', '401', '403', 'PGRST301', 'PGRST302', 'PGRST303'].includes(code)
    || [401, 403].includes(status)
    || /jwt|permission denied|unauthori[sz]ed|not authori[sz]ed|forbidden|token.*expir|无权|权限不足|没有.*权限|无.*权限|未授权|未登录|登录.*(?:过期|失效)/i.test(message);
  if (accessDenied) {
    clearData();
    state.session = null;
    state.locallySignedOut = true;
    $('logout').hidden = true;
    $('login-section').hidden = false;
    notify('当前管理权限已失效或账号无权执行该操作，页面数据已清除。请重新登录已获授权的管理员账号。', 'error');
    return true;
  }
  showMessage(target, errorMessage(error));
  return false;
}

function setOptions(select, options, placeholder) {
  const value = select.value;
  select.replaceChildren();
  if (placeholder) select.append(new Option(placeholder, ''));
  options.forEach(({ value: optionValue, label }) => select.append(new Option(label, optionValue)));
  if (Array.from(select.options).some((option) => option.value === value)) select.value = value;
}

function metric(container, values) {
  container.replaceChildren();
  values.forEach(([label, count, unit = '人']) => {
    const item = node('div');
    const number = node('dd', count ?? 0);
    number.append(node('small', unit));
    item.append(node('dt', label), number);
    container.append(item);
  });
}

function table(container, headers, rows, empty) {
  const el = node('table');
  const head = node('thead');
  const headRow = node('tr');
  headers.forEach((label) => {
    const cell = node('th', label);
    cell.scope = 'col';
    headRow.append(cell);
  });
  head.append(headRow);
  const body = node('tbody');
  rows.forEach((row) => {
    const tr = node('tr');
    row.forEach((value) => {
      const td = node('td');
      if (value instanceof Node) td.append(value);
      else if (typeof value === 'object' && value !== null) {
        if (value.node) td.append(value.node);
        else td.textContent = String(value.text ?? '');
        if (value.className) td.className = value.className;
      } else td.textContent = String(value ?? '');
      tr.append(td);
    });
    body.append(tr);
  });
  if (!rows.length) {
    const tr = node('tr');
    const td = node('td', empty || '暂无记录。', 'a-empty');
    td.colSpan = headers.length;
    tr.append(td);
    body.append(tr);
  }
  el.append(head, body);
  container.replaceChildren(el);
}

function editButton(label, callback) {
  const button = node('button', label, 'a-text-button');
  button.type = 'button';
  button.addEventListener('click', callback);
  return { node: button, className: 'a-cell-action' };
}

function personCell(record) {
  const wrap = node('span', record.display_name || '未知成员');
  if (record.included === false) wrap.append(node('small', '未纳入本次统计', 'a-row-note'));
  return wrap;
}

function includeForView(record, filter) {
  if (filter === 'effective') return !record.is_void && record.included !== false;
  if (filter === 'void') return record.is_void;
  if (filter === 'excluded') return record.included === false;
  return true;
}

function renderProgress() {
  if (!state.data) return;
  const { counts, progress } = state.data;
  metric($('progress-metrics'), [['应填人数', counts.expected], ['已填人数', counts.submitted], ['未填人数', counts.missing]]);
  const query = $('progress-search').value.trim().toLocaleLowerCase();
  const filter = $('progress-status').value;
  const members = $('progress-members').value;
  const filtered = progress.filter((item) => (
    (!query || item.display_name.toLocaleLowerCase().includes(query))
    && (filter === 'all' || (filter === 'submitted' ? item.submitted : !item.submitted))
    && (members === 'all' || (members === 'included' ? item.included : !item.included))
  ));
  $('progress-result').textContent = `${filtered.length} 位同学`;
  table($('progress-table'), ['姓名', '填报状态', '最近有效提交时间'], filtered.map((item) => [
    personCell(item), node('span', item.submitted ? '已填报' : '未填报', item.submitted ? 'a-state-submitted' : 'a-state-missing'),
    { text: formatDate(item.last_submitted_at), className: 'a-cell-date' },
  ]), progress.length ? '没有符合当前筛选条件的同学。' : '名单尚未录入，请先到基础设置添加班级成员。');
}

function renderSubmissions() {
  if (!state.data) return;
  const person = $('submission-person').value;
  const filter = $('submission-status').value;
  const rows = state.data.submissions
    .filter((item) => (!person || item.student_id === person) && (filter === 'all' || (filter === 'void' ? item.is_void : !item.is_void)))
    .sort((a, b) => String(b.submitted_at).localeCompare(String(a.submitted_at)));
  table($('submissions-table'), ['提交时间', '姓名', '活动 / 获奖', '状态', '回执编号', '操作'], rows.map((item) => [
    { text: formatDate(item.submitted_at), className: 'a-cell-date' },
    personCell({ ...item, included: state.data.students.find((student) => student.id === item.student_id)?.included }),
    `${item.has_activities ? '有活动' : '无活动'} / ${item.has_awards ? '有获奖' : '无获奖'}`,
    item.is_void ? '已作废' : '有效',
    { text: item.id, className: 'a-row-muted' },
    editButton('整理', () => openEditor('submission', item)),
  ]), '没有符合当前条件的提交记录。');
}

function renderActivities() {
  if (!state.data) return;
  const { counts, categoryCounts, activities } = state.data;
  metric($('activity-metrics'), [['总参与人数', counts.participants], ...categoryCounts.map((item) => [item.category, item.count])]);
  const person = $('activity-person').value;
  const category = $('activity-category').value;
  const filter = $('activity-state').value;
  const rows = activities.filter((item) => (!person || item.student_id === person) && (!category || item.category === category) && includeForView(item, filter));
  $('activity-result').textContent = `${rows.length} 条明细`;
  table($('activities-table'), ['姓名', '活动类别', '活动或项目名称', '状态', '操作'], rows.map((item) => [
    personCell(item), item.category, { text: item.name, className: 'a-cell-name' },
    item.void_by_submission ? '所属提交已作废' : item.is_void ? '已作废' : item.included === false ? '未纳入统计' : '有效',
    editButton('整理', () => openEditor('activity', item)),
  ]), '没有符合当前条件的活动明细。');
}

function renderAwards() {
  if (!state.data) return;
  const { counts, awards } = state.data;
  metric($('award-metrics'), [['获奖人数', counts.awardees], ['个人获奖明细', counts.award_items, '条']]);
  const person = $('award-person').value;
  const filter = $('award-state').value;
  const direction = $('award-sort').value === 'asc' ? 1 : -1;
  const rows = awards.filter((item) => (!person || item.student_id === person) && includeForView(item, filter))
    .sort((a, b) => direction * a.month.localeCompare(b.month) || a.display_name.localeCompare(b.display_name, 'zh-CN'));
  $('award-result').textContent = `${rows.length} 条明细`;
  table($('awards-table'), ['获奖年月', '奖项完整名称', '姓名', '状态', '操作'], rows.map((item) => [
    item.month, { text: item.name, className: 'a-cell-name' }, personCell(item),
    item.void_by_submission ? '所属提交已作废' : item.is_void ? '已作废' : item.included === false ? '未纳入统计' : '有效',
    editButton('整理', () => openEditor('award', item)),
  ]), '没有符合当前条件的获奖明细。');
}

function renderSettings() {
  const { collection, students } = state.data;
  $('setting-title').value = collection.title || '';
  $('setting-activity').value = collection.activity_scope || '';
  $('setting-award').value = collection.award_scope || '';
  $('setting-open').checked = Boolean(collection.is_open);
  ['setting-title', 'setting-activity', 'setting-award'].forEach((id) => $(id).setCustomValidity(''));
  $('roster-count').textContent = `共 ${students.length} 人，${students.filter((student) => student.included).length} 人纳入统计`;
  table($('roster-table'), ['显示姓名', '本次统计', '操作'], students.map((student) => [
    student.display_name, student.included ? '纳入统计' : '未纳入统计',
    editButton('编辑', () => openEditor('student', student)),
  ]), '暂未录入班级名单，可逐个添加或按行批量导入。');
}

function renderAll() {
  const { collection, students } = state.data;
  $('collection-title').textContent = collection.title || '核41班信息收集';
  $('collection-state').textContent = collection.is_open ? '收集中' : '收集已关闭';
  $('collection-state').hidden = false;
  const people = students.map((student) => ({ value: student.id, label: `${student.display_name}${student.included ? '' : '（未纳入统计）'}` }));
  ['activity-person', 'award-person', 'submission-person'].forEach((id) => setOptions($(id), people, '全部同学'));
  setOptions($('activity-category'), CATEGORIES.map((category) => ({ value: category, label: category })), '全部类别');
  renderProgress();
  renderSubmissions();
  renderActivities();
  renderAwards();
  renderSettings();
  document.querySelectorAll('[data-write]').forEach((button) => { button.disabled = isPreview; });
}

function clearData() {
  state.epoch += 1;
  state.raw = null;
  state.data = null;
  state.loading = false;
  $('dashboard').hidden = true;
  $('access-error').hidden = true;
  $('collection-state').hidden = true;
  $('collection-title').textContent = '查看填报进度，整理班级活动与个人获奖。';
  ['progress-metrics', 'activity-metrics', 'award-metrics', 'progress-table', 'submissions-table', 'activities-table', 'awards-table', 'roster-table'].forEach((id) => $(id).replaceChildren());
  ['activity-person', 'award-person', 'submission-person'].forEach((id) => $(id).replaceChildren());
  $('settings-form').reset();
  $('student-form').reset();
  $('import-form').reset();
  if ($('edit-dialog').open) $('edit-dialog').close();
  $('dialog-fields').replaceChildren();
  state.modal = null;
}

async function loadData({ quiet = false } = {}) {
  if (!isPreview && (!state.session || state.locallySignedOut)) return false;
  const epoch = ++state.epoch;
  state.loading = true;
  $('login-section').hidden = true;
  $('access-error').hidden = true;
  if (!quiet) notify('正在读取本次收集数据…');
  try {
    const raw = await api.getAdminData();
    if (epoch !== state.epoch) return false;
    state.raw = raw;
    state.data = deriveData(raw);
    renderAll();
    $('dashboard').hidden = false;
    $('logout').hidden = isPreview;
    if (!quiet) notify('');
    return true;
  } catch (error) {
    if (epoch !== state.epoch) return false;
    clearData();
    $('access-error-text').textContent = `${errorMessage(error)} 请确认当前账号已获管理员授权，或稍后重新加载。`;
    $('access-error').hidden = false;
    $('logout').hidden = isPreview || !state.session;
    notify('');
    return false;
  } finally {
    if (epoch === state.epoch) state.loading = false;
  }
}

function field(label, name, value, options = {}) {
  const wrapper = node('label', undefined, 'a-field');
  const text = node('span', label);
  let input;
  if (options.options) {
    input = node('select');
    options.options.forEach((option) => input.append(new Option(option.label, option.value)));
  } else {
    input = node('input');
    input.type = options.type || 'text';
    if (options.type === 'month') { input.min = '1900-01'; input.max = '2100-12'; }
  }
  input.name = name;
  input.id = `edit-${name}`;
  input.required = options.required !== false;
  input.value = value ?? '';
  if (options.maxLength) limitText(input, options.maxLength, label);
  wrapper.append(text, input);
  return wrapper;
}

function checkbox(label, name, checked) {
  const wrapper = node('label', undefined, 'a-checkbox');
  const input = node('input');
  input.type = 'checkbox';
  input.name = name;
  input.checked = Boolean(checked);
  wrapper.append(input, node('span', label));
  return wrapper;
}

function openEditor(kind, item) {
  if (!state.data) return;
  const voidBySubmission = ['activity', 'award'].includes(kind) && item.void_by_submission;
  state.modal = { kind, item, voidBySubmission };
  const fields = $('dialog-fields');
  fields.replaceChildren();
  showMessage('dialog-error', '');
  const descriptions = {
    student: ['编辑成员', '修改显示姓名会保留全部历史记录。取消纳入统计后，该成员退出填报进度、人数和常规导出。'],
    submission: ['整理整份提交', '修改姓名会同时调整该份提交下所有明细的归属。作废整份提交后，其活动、奖项以及填报状态将重新统计。'],
    activity: ['整理活动明细', '修改或作废会同时处理该同学同类别、同名称的全部重复记录。若所属整份提交已作废，需要先在填报进度中恢复该份提交。'],
    award: ['整理获奖明细', '修改或作废会同时处理该同学同月份、同奖项名称的全部重复记录。若所属整份提交已作废，需要先在填报进度中恢复该份提交。'],
  };
  $('dialog-title').textContent = descriptions[kind][0];
  $('dialog-help').textContent = `${descriptions[kind][1]}${isPreview ? ' 当前为本地示例，修改不会保存。' : ''}`;
  if (kind === 'student') {
    fields.append(field('显示姓名', 'display_name', item.display_name, { maxLength: LIMITS.student }), checkbox('纳入本次统计', 'included', item.included));
  } else if (kind === 'submission') {
    fields.append(field('姓名归属', 'student_id', item.student_id, { options: state.data.students.map((student) => ({ value: student.id, label: `${student.display_name}${student.included ? '' : '（未纳入统计）'}` })) }), checkbox('作废整份提交', 'is_void', item.is_void));
  } else {
    fields.append(node('p', `填报同学：${item.display_name}`, 'a-muted'));
    if (kind === 'activity') fields.append(field('活动类别', 'category', item.category, { options: CATEGORIES.map((category) => ({ value: category, label: category })) }));
    else fields.append(field('获奖年月', 'month', item.month, { type: 'month' }));
    fields.append(field(kind === 'activity' ? '活动或项目名称' : '奖项完整名称', 'name', item.name, { maxLength: LIMITS.name }), checkbox('作废这项明细', 'is_void', item.is_void));
  }
  if (voidBySubmission) {
    $('dialog-help').textContent = '该事项所属的原始提交均已作废，当前不能直接修改或恢复明细。请先到填报进度恢复至少一份原始提交，再整理这项明细。';
    fields.querySelectorAll('input, select').forEach((input) => { input.disabled = true; });
    const viewSubmissions = node('button', '查看该同学的原始提交', 'a-secondary');
    viewSubmissions.type = 'button';
    viewSubmissions.addEventListener('click', () => {
      $('edit-dialog').close();
      selectTab('progress');
      $('submission-person').value = item.student_id;
      $('submission-status').value = 'void';
      renderSubmissions();
      const details = document.querySelector('.a-records');
      details.open = true;
      details.scrollIntoView({ block: 'start' });
      details.querySelector('summary').focus();
    });
    fields.append(viewSubmissions);
  }
  $('dialog-save').disabled = isPreview || voidBySubmission;
  $('edit-dialog').showModal();
}

async function saveEditor(event) {
  event.preventDefault();
  if (!state.modal || state.modalBusy || isPreview || state.modal.voidBySubmission) return;
  const { kind, item } = state.modal;
  const form = new FormData($('edit-form'));
  const button = $('dialog-save');
  showMessage('dialog-error', '');
  state.modalBusy = true;
  $('dialog-cancel').disabled = true;
  $('dialog-close').disabled = true;
  busy(button, true);
  try {
    if (kind === 'student') {
      const displayName = String(form.get('display_name') || '').trim();
      if (!displayName) throw new Error('请填写显示姓名。');
      requireLength(displayName, LIMITS.student, '显示姓名');
      if (state.data.students.some((student) => student.id !== item.id && student.display_name === displayName)) throw new Error('名单中已有完全相同的显示姓名。请使用能够区分重名同学的显示方式。');
      await api.upsertStudent({ id: item.id, display_name: displayName, included: form.has('included') });
    } else if (kind === 'submission') {
      await api.updateSubmission({ id: item.id, student_id: form.get('student_id'), is_void: form.has('is_void') });
    } else {
      const name = String(form.get('name') || '').trim();
      if (!name) throw new Error(kind === 'activity' ? '请填写活动或项目名称。' : '请填写奖项完整名称。');
      requireLength(name, LIMITS.name, kind === 'activity' ? '活动或项目名称' : '奖项完整名称');
      const payload = { id: item.id, name, is_void: form.has('is_void') };
      if (kind === 'activity') await api.updateActivity({ ...payload, category: form.get('category') });
      else {
        const month = String(form.get('month') || '');
        if (!MONTH_PATTERN.test(month)) throw new Error('请填写有效的获奖年月（1900—2100 年），格式为 YYYY-MM。');
        await api.updateAward({ ...payload, month });
      }
    }
    $('edit-dialog').close();
    state.modal = null;
    const loaded = await loadData({ quiet: true });
    if (loaded) notify('修改已保存，统计与导出已同步更新。', 'success');
  } catch (error) {
    handleWriteError(error, 'dialog-error');
  } finally {
    state.modalBusy = false;
    $('dialog-cancel').disabled = false;
    $('dialog-close').disabled = false;
    busy(button, false);
  }
}

function exportData(kind) {
  if (!state.data) return;
  const { progress, activities, awards, categoryCounts, counts } = state.data;
  const prefix = isPreview ? '本地示例_核41班_' : '核41班_';
  const exports = {
    progress: ['填报进度', ['姓名', '是否已填', '最近提交时间'], progress.filter((item) => item.included).map((item) => [item.display_name, item.submitted ? '已填报' : '未填报', item.last_submitted_at ? formatDate(item.last_submitted_at) : ''])],
    activities: ['活动明细', ['姓名', '活动类别', '活动或项目名称'], activities.filter((item) => !item.is_void && item.included !== false).map((item) => [item.display_name, item.category, item.name])],
    awards: ['获奖清单', ['获奖年月', '奖项完整名称', '姓名'], awards.filter((item) => !item.is_void && item.included !== false).sort((a, b) => b.month.localeCompare(a.month)).map((item) => [item.month, item.name, item.display_name])],
    counts: ['活动人数汇总', ['活动类别', '参与人数'], [...categoryCounts.map((item) => [item.category, item.count]), ['总参与人数', counts.participants]]],
  };
  const entry = exports[kind];
  if (!entry) return;
  downloadCsv(`${prefix}${entry[0]}.csv`, entry[1], entry[2]);
  notify(`${isPreview ? '本地示例：' : ''}${entry[0]}已导出，包含本次收集的全部有效统计结果，不受当前筛选影响。`, 'success');
}

function selectTab(name, focus = false) {
  document.querySelectorAll('[data-tab]').forEach((button) => {
    const selected = button.dataset.tab === name;
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
    $(`panel-${button.dataset.tab}`).hidden = !selected;
    if (selected && focus) button.focus();
  });
}

document.querySelectorAll('[data-tab]').forEach((button, index, tabs) => {
  button.addEventListener('click', () => selectTab(button.dataset.tab));
  button.addEventListener('keydown', (event) => {
    let next;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = tabs.length - 1;
    if (next !== undefined) {
      event.preventDefault();
      selectTab(tabs[next].dataset.tab, true);
    }
  });
});

['progress-search', 'progress-status', 'progress-members'].forEach((id) => $(id).addEventListener(id === 'progress-search' ? 'input' : 'change', renderProgress));
['submission-person', 'submission-status'].forEach((id) => $(id).addEventListener('change', renderSubmissions));
['activity-person', 'activity-category', 'activity-state'].forEach((id) => $(id).addEventListener('change', renderActivities));
['award-person', 'award-sort', 'award-state'].forEach((id) => $(id).addEventListener('change', renderAwards));
document.querySelectorAll('[data-export]').forEach((button) => button.addEventListener('click', () => exportData(button.dataset.export)));
$('edit-form').addEventListener('submit', saveEditor);
['dialog-close', 'dialog-cancel'].forEach((id) => $(id).addEventListener('click', () => { if (!state.modalBusy) $('edit-dialog').close(); }));
$('edit-dialog').addEventListener('cancel', (event) => { if (state.modalBusy) event.preventDefault(); });
$('retry-data').addEventListener('click', () => { if (!state.loading) void loadData(); });

$('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('login-submit');
  if (button.disabled || api.mode !== 'live') return;
  busy(button, true, '正在登录…');
  showMessage('login-error', '');
  try {
    state.session = await api.signIn($('login-email').value.trim(), $('login-password').value);
    state.locallySignedOut = false;
    $('login-password').value = '';
    $('logout').hidden = false;
    await loadData();
  } catch (error) {
    showMessage('login-error', errorMessage(error));
  } finally {
    busy(button, false);
  }
});

$('logout').addEventListener('click', async () => {
  if (state.logoutBusy) return;
  state.logoutBusy = true;
  state.locallySignedOut = true;
  clearData();
  state.session = null;
  $('logout').hidden = true;
  $('login-section').hidden = false;
  notify('');
  try {
    await api.signOut();
    notify('已退出登录。');
  } catch (error) {
    notify(`当前页面的管理数据已清除。退出登录未完成：${errorMessage(error)}`, 'error');
    $('logout').hidden = false;
  } finally {
    state.logoutBusy = false;
  }
});

$('settings-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('save-settings');
  if (button.disabled || isPreview) return;
  showMessage('settings-error', '');
  busy(button, true);
  try {
    const payload = { title: $('setting-title').value.trim(), activity_scope: $('setting-activity').value.trim(), award_scope: $('setting-award').value.trim(), is_open: $('setting-open').checked };
    if (!payload.title || !payload.activity_scope) throw new Error('请填写收集标题和活动统计范围。');
    requireLength(payload.title, LIMITS.title, '收集标题');
    requireLength(payload.activity_scope, LIMITS.scope, '活动统计范围');
    requireLength(payload.award_scope, LIMITS.scope, '获奖统计范围');
    if (payload.is_open && !payload.award_scope) throw new Error('开放前请先填写已确认的获奖统计范围。');
    if (payload.is_open && !state.data.students.some((student) => student.included)) throw new Error('开放前请至少录入一位纳入统计的成员。');
    await api.saveSettings(payload);
    const loaded = await loadData({ quiet: true });
    if (loaded) notify(payload.is_open ? '设置已保存，信息收集已开放。' : '设置已保存，信息收集已关闭。', 'success');
  } catch (error) {
    handleWriteError(error, 'settings-error');
  } finally {
    busy(button, false);
  }
});

$('student-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button');
  if (button.disabled || isPreview || !state.data) return;
  showMessage('student-error', '');
  busy(button, true, '正在添加…');
  const name = $('new-student-name').value.trim();
  let writeAttempted = false;
  try {
    if (!name) throw new Error('请填写显示姓名。');
    requireLength(name, LIMITS.student, '显示姓名');
    if (state.data.students.some((student) => student.display_name === name)) throw new Error('名单中已有完全相同的显示姓名。若为重名同学，请使用能够区分两人的显示方式。');
    writeAttempted = true;
    await api.upsertStudent({ id: null, display_name: name, included: true });
    $('student-form').reset();
    const loaded = await loadData({ quiet: true });
    if (loaded) notify(`已添加 ${name}。`, 'success');
  } catch (error) {
    if (handleWriteError(error, 'student-error')) return;
    if (writeAttempted) {
      // A timed-out write may already have committed. Refresh before enabling retry.
      button.textContent = '正在核对最新名单…';
      const loaded = await loadData({ quiet: true });
      if (loaded && state.data.students.some((student) => student.display_name === name)) {
        $('student-form').reset();
        showMessage('student-error', '');
        notify(`已从最新名单确认 ${name} 已存在，无需重复添加。`, 'success');
      } else if (loaded) {
        showMessage('student-error', `${errorMessage(error)} 已刷新名单，可重新尝试添加。`);
      }
    }
  } finally {
    busy(button, false);
  }
});

$('import-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button');
  if (button.disabled || isPreview || !state.data) return;
  showMessage('import-error', '');
  const names = [...new Set($('import-names').value.split(/\r?\n/).map((name) => name.trim()).filter(Boolean))];
  if (!names.length) { showMessage('import-error', '请填写名单，每行一位同学。'); return; }
  if (names.some((name) => [...name].length > LIMITS.student)) { showMessage('import-error', `每个显示姓名不得超过 ${LIMITS.student} 字，请检查名单。`); return; }
  const existingNames = new Set(state.data.students.map((student) => student.display_name));
  const pending = names.filter((name) => !existingNames.has(name));
  let added = 0;
  busy(button, true, '正在导入…');
  try {
    for (const name of pending) {
      if (state.locallySignedOut || !state.data) throw new Error('管理登录已失效，请重新登录。');
      await api.upsertStudent({ id: null, display_name: name, included: true });
      added += 1;
      button.textContent = `正在导入 ${added} / ${pending.length}…`;
      $('import-names').value = pending.slice(added).join('\n');
    }
    $('import-names').value = '';
    const loaded = await loadData({ quiet: true });
    if (loaded) notify(`已添加 ${added} 位成员，跳过 ${names.length - pending.length} 个已有显示姓名。`, 'success');
  } catch (error) {
    if (handleWriteError(error, 'import-error')) return;
    const message = `已成功添加 ${added} 位成员，未完成的姓名仍保留在输入框中。${errorMessage(error)}`;
    const loaded = await loadData({ quiet: true });
    if (loaded) showMessage('import-error', message);
  } finally {
    busy(button, false);
  }
});

async function initialize() {
  if (isPreview) {
    $('student-link').href = './index.html?preview=1';
    $('return-link').href = './index.html?preview=1';
    showMessage('mode-notice', '本地示例 · 以下姓名与数据均为演示内容。可以查看、筛选和导出示例；保存、导入与开放收集均不可用。');
    await loadData();
    return;
  }
  if (api.mode === 'unconfigured') {
    showMessage('mode-notice', '管理后台尚未配置完成。完成网站连接和管理员授权后，即可登录使用。');
    return;
  }
  notify('正在检查登录状态…');
  try {
    state.session = await api.getSession();
    if (state.session) {
      $('logout').hidden = false;
      await loadData();
    } else {
      $('login-section').hidden = false;
      notify('');
    }
  } catch (error) {
    $('login-section').hidden = false;
    notify(errorMessage(error), 'error');
  }
  api.onAuthChange((event, session) => {
    // Supabase calls this while holding an auth lock: defer all further work.
    setTimeout(() => {
      if (state.logoutBusy || (state.locallySignedOut && session)) return;
      state.session = session;
      if (!session) {
        clearData();
        $('logout').hidden = true;
        $('login-section').hidden = false;
        if (event !== 'INITIAL_SESSION') notify('登录已结束，请重新登录。');
      } else if (!state.data && !state.loading) {
        $('logout').hidden = false;
        void loadData();
      }
    }, 0);
  });
}

limitText($('setting-title'), LIMITS.title, '收集标题');
limitText($('setting-activity'), LIMITS.scope, '活动统计范围');
limitText($('setting-award'), LIMITS.scope, '获奖统计范围');
limitText($('new-student-name'), LIMITS.student, '显示姓名');
void initialize();
