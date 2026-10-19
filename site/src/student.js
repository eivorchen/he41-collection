import './styles.css';
import { api, errorMessage } from './api.js';
import { CATEGORIES, LIMITS, newRequestId, validateSubmission } from './domain.js';

const $ = (selector) => document.querySelector(selector);
const form = $('#student-form');
const state = {
  studentId: '',
  hasActivities: null,
  hasAwards: null,
  activities: [],
  awards: [],
  requestId: newRequestId(),
  pendingPayload: null,
  submitting: false,
  locked: false,
};
const monthProbe = document.createElement('input');
monthProbe.setAttribute('type', 'month');
const supportsMonth = monthProbe.type === 'month';
let nextRowId = 1;

function element(tag, attributes = {}, text) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (key === 'className') node.className = value;
    else node.setAttribute(key, value);
  }
  if (text !== undefined) node.textContent = text;
  return node;
}

function showStatus(message, type = '') {
  const node = $('#submission-status');
  node.textContent = message;
  node.className = `notice ${type ? `is-${type}` : ''}`;
  node.hidden = !message;
}

function clearErrors() {
  for (const node of form.querySelectorAll('.field-error')) {
    node.hidden = true;
    node.textContent = '';
  }
  for (const node of form.querySelectorAll('[aria-invalid]')) node.removeAttribute('aria-invalid');
}

function markChanged() {
  state.requestId = newRequestId();
  state.pendingPayload = null;
  clearErrors();
  showStatus('');
}

function makeField(label, control, fieldPath, hint = '') {
  const wrapper = element('div', { className: 'field' });
  const labelNode = element('label', { for: control.id }, label);
  const errorId = `${control.id}-error`;
  const error = element('p', { id: errorId, className: 'error field-error', 'data-error-for': fieldPath, hidden: '' });
  control.setAttribute('data-field', fieldPath);
  control.setAttribute('aria-describedby', errorId);
  wrapper.append(labelNode, control);
  if (hint) {
    const hintId = `${control.id}-hint`;
    wrapper.append(element('p', { className: 'hint', id: hintId }, hint));
    control.setAttribute('aria-describedby', `${hintId} ${errorId}`);
  }
  wrapper.append(error);
  return wrapper;
}

function newRow(kind) {
  return kind === 'activities'
    ? { key: nextRowId++, category: '', name: '' }
    : { key: nextRowId++, month: '', name: '' };
}

function makeMonthField(row, index) {
  const id = `award-${row.key}-month`;
  if (supportsMonth) {
    const control = element('input', { id, type: 'month', autocomplete: 'off', min: '1900-01', max: '2100-12' });
    control.value = row.month;
    control.addEventListener('input', () => { row.month = control.value; markChanged(); });
    return makeField('获奖年月', control, `awards.${index}.month`);
  }
  const wrapper = element('div', { className: 'field' });
  wrapper.append(element('label', { id: `${id}-label`, for: `${id}-year` }, '获奖年月'));
  const controls = element('div', { className: 'month-fallback', role: 'group', 'aria-labelledby': `${id}-label` });
  const errorId = `${id}-error`;
  const year = element('select', { id: `${id}-year`, 'aria-label': '获奖年份', 'data-field': `awards.${index}.month`, 'aria-describedby': errorId });
  const month = element('select', { id: `${id}-number`, 'aria-label': '获奖月份', 'data-field': `awards.${index}.month`, 'aria-describedby': errorId });
  year.append(element('option', { value: '' }, '选择年份'));
  month.append(element('option', { value: '' }, '选择月份'));
  for (let value = 2100; value >= 1900; value--) year.append(element('option', { value }, `${value}年`));
  for (let value = 1; value <= 12; value++) month.append(element('option', { value: String(value).padStart(2, '0') }, `${value}月`));
  const [savedYear = '', savedMonth = ''] = row.month.split('-');
  year.value = savedYear;
  month.value = savedMonth;
  const update = () => {
    row.month = year.value || month.value ? `${year.value}-${month.value}` : '';
    markChanged();
  };
  year.addEventListener('change', update);
  month.addEventListener('change', update);
  controls.append(year, month);
  wrapper.append(controls, element('p', { id: errorId, className: 'error field-error', 'data-error-for': `awards.${index}.month`, hidden: '' }));
  return wrapper;
}

function renderRows(kind, focusIndex = null) {
  const isActivity = kind === 'activities';
  const container = $(isActivity ? '#activity-rows' : '#award-rows');
  const rows = state[kind];
  container.replaceChildren();
  rows.forEach((row, index) => {
    const label = isActivity ? '活动' : '奖项';
    const item = element('div', { className: 'detail-row' });
    const heading = element('div', { className: 'detail-row-heading' });
    const remove = element('button', { type: 'button', className: 'button-text remove-row', 'aria-label': `移除第${index + 1}项${label}` }, '移除');
    remove.addEventListener('click', () => {
      rows.splice(index, 1);
      markChanged();
      renderRows(kind);
      const remaining = container.querySelectorAll('input, select');
      if (remaining.length) remaining[Math.min(index * 2, remaining.length - 1)].focus();
      else $(isActivity ? '#add-activity' : '#add-award').focus();
    });
    heading.append(element('h3', {}, `${label} ${index + 1}`), remove);
    const fields = element('div', { className: 'detail-fields' });
    if (isActivity) {
      const category = element('select', { id: `activity-${row.key}-category` });
      category.append(element('option', { value: '' }, '请选择类别'));
      for (const value of CATEGORIES) category.append(element('option', { value }, value));
      category.value = row.category;
      category.addEventListener('change', () => { row.category = category.value; markChanged(); });
      fields.append(makeField('活动类别', category, `activities.${index}.category`));
    } else fields.append(makeMonthField(row, index));
    const name = element('input', { id: `${isActivity ? 'activity' : 'award'}-${row.key}-name`, type: 'text', maxlength: LIMITS.name * 2, autocomplete: 'off', placeholder: isActivity ? '如：校运动会' : '如：××竞赛二等奖' });
    name.value = row.name;
    name.addEventListener('input', () => { row.name = name.value; markChanged(); });
    fields.append(makeField(isActivity ? '活动或项目名称' : '奖项完整名称', name, `${kind}.${index}.name`));
    item.append(heading, fields);
    container.append(item);
  });
  const addButton = $(isActivity ? '#add-activity' : '#add-award');
  addButton.disabled = rows.length >= LIMITS.rows;
  addButton.textContent = rows.length >= LIMITS.rows ? `本次最多填写${LIMITS.rows}项${isActivity ? '活动' : '奖项'}` : `＋ 添加一项${isActivity ? '活动' : '奖项'}`;
  if (focusIndex !== null) container.children[focusIndex]?.querySelector('select, input')?.focus();
}

function updateAnswer(kind, value) {
  const isActivity = kind === 'activities';
  state[isActivity ? 'hasActivities' : 'hasAwards'] = value === 'yes';
  $(isActivity ? '#activity-details' : '#award-details').hidden = value !== 'yes';
  $(isActivity ? '#no-activity-note' : '#no-award-note').hidden = value !== 'no';
  if (value === 'yes' && !state[kind].length) {
    state[kind].push(newRow(kind));
    renderRows(kind);
  }
  markChanged();
}

function buildPayload() {
  return {
    request_id: state.requestId,
    student_id: state.studentId,
    has_activities: state.hasActivities,
    has_awards: state.hasAwards,
    activities: state.hasActivities === true ? state.activities.map(({ category, name }) => ({ category, name: name.trim() })) : [],
    awards: state.hasAwards === true ? state.awards.map(({ month, name }) => ({ month, name: name.trim() })) : [],
  };
}

function showErrors(errors) {
  clearErrors();
  let first;
  for (const { field, message } of errors) {
    const error = [...form.querySelectorAll('[data-error-for]')].find((node) => node.dataset.errorFor === field);
    if (error) { error.textContent = message; error.hidden = false; }
    const controls = field === 'student_id' ? [$('#student-id')]
      : field === 'has_activities' || field === 'has_awards' ? [...form.querySelectorAll(`input[name="${field}"]`)]
        : [...form.querySelectorAll('[data-field]')].filter((node) => node.dataset.field === field);
    for (const control of controls) control.setAttribute('aria-invalid', 'true');
    if (!first) first = controls[0] || (field === 'activities' ? $('#add-activity') : field === 'awards' ? $('#add-award') : null);
  }
  showStatus(`还有${errors.length}处需要完善，请查看对应字段的提示。`, 'error');
  (first || $('#submission-status')).focus();
}

function updateSubmissionControls() {
  $('#form-fields').disabled = state.submitting || state.locked;
  $('#submit-button').disabled = state.submitting;
  $('#submit-button').textContent = state.submitting ? '正在提交…' : state.locked ? '重试同一份填写' : api.mode === 'preview' ? '检查填写（不提交）' : '提交本次填写';
  $('#new-after-failure').hidden = !state.locked;
  $('#new-after-failure').disabled = state.submitting;
  form.setAttribute('aria-busy', String(state.submitting));
}

async function submit(event) {
  event.preventDefault();
  if (state.submitting || api.mode === 'unconfigured') return;
  const payload = state.pendingPayload || buildPayload();
  const errors = validateSubmission(payload);
  if (errors.length) { showErrors(errors); return; }
  clearErrors();
  if (api.mode === 'preview') {
    showStatus('填写检查通过。当前是本地预览，未提交或保存任何信息。', 'success');
    $('#submission-status').focus();
    return;
  }
  state.pendingPayload = payload;
  state.submitting = true;
  updateSubmissionControls();
  showStatus('正在保存整份填写，请保持页面打开。');
  try {
    const receipt = await api.submitForm(payload);
    if (!receipt?.receipt_id || !receipt?.submitted_at) throw new Error('暂未收到保存回执，请重试确认本次填写。');
    $('#receipt-id').textContent = receipt.receipt_id;
    const date = new Date(receipt.submitted_at);
    $('#receipt-time').textContent = Number.isNaN(date.valueOf()) ? receipt.submitted_at : new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Shanghai' }).format(date);
    form.hidden = true;
    $('#success-panel').hidden = false;
    $('#success-title').focus();
    state.locked = false;
  } catch (error) {
    state.locked = true;
    showStatus(`${errorMessage(error)} 当前填写已保留。请重试同一份填写以确认结果；重试不会重复保存。`, 'error');
    $('#submission-status').focus();
  } finally {
    state.submitting = false;
    updateSubmissionControls();
  }
}

function resetForm() {
  const studentId = state.studentId;
  form.reset();
  Object.assign(state, { studentId, hasActivities: null, hasAwards: null, activities: [], awards: [], requestId: newRequestId(), pendingPayload: null, submitting: false, locked: false });
  $('#student-id').value = studentId;
  for (const selector of ['#activity-details', '#award-details', '#no-activity-note', '#no-award-note', '#success-panel']) $(selector).hidden = true;
  renderRows('activities');
  renderRows('awards');
  clearErrors();
  showStatus('');
  updateSubmissionControls();
  form.hidden = false;
  $('#student-id').focus();
}

function availability(title, description, retry = true) {
  $('#availability').hidden = false;
  $('#availability').setAttribute('aria-busy', 'false');
  $('#availability-title').textContent = title;
  $('#availability-description').textContent = description;
  $('#reload-button').hidden = !retry;
  form.hidden = true;
}

async function loadForm() {
  $('#reload-button').disabled = true;
  if (api.mode === 'unconfigured') {
    availability('信息收集尚未开放', '班委正在准备名单和统计说明。正式开放后，请通过班内发布的链接填写。');
    $('#reload-button').textContent = '刷新状态';
    $('#reload-button').disabled = false;
    return;
  }
  availability('正在读取填报信息', '请稍候，正在确认本次收集的说明和名单。', false);
  $('#availability').setAttribute('aria-busy', 'true');
  try {
    const data = await api.getPublicForm();
    const { collection, students } = data || {};
    if (collection?.title) {
      $('#collection-title').textContent = collection.title;
      document.title = `${collection.title} · 核41班`;
    }
    if (!collection?.is_open) {
      availability('当前未开放填写', '本次收集尚未开始或已关闭。开放安排请留意班级通知；有补充信息可联系陈昱山。');
      $('#reload-button').textContent = '刷新状态';
      return;
    }
    if (!collection.activity_scope?.trim() || !collection.award_scope?.trim() || !Array.isArray(students) || !students.length) {
      availability('填报信息正在准备中', '名单和统计说明尚未准备齐全，请等待班委通知后再填写。');
      return;
    }
    $('#activity-scope').textContent = collection.activity_scope;
    $('#award-scope').textContent = collection.award_scope;
    const studentSelect = $('#student-id');
    studentSelect.replaceChildren(element('option', { value: '' }, '请选择本人姓名'));
    for (const student of students) studentSelect.append(element('option', { value: student.id }, student.display_name));
    $('#availability').hidden = true;
    form.hidden = false;
    updateSubmissionControls();
  } catch (error) {
    availability('暂时无法读取填报信息', `${errorMessage(error)} 请检查网络后重新加载。`);
    $('#reload-button').textContent = '重新加载';
  } finally {
    $('#availability').setAttribute('aria-busy', 'false');
    $('#reload-button').disabled = false;
  }
}

$('#student-id').addEventListener('change', (event) => { state.studentId = event.target.value; markChanged(); });
for (const kind of ['activities', 'awards']) {
  const isActivity = kind === 'activities';
  for (const radio of form.querySelectorAll(`input[name="has_${kind}"]`)) radio.addEventListener('change', () => updateAnswer(kind, radio.value));
  $(isActivity ? '#add-activity' : '#add-award').addEventListener('click', () => {
    if (state[kind].length >= LIMITS.rows) return;
    state[kind].push(newRow(kind));
    markChanged();
    renderRows(kind, state[kind].length - 1);
  });
}
form.addEventListener('submit', submit);
$('#reload-button').addEventListener('click', () => {
  if (api.mode === 'unconfigured') window.location.reload();
  else loadForm();
});
$('#supplement-button').addEventListener('click', resetForm);
$('#new-after-failure').addEventListener('click', () => {
  if (typeof $('#restart-dialog').showModal === 'function') $('#restart-dialog').showModal();
  else if (window.confirm('上次结果尚未确认，建议先重试。仍要清空当前表单并开始新的填写吗？')) resetForm();
});
$('#cancel-restart').addEventListener('click', () => $('#restart-dialog').close());
$('#confirm-restart').addEventListener('click', () => { $('#restart-dialog').close(); resetForm(); });
if (api.mode === 'preview') {
  $('#preview-notice').hidden = false;
  $('#admin-link').href = './admin.html?preview=1';
  $('.brand').href = './?preview=1';
}
loadForm();
