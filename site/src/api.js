import { createClient } from '@supabase/supabase-js';
import { UUID_PATTERN } from './domain.js';

const url = (import.meta.env.VITE_SUPABASE_URL || '').trim();
const key = (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || '').trim();
const collectionId = (import.meta.env.VITE_COLLECTION_ID || '41414141-2026-4000-8000-000000000001').trim();
const isPreview = import.meta.env.DEV && ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname) && new URLSearchParams(location.search).get('preview') === '1';

function validConfiguration() {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.search && !parsed.hash && parsed.pathname === '/' && !url.includes('YOUR_PROJECT') && key.startsWith('sb_publishable_') && !key.includes('REPLACE_ME') && key.length > 25 && UUID_PATTERN.test(collectionId);
  } catch { return false; }
}

const mode = isPreview ? 'preview' : validConfiguration() ? 'live' : 'unconfigured';
const client = mode === 'live' ? createClient(url, key, {
  auth: { persistSession: true, storage: window.sessionStorage, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'he41-admin-session' },
}) : null;

async function rpc(name, params) {
  if (!client) throw new Error(mode === 'preview' ? '这是本地只读预览，示例信息不会提交或保存。' : '信息收集尚未开放，请稍后再试或联系陈昱山。');
  const { data, error } = await client.rpc(name, params).abortSignal(AbortSignal.timeout(20000));
  if (error) throw error;
  return data;
}

async function previewData() {
  if (import.meta.env.DEV) {
    const { makePreviewData } = await import('./preview-data.js');
    return makePreviewData();
  }
  throw new Error('正式站点不提供示例数据。');
}

export const api = {
  mode,
  async getPublicForm() {
    if (mode === 'preview') {
      const data = await previewData();
      return { collection: data.collection, students: data.students.filter(s => s.included).map(({ id, display_name }) => ({ id, display_name })) };
    }
    return rpc('h41_public_form', { p_collection_id: collectionId });
  },
  async submitForm(payload) {
    return rpc('h41_submit_form', {
      p_request_id: payload.request_id, p_collection_id: collectionId, p_student_id: payload.student_id,
      p_has_activities: payload.has_activities, p_has_awards: payload.has_awards,
      p_activities: payload.activities, p_awards: payload.awards,
    });
  },
  async getSession() {
    if (!client) return null;
    const { data, error } = await client.auth.getSession();
    if (error) throw error;
    return data.session;
  },
  async signIn(email, password) {
    if (!client) throw new Error('管理员登录尚未配置。');
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return data.session;
  },
  async signOut() {
    if (!client) return;
    const { error } = await client.auth.signOut({ scope: 'local' });
    if (error) throw error;
  },
  onAuthChange(callback) {
    if (!client) return () => {};
    const { data } = client.auth.onAuthStateChange(callback);
    return () => data.subscription.unsubscribe();
  },
  async getAdminData() {
    if (mode === 'preview') return previewData();
    return rpc('h41_admin_data', { p_collection_id: collectionId });
  },
  async saveSettings(data) {
    return rpc('h41_save_settings', { p_collection_id: collectionId, p_title: data.title, p_activity_scope: data.activity_scope, p_award_scope: data.award_scope, p_is_open: data.is_open });
  },
  async upsertStudent(data) {
    return rpc('h41_upsert_student', { p_collection_id: collectionId, p_student_id: data.id || null, p_display_name: data.display_name, p_included: data.included });
  },
  async updateSubmission(data) {
    return rpc('h41_update_submission', { p_submission_id: data.id, p_student_id: data.student_id, p_is_void: data.is_void });
  },
  async updateActivity(data) {
    return rpc('h41_update_activity', { p_activity_id: data.id, p_category: data.category, p_name: data.name, p_is_void: data.is_void });
  },
  async updateAward(data) {
    return rpc('h41_update_award', { p_award_id: data.id, p_month: data.month, p_name: data.name, p_is_void: data.is_void });
  },
};

export function errorMessage(error) {
  const message = String(error?.message || '');
  if (/invalid login credentials/i.test(message)) return '邮箱或密码不正确，请检查后重试。';
  if (/email not confirmed/i.test(message)) return '管理员邮箱尚未确认，请联系项目管理员完成设置。';
  if (/rate limit|too many requests/i.test(message)) return '尝试次数较多，请稍等片刻后重试。';
  if (error?.code === '42501' || /permission denied|jwt|token.*expired/i.test(message)) return '当前账号没有管理权限或登录已过期，请重新登录或联系项目管理员。';
  if (/abort|timeout|fetch|network|load failed/i.test(message) || error?.name === 'TimeoutError') return '网络连接未完成，填写内容已保留。请检查网络后重试；重试不会重复记录同一份提交。';
  if (/[\u4e00-\u9fff]/.test(message) && message.length < 240) return message;
  return '暂时无法完成操作，请稍后重试。若问题持续，请联系陈昱山。';
}
