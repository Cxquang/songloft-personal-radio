/**
 * personal-radio — 个人电台（P1：推荐引擎 + 多画像）
 *
 * 打分内核参考 charce526/songloft-music-feed（Apache-2.0），已裁剪改造：
 *  - 只保留长期兴趣层，并适配 Songloft 宿主真实存在的歌曲字段
 *  - 宿主没有 genre/style/language/year，改用「歌手 → 标签」映射近似
 *  - 增加多画像、手动画像、收藏开关、按画像隔离的推荐池
 *
 * P1 只做引擎与画像管理，不接 miot 语音桥；P2 再加 /public/hook。
 */

const PLUGIN_VERSION = '0.2.1';
const STORAGE_PREFIX = 'personalRadio.';
const MODEL_VERSION = 1;

const SKEY = {
  config: STORAGE_PREFIX + 'config',
  profiles: STORAGE_PREFIX + 'profiles',
  singerTags: STORAGE_PREFIX + 'singerTags',
  favorites: STORAGE_PREFIX + 'favorites',
  songTags: STORAGE_PREFIX + 'songTags',
  aiProgress: STORAGE_PREFIX + 'aiProgress',
  interest: function (id) { return STORAGE_PREFIX + 'profile.' + id + '.interest'; },
  pool: function (id) { return STORAGE_PREFIX + 'profile.' + id + '.pool'; },
  history: function (id) { return STORAGE_PREFIX + 'profile.' + id + '.history'; },
  manual: function (id) { return STORAGE_PREFIX + 'manual.' + id; }
};

const DEFAULT_CONFIG = {
  // 配置结构版本：v0.2.1 起候选来源默认全部歌曲（含本地）
  configVersion: 2,
  // P1 引擎参数
  candidateSource: 'all',
  poolSize: 100,
  queueBatch: 20,
  explorationRatio: 0,
  manualWeight: 0.6,
  favoriteBonus: 12,
  libraryCacheTtlSec: 300,
  favoritesTtlMin: 30,
  historyLimit: 500,
  playlistSuffix: '-推荐',
  // P2 预留（P1 不调用）
  songloftBase: 'http://192.168.123.176:58091',
  miotBase: 'http://192.168.123.176:58091/api/v1/jsplugin/miot',
  adminUsername: '',
  adminPassword: '',
  hookSecret: '',
  pollIntervalMs: 2500,
  defaultPlayMode: 'order',
  // AI 标签补全（OpenAI 兼容接口）
  aiEnabled: false,
  aiProvider: 'deepseek',
  aiApiUrl: 'https://api.deepseek.com/v1',
  aiApiKey: '',
  aiModel: 'deepseek-chat',
  aiHeaders: {},
  aiTimeoutSec: 30,
  aiBatchSize: 20,
  aiConcurrency: 1,
  aiMinConfidence: 0.7,
  aiJsonMode: true,
  autoTagLanguage: true,
  aiMaxSongsPerRun: 0
};

const CONFIG_FIELDS = [
  'configVersion', 'candidateSource', 'poolSize', 'queueBatch', 'explorationRatio', 'manualWeight',
  'favoriteBonus', 'libraryCacheTtlSec', 'favoritesTtlMin', 'historyLimit', 'playlistSuffix',
  'songloftBase', 'miotBase', 'adminUsername', 'adminPassword', 'hookSecret',
  'pollIntervalMs', 'defaultPlayMode',
  'aiEnabled', 'aiProvider', 'aiApiUrl', 'aiApiKey', 'aiModel', 'aiHeaders',
  'aiTimeoutSec', 'aiBatchSize', 'aiConcurrency', 'aiMinConfidence', 'aiJsonMode',
  'autoTagLanguage', 'aiMaxSongsPerRun'
];

const BEHAVIOR_WEIGHTS = {
  start: 0, play80: 3, complete: 5, like: 7, unlike: -7, favorite: 12, unfavorite: -12,
  dislike: -14, undislike: 7, repeat: 8, search: 20, next: -1, quickSkip: -10, skip: -2
};

const MODEL_DIMENSIONS = [
  'artists', 'albums', 'genres', 'years', 'decades', 'languages',
  'styles', 'types', 'formats', 'durationBuckets', 'folders', 'songs'
];

const DIMENSION_SCORE_WEIGHTS = {
  artists: 18, albums: 7, genres: 12, years: 3, decades: 7, languages: 8,
  styles: 10, types: 2, formats: 2, durationBuckets: 3, folders: 3, songs: 15
};

const DIMENSION_UPDATE_WEIGHTS = {
  artists: 1, albums: 0.6, genres: 0.65, years: 0.25, decades: 0.45, languages: 0.5,
  styles: 0.65, types: 0.12, formats: 0.12, durationBuckets: 0.2, folders: 0.2, songs: 0.8
};

const DIMENSION_LABELS = {
  artists: '歌手偏好', albums: '专辑偏好', genres: '流派偏好', years: '年份偏好',
  decades: '年代偏好', languages: '语种偏好', styles: '风格偏好', types: '类型偏好',
  formats: '格式偏好', durationBuckets: '时长偏好', folders: '目录偏好', songs: '歌曲复听'
};

const DIVERSITY_LIMITS = { artists: 0.25, genres: 0.45, languages: 0.65, decades: 0.55 };
const FAVORITE_BATCH_RATIO = 0.2;

let config = Object.assign({}, DEFAULT_CONFIG);
let libraryCache = null;
let libraryCacheAt = 0;
/* ─── 日志缓冲 ─── */
const LOG_LIMIT = 200;
const logBuf = [];

function pad2(n) { return n < 10 ? '0' + n : String(n); }

function timeString(ts) {
  const d = new Date(ts || Date.now());
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' '
    + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
}

function pushLog(level, message) {
  logBuf.push({ time: timeString(), level: String(level || 'INFO'), message: String(message) });
  if (logBuf.length > LOG_LIMIT) logBuf.splice(0, logBuf.length - LOG_LIMIT);
}

function log(message) {
  pushLog('INFO', message);
  try { songloft.log.info('[personal-radio] ' + message); } catch (e) { /* 宿主日志不可用时忽略 */ }
}

function logWarn(message) {
  pushLog('WARN', message);
  try { songloft.log.warn('[personal-radio] ' + message); } catch (e) { /* 宿主日志不可用时忽略 */ }
}

/* ─── 基础工具 ─── */
function jsonResponse(data, status) {
  return {
    statusCode: status || 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(data)
  };
}

function badRequest(message) {
  return jsonResponse({ error: String(message || '参数错误') }, 400);
}

function parseBody(req) {
  try {
    if (!req || !req.body) return {};
    if (typeof req.body === 'object') return req.body;
    return JSON.parse(String(req.body));
  } catch (e) { return {}; }
}

function parseQuery(qs) {
  const params = {};
  if (!qs) return params;
  const text = String(qs).charAt(0) === '?' ? String(qs).slice(1) : String(qs);
  const pairs = text.split('&');
  for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i];
    if (!pair) continue;
    const index = pair.indexOf('=');
    const rawKey = index >= 0 ? pair.slice(0, index) : pair;
    const rawValue = index >= 0 ? pair.slice(index + 1) : '';
    if (!rawKey) continue;
    try {
      params[decodeURIComponent(rawKey)] = decodeURIComponent(rawValue);
    } catch (e) {
      params[rawKey] = rawValue;
    }
  }
  return params;
}

function clamp(value, min, max) {
  const n = Number(value);
  if (!isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function round(value, digits) {
  const factor = Math.pow(10, digits || 0);
  return Math.round((Number(value) || 0) * factor) / factor;
}

function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

function normalizeId(value) {
  return value === null || value === undefined ? '' : String(value);
}

function keyOf(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeStringList(value) {
  let list = [];
  if (Array.isArray(value)) list = value;
  else if (typeof value === 'string') list = value.split(/[,，、]/);
  const result = [];
  for (let i = 0; i < list.length; i++) {
    const text = String(list[i] === null || list[i] === undefined ? '' : list[i]).trim();
    if (!text) continue;
    if (result.indexOf(text) < 0) result.push(text);
  }
  return result;
}

/* ─── 存储层 ─── */
function parseStored(raw, fallback) {
  if (raw === null || raw === undefined || raw === '') return fallback;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(String(raw)); } catch (e) { return fallback; }
}

async function storageGet(key, fallback) {
  try {
    return parseStored(await songloft.storage.get(key), fallback);
  } catch (e) {
    logWarn('读取存储失败 ' + key + '：' + e.message);
    return fallback;
  }
}

async function storageSet(key, value) {
  const text = JSON.stringify(value);
  try {
    await songloft.storage.set(key, text);
    if (text.length > 262144) {
      logWarn('存储键 ' + key + ' 已达 ' + text.length + ' 字节，注意宿主单键容量限制');
    }
  } catch (e) {
    logWarn('写入存储失败 ' + key + '：' + e.message);
    throw e;
  }
}

async function storageDel(key) {
  try {
    if (songloft.storage && typeof songloft.storage.delete === 'function') await songloft.storage.delete(key);
    else await songloft.storage.set(key, '');
  } catch (e) {
    logWarn('删除存储失败 ' + key + '：' + e.message);
  }
}

/* ─── 配置 ─── */
function normalizeConfig(raw) {
  const result = Object.assign({}, DEFAULT_CONFIG);
  if (raw && typeof raw === 'object') {
    for (let i = 0; i < CONFIG_FIELDS.length; i++) {
      const field = CONFIG_FIELDS[i];
      if (raw[field] !== undefined && raw[field] !== null) result[field] = raw[field];
    }
  }
  // 旧配置（无 configVersion）默认是「仅网络歌曲」，v0.2.1 一次性迁移为全部歌曲；
  // 迁移后用户仍可在「引擎设置」里手动切回仅网络。
  const storedVersion = Number(raw && raw.configVersion) || 0;
  result.candidateSource = result.candidateSource === 'remote' ? 'remote' : 'all';
  if (storedVersion < 2 && result.candidateSource === 'remote') result.candidateSource = 'all';
  result.configVersion = 2;
  result.poolSize = Math.round(clamp(result.poolSize, 10, 500));
  result.queueBatch = Math.round(clamp(result.queueBatch, 5, 100));
  result.explorationRatio = clamp(result.explorationRatio, 0, 0.6);
  result.manualWeight = clamp(result.manualWeight, 0, 2);
  result.favoriteBonus = clamp(result.favoriteBonus, 0, 40);
  result.libraryCacheTtlSec = Math.round(clamp(result.libraryCacheTtlSec, 30, 3600));
  result.favoritesTtlMin = Math.round(clamp(result.favoritesTtlMin, 1, 1440));
  result.historyLimit = Math.round(clamp(result.historyLimit, 50, 2000));
  result.playlistSuffix = String(result.playlistSuffix || '-推荐').slice(0, 10);
  result.pollIntervalMs = Math.round(clamp(result.pollIntervalMs, 1000, 30000));
  result.defaultPlayMode = ['order', 'random', 'single', 'loop', 'singlePlay'].indexOf(result.defaultPlayMode) >= 0
    ? String(result.defaultPlayMode) : 'order';
  result.songloftBase = String(result.songloftBase || '').replace(/\/+$/, '');
  result.miotBase = String(result.miotBase || '').replace(/\/+$/, '');
  result.adminUsername = String(result.adminUsername || '').trim();
  result.adminPassword = String(result.adminPassword || '');
  result.hookSecret = String(result.hookSecret || '').trim();
  result.aiEnabled = result.aiEnabled === true || result.aiEnabled === 'true';
  result.aiProvider = String(result.aiProvider || 'deepseek').slice(0, 30);
  result.aiApiUrl = String(result.aiApiUrl || '').trim().replace(/\/+$/, '');
  result.aiApiKey = String(result.aiApiKey || '').trim();
  result.aiModel = String(result.aiModel || '').trim().slice(0, 100);
  result.aiHeaders = normalizeAiHeaders(result.aiHeaders);
  result.aiTimeoutSec = Math.round(clamp(result.aiTimeoutSec, 5, 120));
  result.aiBatchSize = Math.round(clamp(result.aiBatchSize, 5, 50));
  result.aiConcurrency = Math.round(clamp(result.aiConcurrency, 1, 4));
  result.aiMinConfidence = clamp(result.aiMinConfidence, 0, 1);
  result.aiJsonMode = result.aiJsonMode !== false;
  result.autoTagLanguage = result.autoTagLanguage !== false;
  result.aiMaxSongsPerRun = Math.round(clamp(result.aiMaxSongsPerRun, 0, 5000));
  return result;
}

async function loadConfig() {
  const raw = await storageGet(SKEY.config, null);
  config = normalizeConfig(raw);
  return config;
}

async function saveConfig() {
  await storageSet(SKEY.config, config);
}
/* ─── 画像 ─── */
let profiles = [];

function createDefaultProfile() {
  const now = Date.now();
  return {
    id: 'me',
    name: '我',
    aliases: ['自己'],
    isDefault: true,
    useFavorites: true,
    createdAt: now,
    updatedAt: now
  };
}

function normalizeProfile(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const now = Date.now();
  return {
    id: String(src.id || '').trim(),
    name: String(src.name || '').trim(),
    aliases: normalizeStringList(src.aliases),
    isDefault: Boolean(src.isDefault),
    useFavorites: src.useFavorites !== false,
    createdAt: Number(src.createdAt) || now,
    updatedAt: Number(src.updatedAt) || now
  };
}

function sortProfiles() {
  profiles.sort(function (a, b) {
    if (a.isDefault && !b.isDefault) return -1;
    if (!a.isDefault && b.isDefault) return 1;
    return (a.createdAt || 0) - (b.createdAt || 0);
  });
}

function ensureDefaultProfile() {
  if (!profiles.length) profiles.push(createDefaultProfile());
  const defaults = profiles.filter(function (p) { return p.isDefault; });
  if (!defaults.length) profiles[0].isDefault = true;
  for (let i = 1; i < defaults.length; i++) defaults[i].isDefault = false;
  sortProfiles();
}

async function loadProfiles() {
  const raw = await storageGet(SKEY.profiles, null);
  const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.items) ? raw.items : []);
  profiles = [];
  for (let i = 0; i < list.length; i++) {
    const profile = normalizeProfile(list[i]);
    if (!profile.id || !profile.name) continue;
    profiles.push(profile);
  }
  ensureDefaultProfile();
  await saveProfiles();
  return profiles;
}

async function saveProfiles() {
  await storageSet(SKEY.profiles, profiles);
}

function findProfileById(id) {
  const target = normalizeId(id);
  if (!target) return null;
  for (let i = 0; i < profiles.length; i++) {
    if (profiles[i].id === target) return profiles[i];
  }
  return null;
}

function findProfileByRef(ref) {
  if (!ref) return null;
  const byId = findProfileById(ref);
  if (byId) return byId;
  const target = keyOf(ref);
  if (!target) return null;
  for (let i = 0; i < profiles.length; i++) {
    const profile = profiles[i];
    if (keyOf(profile.name) === target) return profile;
    for (let j = 0; j < profile.aliases.length; j++) {
      if (keyOf(profile.aliases[j]) === target) return profile;
    }
  }
  return null;
}

function getDefaultProfile() {
  for (let i = 0; i < profiles.length; i++) {
    if (profiles[i].isDefault) return profiles[i];
  }
  return profiles.length ? profiles[0] : null;
}

function conflictingProfile(candidate, ignoreId) {
  const own = normalizeStringList([candidate.name].concat(candidate.aliases || [])).map(keyOf);
  for (let i = 0; i < profiles.length; i++) {
    const other = profiles[i];
    if (other.id === ignoreId) continue;
    const tokens = normalizeStringList([other.name].concat(other.aliases || [])).map(keyOf);
    for (let a = 0; a < own.length; a++) {
      if (own[a] && tokens.indexOf(own[a]) >= 0) return other;
    }
  }
  return null;
}

function generateProfileId(name) {
  const base = keyOf(name).replace(/[^a-z0-9_-]+/g, '').replace(/^[-_]+|[-_]+$/g, '');
  const seed = base || 'p';
  for (let i = 0; i < profiles.length + 3; i++) {
    const id = i === 0 ? seed : seed + (i + 1);
    if (!findProfileById(id)) return id;
  }
  return seed + '-' + Date.now().toString(36);
}

function applyProfileInput(input, existing) {
  const src = input && typeof input === 'object' ? input : {};
  const now = Date.now();
  const name = src.name !== undefined ? String(src.name).trim() : (existing ? existing.name : '');
  if (!name) return { error: '画像名称不能为空' };
  if (name.length > 20) return { error: '画像名称最长 20 个字符' };

  let id = src.id !== undefined && String(src.id).trim() ? String(src.id).trim() : '';
  if (existing) {
    if (id && id !== existing.id) return { error: '画像 ID 创建后不可修改' };
    id = existing.id;
  } else if (!id) {
    id = generateProfileId(name);
  }
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(id)) {
    return { error: '画像 ID 只能是小写字母、数字、下划线或中划线（1-32 位）' };
  }

  const aliases = src.aliases !== undefined ? normalizeStringList(src.aliases) : (existing ? existing.aliases.slice() : []);
  if (aliases.length > 10) return { error: '别名最多 10 个' };
  for (let i = 0; i < aliases.length; i++) {
    if (aliases[i].length > 20) return { error: '单个别名最长 20 个字符' };
  }

  const candidate = {
    id: id,
    name: name,
    aliases: aliases,
    isDefault: src.isDefault !== undefined ? Boolean(src.isDefault) : (existing ? existing.isDefault : false),
    useFavorites: src.useFavorites !== undefined ? Boolean(src.useFavorites) : (existing ? existing.useFavorites : true),
    createdAt: existing ? (existing.createdAt || now) : now,
    updatedAt: now
  };
  const conflict = conflictingProfile(candidate, existing ? existing.id : '');
  if (conflict) return { error: '名称或别名与画像「' + conflict.name + '」冲突' };
  return { profile: candidate };
}

async function createProfile(input) {
  const result = applyProfileInput(input, null);
  if (result.error) return result;
  profiles.push(result.profile);
  ensureDefaultProfile();
  sortProfiles();
  await saveProfiles();
  log('新建画像：' + result.profile.name + '（' + result.profile.id + '）');
  return result;
}

async function updateProfile(input) {
  const src = input && typeof input === 'object' ? input : {};
  const target = findProfileById(src.id || src.profileId);
  if (!target) return { error: '画像不存在：' + normalizeId(src.id || src.profileId) };
  const result = applyProfileInput(src, target);
  if (result.error) return result;
  Object.assign(target, result.profile);
  ensureDefaultProfile();
  sortProfiles();
  await saveProfiles();
  log('更新画像：' + target.name);
  return { profile: target };
}

async function deleteProfile(id) {
  if (profiles.length <= 1) return { error: '至少保留一个画像' };
  const target = findProfileById(id);
  if (!target) return { error: '画像不存在：' + normalizeId(id) };
  profiles = profiles.filter(function (profile) { return profile.id !== target.id; });
  ensureDefaultProfile();
  sortProfiles();
  await saveProfiles();
  await storageDel(SKEY.interest(target.id));
  await storageDel(SKEY.pool(target.id));
  await storageDel(SKEY.history(target.id));
  await storageDel(SKEY.manual(target.id));
  log('删除画像：' + target.name);
  return { profile: target };
}

/* ─── 手动画像 ─── */
function normalizeWeightMap(raw) {
  const map = {};
  if (!raw || typeof raw !== 'object') return map;
  const keys = Object.keys(raw);
  for (let i = 0; i < keys.length; i++) {
    const name = String(keys[i] || '').trim();
    if (!name) continue;
    const value = Number(raw[keys[i]]);
    if (!isFinite(value) || value === 0) continue;
    map[name] = round(clamp(value, -1, 1), 3);
  }
  return map;
}

function normalizeManual(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    artists: normalizeWeightMap(src.artists),
    tags: normalizeWeightMap(src.tags),
    updatedAt: Number(src.updatedAt) || 0
  };
}

async function loadManual(profileId) {
  return normalizeManual(await storageGet(SKEY.manual(profileId), null));
}

async function saveManual(profileId, manual) {
  const normalized = normalizeManual(manual);
  normalized.updatedAt = Date.now();
  await storageSet(SKEY.manual(profileId), normalized);
  return normalized;
}

/* ─── 歌手标签库 ─── */
let singerTags = {};

function normalizeSingerTags(raw) {
  const result = {};
  if (!raw || typeof raw !== 'object') return result;
  const keys = Object.keys(raw);
  for (let i = 0; i < keys.length; i++) {
    const singer = String(keys[i] || '').trim();
    if (!singer) continue;
    const tags = normalizeStringList(raw[keys[i]]);
    if (tags.length) result[singer] = tags;
  }
  return result;
}

async function loadSingerTags() {
  singerTags = normalizeSingerTags(await storageGet(SKEY.singerTags, null));
  return singerTags;
}

async function saveSingerTags() {
  await storageSet(SKEY.singerTags, singerTags);
}

function tagsForArtist(artist) {
  const name = String(artist || '').trim();
  if (!name) return [];
  if (singerTags[name]) return singerTags[name];
  const keys = Object.keys(singerTags);
  for (let i = 0; i < keys.length; i++) {
    if (keyOf(keys[i]) === keyOf(name)) return singerTags[keys[i]];
  }
  return [];
}

function classifyTag(tag) {
  const text = String(tag || '').trim();
  if (!text) return '';
  const hit = TAG_LOOKUP[text];
  if (hit) return hit.dimension;
  if (text.indexOf('年代') >= 0) return 'decades';
  if (/^(19|20)\d{2}s?$/i.test(text)) return 'decades';
  if (/^\d0s$/i.test(text)) return 'decades';
  if (/语$/.test(text) || text === '国语') return 'languages';
  return 'genres';
}
/* ─── 长期兴趣模型 ─── */
function createPreferenceModel() {
  const model = { version: MODEL_VERSION, evidence: 0, updatedAt: 0 };
  for (let i = 0; i < MODEL_DIMENSIONS.length; i++) model[MODEL_DIMENSIONS[i]] = {};
  return model;
}

function createFeatureEntry() {
  return {
    score: 0,
    positive: 0,
    negative: 0,
    count: 0,
    lastAction: '',
    lastUpdated: 0,
    liked: false,
    disliked: false
  };
}

function normalizeModel(raw) {
  const model = createPreferenceModel();
  if (!raw || typeof raw !== 'object') return model;
  for (let i = 0; i < MODEL_DIMENSIONS.length; i++) {
    const dim = MODEL_DIMENSIONS[i];
    const source = raw[dim] && typeof raw[dim] === 'object' ? raw[dim] : {};
    const keys = Object.keys(source);
    for (let k = 0; k < keys.length; k++) {
      const key = String(keys[k]);
      const value = source[keys[k]];
      if (typeof value === 'number') {
        const numeric = createFeatureEntry();
        numeric.score = value;
        numeric.lastUpdated = Date.now();
        model[dim][key] = numeric;
        continue;
      }
      if (!value || typeof value !== 'object') continue;
      model[dim][key] = Object.assign(createFeatureEntry(), value, {
        score: Number(value.score) || 0,
        positive: Number(value.positive) || 0,
        negative: Number(value.negative) || 0,
        count: Number(value.count) || 0,
        lastUpdated: Number(value.lastUpdated) || Date.now(),
        liked: Boolean(value.liked),
        disliked: Boolean(value.disliked)
      });
    }
  }
  model.evidence = Number(raw.evidence) || 0;
  model.updatedAt = Number(raw.updatedAt) || 0;
  return model;
}

async function loadInterest(profileId) {
  return normalizeModel(await storageGet(SKEY.interest(profileId), null));
}

async function saveInterest(profileId, model) {
  await storageSet(SKEY.interest(profileId), model);
}

async function loadHistory(profileId) {
  const raw = await storageGet(SKEY.history(profileId), []);
  return Array.isArray(raw) ? raw : [];
}

function summarizeInterest(model) {
  const dimensions = {};
  let entries = 0;
  for (let i = 0; i < MODEL_DIMENSIONS.length; i++) {
    const dim = MODEL_DIMENSIONS[i];
    const size = Object.keys(model[dim] || {}).length;
    dimensions[dim] = size;
    entries += size;
  }
  return { evidence: model.evidence, updatedAt: model.updatedAt, entries: entries, dimensions: dimensions };
}

/* ─── 特征提取 ─── */
function durationBucket(seconds) {
  const value = Number(seconds) || 0;
  if (value <= 0) return '';
  if (value < 60) return '<1min';
  if (value < 180) return '1-3min';
  if (value < 300) return '3-5min';
  if (value < 600) return '5-10min';
  return '10min+';
}

function folderOf(song) {
  const path = String((song && song.file_path) || '').replace(/\\/g, '/');
  const index = path.lastIndexOf('/');
  if (index <= 0) return '';
  return path.slice(0, index).toLowerCase();
}

function songFeatures(song) {
  const features = {};
  for (let i = 0; i < MODEL_DIMENSIONS.length; i++) features[MODEL_DIMENSIONS[i]] = [];
  if (!song || typeof song !== 'object') return features;

  function push(dim, value) {
    const text = String(value === null || value === undefined ? '' : value).trim();
    if (text && features[dim].indexOf(text) < 0) features[dim].push(text);
  }

  push('artists', song.artist);
  push('albums', song.album);
  push('songs', normalizeId(song.id));
  push('types', song.type || 'local');
  push('formats', String(song.format || '').toLowerCase());
  push('durationBuckets', durationBucket(song.duration));
  push('folders', folderOf(song));

  // 标签优先级：歌曲级（手动/AI）> 歌手级；宿主本身没有流派/语种/年代字段
  applyTagFeatures(song, features, push);
  return features;
}

/* ─── 打分内核（算法参考 charce526/songloft-music-feed，Apache-2.0，已裁剪改造） ─── */
function featureScore(entry, now) {
  if (!entry) return 0;
  const ageDays = entry.lastUpdated ? Math.max(0, (now - entry.lastUpdated) / 86400000) : 0;
  const decay = Math.pow(0.992, Math.min(ageDays, 365));
  return (Number(entry.score) || 0) * decay;
}

function boundedFeatureScore(entry, now, scale) {
  if (!entry) return 0;
  const raw = featureScore(entry, now);
  const magnitude = Math.abs(raw);
  if (!magnitude) return 0;
  const count = Math.max(0, Number(entry.count) || 0);
  const confidence = count > 0 ? 0.45 + 0.55 * (1 - Math.exp(-count / 4)) : 0.45;
  return (raw / (magnitude + scale)) * confidence;
}

function modelScore(model, features, now) {
  const details = {};
  let total = 0;
  const dims = Object.keys(features);
  for (let i = 0; i < dims.length; i++) {
    const dim = dims[i];
    const values = features[dim] || [];
    const weight = Number(DIMENSION_SCORE_WEIGHTS[dim]) || 0;
    if (!values.length || !weight) continue;
    const bucket = model[dim] || {};
    const scale = dim === 'artists' ? 4 : 3;
    let sum = 0;
    let hit = 0;
    for (let v = 0; v < values.length; v++) {
      const entry = bucket[values[v]];
      if (!entry) continue;
      hit += 1;
      sum += boundedFeatureScore(entry, now, scale);
    }
    const average = sum / values.length;
    const score = average * weight;
    details[dim] = { average: round(average, 4), weight: weight, score: round(score, 3), hits: hit };
    total += score;
  }
  return { score: round(total, 3), details: details };
}

function manualScoreFor(manual, features) {
  let raw = 0;
  const hits = [];
  const artists = manual.artists || {};
  const tagWeights = manual.tags || {};
  for (let i = 0; i < features.artists.length; i++) {
    const artist = features.artists[i];
    const artistWeight = Number(artists[artist]) || 0;
    if (artistWeight) {
      raw += artistWeight * (DIMENSION_SCORE_WEIGHTS.artists || 0);
      hits.push({ type: 'artist', value: artist, weight: artistWeight });
    }
  }
  const tagDims = ['genres', 'styles', 'languages', 'decades'];
  const seen = {};
  for (let d = 0; d < tagDims.length; d++) {
    const dim = tagDims[d];
    const values = features[dim] || [];
    for (let i = 0; i < values.length; i++) {
      const tag = values[i];
      const weight = Number(tagWeights[tag]) || 0;
      if (!weight || seen[tag]) continue;
      seen[tag] = true;
      raw += weight * (Number(DIMENSION_SCORE_WEIGHTS[dim]) || 0);
      hits.push({ type: 'tag', value: tag, weight: weight, dimension: dim });
    }
  }
  return { raw: round(raw, 3), hits: hits };
}

function fnv1a(text) {
  let hash = 2166136261;
  const value = String(text);
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

function stableJitter(seed) {
  return ((fnv1a(seed) % 1000) / 1000) * 1.2;
}

function scoreSong(song, context) {
  const features = songFeatures(song);
  const auto = modelScore(context.interest, features, context.now);
  const manual = manualScoreFor(context.manual, features);
  const songKey = normalizeId(song && song.id);
  const favorite = context.useFavorites && context.favoriteIds.has(songKey) ? context.favoriteBonus : 0;
  const jitter = stableJitter(songKey + ':' + context.sessionId);
  const manualWeighted = manual.raw * context.manualWeight;
  return {
    song: song,
    features: features,
    score: round(auto.score + manualWeighted + favorite + jitter, 3),
    auto: auto.score,
    manual: round(manualWeighted, 3),
    favorite: favorite,
    jitter: round(jitter, 3),
    details: auto.details,
    manualHits: manual.hits,
    mode: 'interest'
  };
}

function buildReason(item) {
  if (item.mode === 'explore') return '探索新歌';
  const parts = [];
  if (item.manualHits && item.manualHits.length) {
    const hits = item.manualHits.slice(0, 2).map(function (hit) {
      return hit.value + ' ' + (hit.weight > 0 ? '+' : '') + hit.weight;
    });
    parts.push('手动画像 ' + hits.join('、'));
  }
  if (item.favorite) parts.push('收藏加权');
  let topDim = '';
  let topScore = 0;
  const dims = Object.keys(item.details || {});
  for (let i = 0; i < dims.length; i++) {
    const detail = item.details[dims[i]];
    if (detail.score > topScore) {
      topScore = detail.score;
      topDim = dims[i];
    }
  }
  if (topDim) parts.push(DIMENSION_LABELS[topDim] || topDim);
  if (!parts.length) parts.push('为你发现');
  return parts.join(' · ');
}

/* ─── 多样性约束 ─── */
function diversityLimits(count) {
  return {
    artists: Math.max(2, Math.ceil(count * DIVERSITY_LIMITS.artists)),
    genres: Math.max(3, Math.ceil(count * DIVERSITY_LIMITS.genres)),
    languages: Math.max(4, Math.ceil(count * DIVERSITY_LIMITS.languages)),
    decades: Math.max(3, Math.ceil(count * DIVERSITY_LIMITS.decades))
  };
}

function blockedByDiversity(item, counters, limits) {
  const dims = Object.keys(limits);
  for (let d = 0; d < dims.length; d++) {
    const dim = dims[d];
    const values = item.features[dim] || [];
    for (let v = 0; v < values.length; v++) {
      if ((counters[dim][values[v]] || 0) + 1 > limits[dim]) return true;
    }
  }
  return false;
}

function countDiversity(item, counters) {
  const dims = Object.keys(counters);
  for (let d = 0; d < dims.length; d++) {
    const dim = dims[d];
    const values = item.features[dim] || [];
    for (let v = 0; v < values.length; v++) {
      const key = values[v];
      counters[dim][key] = (counters[dim][key] || 0) + 1;
    }
  }
}

function selectDiverse(scored, count) {
  const want = Math.max(0, Math.floor(count));
  const limits = diversityLimits(want);
  const counters = { artists: {}, genres: {}, languages: {}, decades: {} };
  const picked = [];
  const deferred = [];
  for (let i = 0; i < scored.length; i++) {
    if (picked.length >= want) break;
    const item = scored[i];
    if (blockedByDiversity(item, counters, limits)) {
      deferred.push(item);
      continue;
    }
    picked.push(item);
    countDiversity(item, counters);
  }
  for (let i = 0; i < deferred.length && picked.length < want; i++) picked.push(deferred[i]);
  return picked;
}

function explorationRatioFor(evidence) {
  const manual = Number(config.explorationRatio) || 0;
  if (manual > 0) return clamp(manual, 0, 0.6);
  if (evidence < 10) return 0.35;
  if (evidence < 60) return 0.22;
  return 0.15;
}
/* ─── 曲库与候选 ─── */
async function getLibrary() {
  const ttl = Math.max(30, Number(config.libraryCacheTtlSec) || 300) * 1000;
  if (libraryCache && Date.now() - libraryCacheAt < ttl) return libraryCache;
  const result = await songloft.songs.list({ limit: 100000, offset: 0 });
  const songs = (result && (result.items || result.songs || result)) || [];
  libraryCache = Array.isArray(songs)
    ? songs.filter(function (song) { return song && song.id !== undefined && song.id !== null; })
    : [];
  libraryCacheAt = Date.now();
  log('曲库加载完成：' + libraryCache.length + ' 首');
  return libraryCache;
}

function isRemoteSong(song) {
  if (!song) return false;
  if (String(song.type || '') === 'remote') return true;
  return Boolean(song.url) && !song.file_path;
}

function filterCandidates(songs) {
  if (config.candidateSource === 'all') return songs.slice();
  return songs.filter(isRemoteSong);
}

/** 曲库结构统计：本地/网络/电台、宿主自带 genre/year 的覆盖情况 */
function computeLibraryStats(library) {
  const stats = {
    total: 0, local: 0, remote: 0, radio: 0, other: 0,
    withFilePath: 0, withGenre: 0, withYear: 0
  };
  const songs = Array.isArray(library) ? library : [];
  stats.total = songs.length;
  for (let i = 0; i < songs.length; i++) {
    const song = songs[i] || {};
    const type = String(song.type || (song.file_path ? 'local' : ''));
    if (type === 'local') stats.local += 1;
    else if (type === 'remote') stats.remote += 1;
    else if (type === 'radio') stats.radio += 1;
    else stats.other += 1;
    if (song.file_path) stats.withFilePath += 1;
    if (String(song.genre || '').trim()) stats.withGenre += 1;
    if (Number(song.year) > 0) stats.withYear += 1;
  }
  return stats;
}

/* ─── 收藏歌单同步 ─── */
let favoriteIds = new Set();
let favoriteSyncedAt = 0;

function findFavoritesPlaylist(playlists) {
  const normal = playlists.filter(function (item) { return item && item.type === 'normal'; });
  for (let i = 0; i < normal.length; i++) if (normal[i].id === 1) return normal[i];
  for (let i = 0; i < normal.length; i++) {
    const labels = normal[i].labels || [];
    if (labels.indexOf && labels.indexOf('built_in') >= 0 && String(normal[i].name || '') === '收藏') return normal[i];
  }
  for (let i = 0; i < normal.length; i++) {
    if (String(normal[i].name || '') === '收藏') return normal[i];
  }
  return null;
}

async function loadFavoritesCache() {
  const raw = await storageGet(SKEY.favorites, null);
  favoriteIds = new Set();
  favoriteSyncedAt = 0;
  if (raw && Array.isArray(raw.ids)) {
    const ids = raw.ids.map(normalizeId).filter(Boolean);
    favoriteIds = new Set(ids);
    favoriteSyncedAt = Number(raw.syncedAt) || 0;
  }
}

async function syncFavorites(force) {
  const ttl = Math.max(1, Number(config.favoritesTtlMin) || 30) * 60000;
  if (!force && favoriteSyncedAt && Date.now() - favoriteSyncedAt < ttl) {
    return { count: favoriteIds.size, syncedAt: favoriteSyncedAt, cached: true };
  }
  const listResult = await songloft.playlists.list();
  const playlists = (listResult && (Array.isArray(listResult) ? listResult : (listResult.items || listResult.playlists))) || [];
  const target = findFavoritesPlaylist(Array.isArray(playlists) ? playlists : []);
  if (!target) {
    favoriteIds = new Set();
    favoriteSyncedAt = Date.now();
    await storageSet(SKEY.favorites, { ids: [], syncedAt: favoriteSyncedAt });
    logWarn('未找到收藏歌单：需要 id=1 或名为「收藏」的普通歌单');
    return { count: 0, syncedAt: favoriteSyncedAt, cached: false, missing: true };
  }
  const songsResult = await songloft.playlists.getSongs(target.id, { limit: 100000, offset: 0 });
  const songs = (songsResult && (Array.isArray(songsResult) ? songsResult : (songsResult.songs || songsResult.items))) || [];
  const ids = [];
  for (let i = 0; i < songs.length; i++) {
    const id = normalizeId(songs[i] && songs[i].id);
    if (id && ids.indexOf(id) < 0) ids.push(id);
  }
  favoriteIds = new Set(ids);
  favoriteSyncedAt = Date.now();
  await storageSet(SKEY.favorites, { ids: ids, syncedAt: favoriteSyncedAt });
  log('收藏同步完成：' + ids.length + ' 首（歌单「' + (target.name || target.id) + '」）');
  return { count: ids.length, syncedAt: favoriteSyncedAt, cached: false, playlist: target.name || String(target.id) };
}

/* ─── 推荐上下文 ─── */
async function loadProfileContext(profile, sessionId) {
  const interest = await loadInterest(profile.id);
  const manual = await loadManual(profile.id);
  return {
    profile: profile,
    interest: interest,
    manual: manual,
    favoriteIds: favoriteIds,
    useFavorites: Boolean(profile.useFavorites),
    favoriteBonus: Number(config.favoriteBonus) || 0,
    manualWeight: Number(config.manualWeight) || 0,
    now: Date.now(),
    sessionId: sessionId || ('day:' + todayStr() + ':' + profile.id)
  };
}

async function rankForProfile(profile, count, options) {
  const opts = options || {};
  const want = Math.max(1, Math.min(200, Math.round(Number(count) || config.queueBatch)));
  if (opts.refreshLibrary) {
    libraryCache = null;
    libraryCacheAt = 0;
  }
  const library = await getLibrary();
  const candidates = filterCandidates(library);
  if (profile.useFavorites && (opts.refreshFavorites || !favoriteSyncedAt)) {
    try { await syncFavorites(Boolean(opts.refreshFavorites)); }
    catch (e) { logWarn('收藏同步失败：' + e.message); }
  }
  const context = await loadProfileContext(profile, opts.sessionId);

  const scored = [];
  for (let i = 0; i < candidates.length; i++) {
    const song = candidates[i];
    const songKey = normalizeId(song.id);
    const songEntry = context.interest.songs[songKey];
    if (songEntry && songEntry.disliked) continue;
    scored.push(scoreSong(song, context));
  }
  scored.sort(function (a, b) { return b.score - a.score; });

  const ratio = explorationRatioFor(context.interest.evidence);
  const interestCount = Math.max(1, Math.round(want * (1 - ratio)));
  const picked = selectDiverse(scored, Math.min(interestCount, scored.length));

  const pickedKeys = {};
  for (let i = 0; i < picked.length; i++) pickedKeys[normalizeId(picked[i].song.id)] = true;
  const rest = [];
  for (let i = 0; i < scored.length; i++) {
    const key = normalizeId(scored[i].song.id);
    if (!pickedKeys[key]) rest.push(scored[i]);
  }
  const exploreCount = Math.max(0, want - picked.length);
  const explore = rest.slice(0, exploreCount);
  for (let i = 0; i < explore.length; i++) explore[i].mode = 'explore';

  return {
    profile: profile,
    items: picked.concat(explore),
    meta: {
      requested: want,
      candidateCount: candidates.length,
      totalLibrary: library.length,
      interestCount: picked.length,
      exploreCount: explore.length,
      explorationRatio: round(ratio, 3),
      evidence: context.interest.evidence,
      manualWeight: context.manualWeight,
      favoriteBonus: context.favoriteBonus,
      favoriteCount: context.useFavorites ? favoriteIds.size : 0,
      sessionId: context.sessionId,
      generatedAt: Date.now()
    }
  };
}

function formatRecommendItem(item, index) {
  return {
    rank: index + 1,
    songId: normalizeId(item.song.id),
    title: String(item.song.title || ''),
    artist: String(item.song.artist || ''),
    album: String(item.song.album || ''),
    duration: Number(item.song.duration) || 0,
    type: String(item.song.type || ''),
    coverUrl: item.song.cover_url || item.song.coverUrl || '',
    score: item.score,
    mode: item.mode,
    favorite: Boolean(item.favorite),
    reason: buildReason(item),
    breakdown: {
      auto: item.auto,
      manual: item.manual,
      favorite: item.favorite,
      jitter: item.jitter,
      dimensions: item.details,
      manualHits: item.manualHits
    }
  };
}

/* ─── 推荐池 ─── */
async function loadPool(profileId) {
  const raw = await storageGet(SKEY.pool(profileId), []);
  if (!Array.isArray(raw)) return [];
  return raw.filter(function (entry) { return entry && normalizeId(entry.songId) !== ''; });
}

async function savePool(profileId, pool) {
  const cap = Math.max(10, Number(config.poolSize) || 100);
  await storageSet(SKEY.pool(profileId), pool.slice(0, cap));
}

function toPoolEntry(item) {
  return {
    songId: normalizeId(item.song.id),
    score: item.score,
    mode: item.mode,
    favorite: Boolean(item.favorite),
    reason: buildReason(item),
    addedAt: Date.now()
  };
}

async function refillPool(profile, target) {
  const pool = await loadPool(profile.id);
  const cap = Math.max(10, Number(config.poolSize) || 100);
  const want = Math.max(0, Math.min(cap, Math.round(Number(target) || cap)) - pool.length);
  if (want <= 0) return { added: 0, size: pool.length };
  const existing = {};
  for (let i = 0; i < pool.length; i++) existing[pool[i].songId] = true;

  const ranked = await rankForProfile(profile, want + pool.length, {
    sessionId: 'pool:' + todayStr() + ':' + profile.id
  });
  const added = [];
  for (let i = 0; i < ranked.items.length && added.length < want; i++) {
    const item = ranked.items[i];
    const key = normalizeId(item.song.id);
    if (existing[key]) continue;
    existing[key] = true;
    added.push(toPoolEntry(item));
  }
  const next = pool.concat(added);
  await savePool(profile.id, next);
  log('画像「' + profile.name + '」推荐池补充 ' + added.length + ' 首');
  return { added: added.length, size: Math.min(next.length, cap) };
}

async function checkoutPool(profile, count) {
  const want = Math.max(1, Math.min(100, Math.round(Number(count) || config.queueBatch)));
  let pool = await loadPool(profile.id);
  if (pool.length < want) {
    await refillPool(profile, Math.max(want, Number(config.poolSize) || 100));
    pool = await loadPool(profile.id);
  }
  const allowance = profile.useFavorites ? Math.max(1, Math.floor(want * FAVORITE_BATCH_RATIO)) : want;
  const picked = [];
  const rest = [];
  let favoritePicked = 0;
  for (let i = 0; i < pool.length; i++) {
    const entry = pool[i];
    if (picked.length >= want) { rest.push(entry); continue; }
    if (entry.favorite && favoritePicked >= allowance) { rest.push(entry); continue; }
    picked.push(entry);
    if (entry.favorite) favoritePicked += 1;
  }
  while (picked.length < want && rest.length) picked.push(rest.shift());
  await savePool(profile.id, rest);

  const library = await getLibrary();
  const byId = {};
  for (let i = 0; i < library.length; i++) byId[normalizeId(library[i].id)] = library[i];
  const entries = picked.map(function (entry) {
    const song = byId[entry.songId] || null;
    return {
      songId: entry.songId,
      score: Number(entry.score) || 0,
      favorite: Boolean(entry.favorite),
      reason: entry.reason || '',
      title: song ? String(song.title || '') : '',
      artist: song ? String(song.artist || '') : '',
      song: song
    };
  });
  log('画像「' + profile.name + '」从推荐池取出 ' + entries.length + ' 首，剩余 ' + rest.length + ' 首');
  return { entries: entries, remaining: rest.length };
}

async function releaseSongs(profileId, songIds) {
  const ids = Array.isArray(songIds) ? songIds.map(normalizeId).filter(Boolean) : [];
  if (!ids.length) return { added: 0, size: 0 };
  const pool = await loadPool(profileId);
  const existing = {};
  for (let i = 0; i < pool.length; i++) existing[pool[i].songId] = true;
  let added = 0;
  for (let i = 0; i < ids.length; i++) {
    if (existing[ids[i]]) continue;
    existing[ids[i]] = true;
    pool.push({ songId: ids[i], score: 0, mode: 'release', favorite: false, reason: '回池', addedAt: Date.now() });
    added += 1;
  }
  await savePool(profileId, pool);
  return { added: added, size: Math.min(pool.length, Math.max(10, Number(config.poolSize) || 100)) };
}

/* ─── 行为回流（P3 使用，P1 仅内部可用） ─── */
async function applyBehavior(profileId, song, action, extra) {
  const profile = findProfileById(profileId);
  if (!profile) return { applied: false, reason: '画像不存在' };
  const weight = Number(BEHAVIOR_WEIGHTS[action]);
  if (!weight) return { applied: false, reason: '无效行为或权重为 0：' + action };

  const interest = await loadInterest(profile.id);
  const features = songFeatures(song);
  const now = Date.now();
  for (let i = 0; i < MODEL_DIMENSIONS.length; i++) {
    const dim = MODEL_DIMENSIONS[i];
    const values = features[dim] || [];
    if (!values.length) continue;
    const perValue = weight * (Number(DIMENSION_UPDATE_WEIGHTS[dim]) || 0) / Math.sqrt(values.length) * 0.3;
    for (let v = 0; v < values.length; v++) {
      const entry = interest[dim][values[v]] || createFeatureEntry();
      entry.score += perValue;
      if (perValue > 0) entry.positive += perValue;
      else entry.negative += perValue;
      entry.count += 1;
      entry.lastAction = action;
      entry.lastUpdated = now;
      if (action === 'like') entry.liked = true;
      if (action === 'unlike') entry.liked = false;
      if (action === 'dislike') entry.disliked = true;
      if (action === 'undislike') entry.disliked = false;
      interest[dim][values[v]] = entry;
    }
  }
  interest.evidence += 1;
  interest.updatedAt = now;
  await saveInterest(profile.id, interest);

  const history = await loadHistory(profile.id);
  history.push({
    at: now,
    action: action,
    songId: normalizeId(song && song.id),
    title: String((song && song.title) || ''),
    artist: String((song && song.artist) || ''),
    extra: extra || null
  });
  const limit = Math.max(50, Number(config.historyLimit) || 500);
  await storageSet(SKEY.history(profile.id), history.slice(-limit));
  return { applied: true, weight: weight, evidence: interest.evidence };
}
/* ─── 标签体系（内置字典） ───
 * 曲库没有 genre/style/language/year 字段，标签分为四组，分别落到四个打分维度：
 * 流派 → genres(12)、风格 → styles(10)、语种 → languages(8)、年代 → decades(7)
 */
const TAG_GROUPS = [
  { id: 'genre', name: '流派', dimension: 'genres', tags: ['民谣', '电子', '另类/独立', '轻音乐', '综艺', '影视原声', 'ACG'] },
  { id: 'language', name: '语种', dimension: 'languages', tags: ['华语', '欧美', '日语', '韩语', '粤语'] },
  { id: 'style', name: '风格', dimension: 'styles', tags: ['流行', '摇滚', '民谣', '电子', '舞曲', '说唱', '轻音乐', '爵士', '乡村', 'R&B/Soul', '古典', '民族', '英伦', '金属', '朋克', '蓝调', '雷鬼', '世界音乐', '拉丁', 'New Age', '古风', '后摇', 'Bossa Nova'] },
  { id: 'decade', name: '年代', dimension: 'decades', tags: ['1950s', '1960s', '1970s', '1980s', '1990s', '2000s', '2010s', '2020s'] }
];

const AI_PROVIDERS = [
  { id: 'deepseek', name: 'DeepSeek 官方', baseUrl: 'https://api.deepseek.com/v1', defaultModel: 'deepseek-chat', apiKeyUrl: 'https://platform.deepseek.com/api_keys' },
  { id: 'siliconflow', name: '硅基流动 SiliconFlow', baseUrl: 'https://api.siliconflow.cn/v1', defaultModel: 'Qwen/Qwen3-32B', apiKeyUrl: 'https://cloud.siliconflow.cn/account/ak' },
  { id: 'zhipu', name: '智谱 BigModel', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', defaultModel: 'glm-4-flash', apiKeyUrl: 'https://open.bigmodel.cn/usercenter/apikeys' },
  { id: 'dashscope', name: '阿里云百炼 DashScope', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', defaultModel: 'qwen-flash', apiKeyUrl: 'https://bailian.console.aliyun.com/#/api-key' },
  { id: 'volcengine', name: '火山方舟 Ark', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', defaultModel: 'doubao-seed-1-6', apiKeyUrl: 'https://console.volcengine.com/ark' },
  { id: 'moonshot', name: 'Kimi / Moonshot', baseUrl: 'https://api.moonshot.cn/v1', defaultModel: 'moonshot-v1-8k', apiKeyUrl: 'https://platform.moonshot.cn/console/api-keys' },
  { id: 'minimax', name: 'MiniMax', baseUrl: 'https://api.minimax.chat/v1', defaultModel: 'abab6.5s-chat', apiKeyUrl: 'https://platform.minimaxi.com' },
  { id: 'hunyuan', name: '腾讯混元', baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1', defaultModel: 'hunyuan-turbo', apiKeyUrl: 'https://console.cloud.tencent.com/hunyuan/api-key' },
  { id: 'custom', name: '自定义（OpenAI 兼容）', baseUrl: '', defaultModel: '', apiKeyUrl: '' }
];

const TAG_DIMENSION_BY_GROUP = { genre: 'genres', style: 'styles', language: 'languages', decade: 'decades' };
const TAG_LOOKUP = (function () {
  const map = {};
  for (let i = 0; i < TAG_GROUPS.length; i++) {
    const group = TAG_GROUPS[i];
    for (let t = 0; t < group.tags.length; t++) {
      const tag = group.tags[t];
      if (!map[tag]) map[tag] = { group: group.id, dimension: group.dimension };
    }
  }
  return map;
})();

/* ─── 歌曲级标签存储 ───
 * 紧凑结构以控制单键体积：g=流派 s=风格 l=语种 d=年代
 */
let songTags = {};

function emptySongTagEntry() {
  return { g: [], s: [], l: [], d: [], src: '', conf: 0, locked: false, at: 0 };
}

function uniqueTags(value) {
  return normalizeStringList(value).slice(0, 6);
}

function normalizeSongTagEntry(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    g: uniqueTags(src.g !== undefined ? src.g : src.genres),
    s: uniqueTags(src.s !== undefined ? src.s : src.styles),
    l: uniqueTags(src.l !== undefined ? src.l : src.languages),
    d: uniqueTags(src.d !== undefined ? src.d : src.decades),
    src: String(src.src || src.source || '').slice(0, 10),
    conf: clamp(Number(src.conf !== undefined ? src.conf : src.confidence) || 0, 0, 1),
    locked: Boolean(src.locked),
    at: Number(src.at || src.updatedAt) || 0
  };
}

function normalizeSongTags(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  const keys = Object.keys(raw);
  for (let i = 0; i < keys.length; i++) {
    const id = normalizeId(keys[i]);
    if (!id) continue;
    const entry = normalizeSongTagEntry(raw[keys[i]]);
    if (entry.g.length || entry.s.length || entry.l.length || entry.d.length) out[id] = entry;
  }
  return out;
}

async function loadSongTags() {
  songTags = normalizeSongTags(await storageGet(SKEY.songTags, null));
  return songTags;
}

async function saveSongTags() {
  await storageSet(SKEY.songTags, songTags);
}

function songTagEntry(songId) {
  return songTags[normalizeId(songId)] || null;
}

function entryToDimensions(entry) {
  return {
    genres: (entry && entry.g) || [],
    styles: (entry && entry.s) || [],
    languages: (entry && entry.l) || [],
    decades: (entry && entry.d) || []
  };
}

/** 合并规则：某个维度有歌曲级标签就整体覆盖歌手级，避免重复计分 */
function effectiveTagsForSong(song) {
  const dims = { genres: [], styles: [], languages: [], decades: [] };
  const artistTags = tagsForArtist(song && song.artist);
  for (let i = 0; i < artistTags.length; i++) {
    const dim = classifyTag(artistTags[i]);
    if (dims[dim] && dims[dim].indexOf(artistTags[i]) < 0) dims[dim].push(artistTags[i]);
  }
  const entry = songTagEntry(song && song.id);
  if (entry) {
    const own = entryToDimensions(entry);
    if (own.genres.length) dims.genres = own.genres.slice();
    if (own.styles.length) dims.styles = own.styles.slice();
    if (own.languages.length) dims.languages = own.languages.slice();
    if (own.decades.length) dims.decades = own.decades.slice();
  }
  return dims;
}

function applyTagFeatures(song, features, push) {
  const dims = effectiveTagsForSong(song);
  const names = ['genres', 'styles', 'languages', 'decades'];
  for (let d = 0; d < names.length; d++) {
    const dim = names[d];
    for (let i = 0; i < dims[dim].length; i++) push(dim, dims[dim][i]);
  }
}

function computeTagCoverage(library) {
  const stats = { total: 0, genres: 0, styles: 0, languages: 0, decades: 0, any: 0, full: 0 };
  const songs = Array.isArray(library) ? library : [];
  stats.total = songs.length;
  for (let i = 0; i < songs.length; i++) {
    const entry = songTagEntry(songs[i] && songs[i].id);
    if (!entry) continue;
    if (entry.g.length) stats.genres += 1;
    if (entry.s.length) stats.styles += 1;
    if (entry.l.length) stats.languages += 1;
    if (entry.d.length) stats.decades += 1;
    if (entry.g.length || entry.s.length || entry.l.length || entry.d.length) stats.any += 1;
    if (entry.g.length && entry.s.length && entry.l.length && entry.d.length) stats.full += 1;
  }
  stats.anyRatio = stats.total ? round(stats.any / stats.total, 4) : 0;
  stats.fullRatio = stats.total ? round(stats.full / stats.total, 4) : 0;
  return stats;
}

/** 返回缺失的维度键：g=流派 s=风格 l=语种 d=年代 */
function songTagMissingDims(entry) {
  const missing = [];
  if (!entry || !entry.g.length) missing.push('g');
  if (!entry || !entry.s.length) missing.push('s');
  if (!entry || !entry.l.length) missing.push('l');
  if (!entry || !entry.d.length) missing.push('d');
  return missing;
}

function songTagStatus(entry) {
  if (!entry || (!entry.g.length && !entry.s.length && !entry.l.length && !entry.d.length)) return 'empty';
  return songTagMissingDims(entry).length ? 'partial' : 'full';
}

/** 待补全 = 未锁定且四维不全；锁定项视为人工已完成，AI 不再处理 */
function countPendingTags(library) {
  const songs = Array.isArray(library) ? library : [];
  let pending = 0;
  let locked = 0;
  for (let i = 0; i < songs.length; i++) {
    const entry = songTagEntry(songs[i] && songs[i].id);
    if (entry && entry.locked) {
      locked += 1;
      continue;
    }
    if (songTagMissingDims(entry).length) pending += 1;
  }
  return { pending: pending, locked: locked };
}

function songTagDetailRow(song) {
  const id = normalizeId(song && song.id);
  const entry = songTagEntry(id);
  const tags = entryToDimensions(entry);
  return {
    id: id,
    title: String((song && song.title) || ''),
    artist: String((song && song.artist) || ''),
    album: String((song && song.album) || ''),
    type: String((song && song.type) || ((song && song.file_path) ? 'local' : '')),
    hasFile: Boolean(song && song.file_path),
    hostGenre: String((song && song.genre) || ''),
    hostYear: Number((song && song.year) || 0) || 0,
    tags: tags,
    singerTags: tagsForArtist(song && song.artist),
    status: songTagStatus(entry),
    missing: songTagMissingDims(entry),
    source: entry ? entry.src : '',
    confidence: entry ? entry.conf : 0,
    locked: entry ? entry.locked : false,
    updatedAt: entry ? entry.at : 0
  };
}

/* ─── 语种自动识别（零成本，先跑一遍给全库补语种） ─── */
function detectLanguage(text) {
  const value = String(text || '');
  if (!value) return '';
  if (/[\uac00-\ud7af]/.test(value)) return '韩语';
  if (/[\u3040-\u30ff\u31f0-\u31ff]/.test(value)) return '日语';
  if (/[\u4e00-\u9fff]/.test(value)) return '华语';
  if (/[A-Za-z]/.test(value)) return '欧美';
  return '';
}

/* ─── AI 客户端（OpenAI 兼容） ─── */
function normalizeAiBaseUrl(url) {
  let base = String(url || '').trim().replace(/\/+$/, '');
  if (!base) return '';
  if (/\/(v1|v2|v3|v4)$/i.test(base)) return base;
  return base + '/v1';
}

function aiModelsUrl() {
  const base = normalizeAiBaseUrl(config.aiApiUrl);
  return base ? base + '/models' : '';
}

function aiChatUrl() {
  const base = normalizeAiBaseUrl(config.aiApiUrl);
  return base ? base + '/chat/completions' : '';
}

const AI_RESERVED_HEADERS = ['authorization', 'content-type', 'host', 'content-length', 'transfer-encoding', 'connection', 'x-fetch-timeout-ms'];

function validateAiHeaders(raw) {
  if (raw === null || raw === undefined || raw === '') return {};
  if (typeof raw === 'string') {
    const text = raw.trim();
    raw = text ? JSON.parse(text) : {};
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('必须是 JSON 对象');
  const result = {};
  const keys = Object.keys(raw);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const lower = key.toLowerCase();
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(key)) throw new Error('请求头名称无效：' + key);
    if (AI_RESERVED_HEADERS.indexOf(lower) >= 0) throw new Error('不能覆盖请求头：' + key);
    if (typeof raw[key] !== 'string' || /[\x00-\x1f\x7f]/.test(raw[key])) throw new Error('请求头值必须是字符串：' + key);
    if (result[lower] !== undefined) throw new Error('请求头重复：' + key);
    result[lower] = raw[key];
  }
  return result;
}

function normalizeAiHeaders(raw) {
  try { return validateAiHeaders(raw); } catch (e) { return {}; }
}

function aiRequestHeaders() {
  const headers = normalizeAiHeaders(config.aiHeaders);
  headers['Content-Type'] = 'application/json';
  headers.Authorization = 'Bearer ' + config.aiApiKey;
  return headers;
}

function aiTimeoutMs() {
  return Math.round(clamp(config.aiTimeoutSec, 5, 120) * 1000);
}

async function requestAi(url, options) {
  const timeout = aiTimeoutMs();
  let timer = null;
  const deadline = new Promise(function (_, reject) {
    timer = setTimeout(function () { reject(new Error('AI 请求超时（' + Math.round(timeout / 1000) + ' 秒）')); }, timeout);
  });
  try {
    const init = Object.assign({}, options, {
      headers: Object.assign({}, options.headers, { 'X-Fetch-Timeout-Ms': String(timeout) })
    });
    const response = await Promise.race([fetch(url, init), deadline]);
    if (!response || typeof response.status !== 'number') throw new Error('AI 响应无效');
    if (!response.ok) {
      let body = '';
      try { body = await response.text(); } catch (e) { /* ignore */ }
      throw new Error('AI 接口返回 ' + response.status + '：' + String(body || '').slice(0, 200));
    }
    return response;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function aiFetchModels() {
  if (!config.aiApiUrl) throw new Error('请先填写 API 地址');
  if (!config.aiApiKey) throw new Error('请先填写 API 密钥');
  const response = await requestAi(aiModelsUrl(), { method: 'GET', headers: aiRequestHeaders() });
  const data = await response.json();
  if (!data || !Array.isArray(data.data)) throw new Error('模型列表格式异常：缺少 data 数组');
  const ids = [];
  for (let i = 0; i < data.data.length; i++) {
    const id = String((data.data[i] && data.data[i].id) || '');
    if (id) ids.push(id);
  }
  ids.sort();
  return ids;
}

async function aiChat(messages, maxTokens, jsonMode) {
  if (!config.aiApiUrl) throw new Error('请先填写 API 地址');
  if (!config.aiApiKey) throw new Error('请先填写 API 密钥');
  if (!config.aiModel) throw new Error('请先填写模型名');
  const payload = {
    model: config.aiModel,
    messages: messages,
    temperature: 0.1,
    max_tokens: maxTokens || 4096,
    stream: false
  };
  if (jsonMode && config.aiJsonMode) payload.response_format = { type: 'json_object' };
  const response = await requestAi(aiChatUrl(), {
    method: 'POST',
    headers: aiRequestHeaders(),
    body: JSON.stringify(payload)
  });
  const data = await response.json();
  const choice = data && data.choices && data.choices[0];
  const content = choice && choice.message && choice.message.content;
  const finishReason = String((choice && choice.finish_reason) || '');
  const usage = (data && data.usage) || null;
  if (!content) {
    const reasoning = choice && choice.message && choice.message.reasoning_content;
    const detail = [
      'finish_reason=' + (finishReason || '未知'),
      'usage=' + JSON.stringify(usage || {}),
      reasoning ? ('reasoning_content 长度 ' + String(reasoning).length) : '无 reasoning_content'
    ].join('，');
    throw new Error('AI 返回内容为空（' + detail + '）');
  }
  return { text: String(content), finishReason: finishReason, usage: usage };
}

async function aiChatText(messages, maxTokens, jsonMode) {
  const reply = await aiChat(messages, maxTokens, jsonMode);
  return reply.text;
}

async function aiTestConnection() {
  const started = Date.now();
  try {
    const models = await aiFetchModels();
    return { ok: true, kind: 'models', models: models, elapsedMs: Date.now() - started };
  } catch (modelsError) {
    try {
      const reply = await aiChatText([{ role: 'user', content: '只回复 OK' }], 16, false);
      return {
        ok: true,
        kind: 'chat',
        models: [config.aiModel],
        reply: reply.slice(0, 40),
        warning: '模型列表不可用，已用对话接口验证：' + modelsError.message,
        elapsedMs: Date.now() - started
      };
    } catch (chatError) {
      return {
        ok: false,
        error: '模型列表：' + modelsError.message + '；对话：' + chatError.message,
        elapsedMs: Date.now() - started
      };
    }
  }
}

/* ─── AI 批量打标 ─── */
function tagTaxonomyText() {
  const lines = [];
  for (let i = 0; i < TAG_GROUPS.length; i++) {
    lines.push(TAG_GROUPS[i].name + '：' + TAG_GROUPS[i].tags.join('、'));
  }
  return lines.join('\n');
}

function extractJson(text) {
  let raw = String(text || '').trim();
  raw = raw.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) raw = raw.slice(start, end + 1);
  return JSON.parse(raw);
}

function allowedTagOfGroup(value, groupId) {
  const tag = String(value === null || value === undefined ? '' : value).trim();
  if (!tag || tag === 'null' || tag === '未知') return '';
  for (let i = 0; i < TAG_GROUPS.length; i++) {
    const group = TAG_GROUPS[i];
    if (group.id === groupId) return group.tags.indexOf(tag) >= 0 ? tag : '';
  }
  return '';
}

async function aiTagBatch(batch) {
  const songs = [];
  const dimNames = { g: '流派', s: '风格', l: '语种', d: '年代' };
  for (let i = 0; i < batch.length; i++) {
    const song = batch[i];
    const missing = songTagMissingDims(songTagEntry(song.id)).map(function (key) { return dimNames[key]; });
    songs.push({
      id: String(song.id),
      title: String(song.title || ''),
      artist: String(song.artist || ''),
      album: String(song.album || ''),
      duration: Number(song.duration) || 0,
      missing: missing
    });
  }
  const system = [
    '你是严谨的音乐分类专家，只根据给定的歌名、歌手、专辑做判断，不要编造。',
    '可用标签：',
    tagTaxonomyText(),
    '规则：',
    '1. genre 只能从「流派」列表选一个；style 只能从「风格」列表选一个；language 只能从「语种」列表选一个；decade 只能从「年代」列表选一个。',
    '2. 无法判断的字段填 null，不要猜测。',
    '3. 粤语歌曲 language 必须填「粤语」；纯音乐或无歌词 language 填 null。',
    '4. decade 按专辑发行年代判断；不确定填 null。',
    '5. confidence 为 0~1，表示你对这组标签的整体确信度。',
    '6. 每首歌的 missing 列出需要补的维度；已有维度不要改动，只补 missing 中的维度，其余填 null。',
    '7. 只输出 JSON，不要解释。',
    '{"items":[{"id":"歌曲id","genre":"流派或null","style":"风格或null","language":"语种或null","decade":"年代或null","confidence":0.8}]}'
  ].join('\n');
  const user = '请为下列歌曲打标签：\n' + JSON.stringify(songs);
  const reply = await aiChat([
    { role: 'system', content: system },
    { role: 'user', content: user }
  ], 4096, true);
  let parsed = null;
  try {
    parsed = extractJson(reply.text);
  } catch (e) {
    throw new Error('AI 返回不是合法 JSON（finish_reason=' + (reply.finishReason || '未知')
      + '，长度 ' + reply.text.length + '）：' + String(e.message || e).slice(0, 80));
  }
  if (!parsed || !Array.isArray(parsed.items)) {
    throw new Error('AI 返回缺少 items 数组（finish_reason=' + (reply.finishReason || '未知')
      + '，长度 ' + reply.text.length + '）');
  }
  return { items: parsed.items, finishReason: reply.finishReason, usage: reply.usage };
}

const AI_RESULT_LIMIT = 300;

let aiJob = {
  running: false, startedAt: 0, finishedAt: 0, total: 0, done: 0, stored: 0,
  skipped: 0, failed: 0, batches: 0, prefilled: 0, message: '', error: '',
  targetScope: 'library', results: []
};
let aiStopRequested = false;

function aiJobSnapshot() {
  return Object.assign({}, aiJob, { stopRequested: aiStopRequested, resultLimit: AI_RESULT_LIMIT });
}

async function persistAiJob() {
  await storageSet(SKEY.aiProgress, aiJobSnapshot());
}

async function loadAiJob() {
  const raw = await storageGet(SKEY.aiProgress, null);
  if (raw && typeof raw === 'object') {
    aiJob = Object.assign(aiJob, {
      running: false,
      startedAt: Number(raw.startedAt) || 0,
      finishedAt: Number(raw.finishedAt) || 0,
      total: Number(raw.total) || 0,
      done: Number(raw.done) || 0,
      stored: Number(raw.stored) || 0,
      skipped: Number(raw.skipped) || 0,
      failed: Number(raw.failed) || 0,
      batches: Number(raw.batches) || 0,
      prefilled: Number(raw.prefilled) || 0,
      message: String(raw.message || ''),
      error: String(raw.error || ''),
      targetScope: String(raw.targetScope || 'library'),
      results: Array.isArray(raw.results) ? raw.results.slice(-AI_RESULT_LIMIT) : []
    });
  }
}

function sleepMs(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function aiResultOf(song, status, reason, entry) {
  return {
    id: normalizeId(song && song.id),
    title: String((song && song.title) || ''),
    artist: String((song && song.artist) || ''),
    status: status,
    reason: String(reason || ''),
    tags: entry ? entryToDimensions(entry) : null,
    source: entry ? entry.src : '',
    confidence: entry ? entry.conf : 0,
    locked: entry ? entry.locked : false,
    at: Date.now()
  };
}

function recordAiResult(song, status, reason, entry) {
  aiJob.results.push(aiResultOf(song, status, reason, entry));
  if (aiJob.results.length > AI_RESULT_LIMIT) {
    aiJob.results.splice(0, aiJob.results.length - AI_RESULT_LIMIT);
  }
}

/**
 * 写入单首 AI 结果。返回 { ok, reason }：
 * 非 force 时只补缺失维度，已有维度一律保留；force 时覆盖未锁定项。
 */
function applyAiTagItem(item, allowedIds, minConfidence, options) {
  const opts = options || {};
  const force = opts.force === true;
  const id = normalizeId(item && item.id);
  if (!id) return { ok: false, reason: 'AI 返回缺少歌曲 ID' };
  if (!allowedIds[id]) return { ok: false, reason: 'AI 返回了本批次之外的歌曲 ID' };
  const confidence = clamp(Number(item.confidence) || 0, 0, 1);
  if (confidence < minConfidence) {
    return { ok: false, reason: '置信度 ' + round(confidence, 2) + ' 低于阈值 ' + round(minConfidence, 2) };
  }
  const genre = allowedTagOfGroup(item.genre, 'genre');
  const style = allowedTagOfGroup(item.style, 'style');
  const language = allowedTagOfGroup(item.language, 'language');
  const decade = allowedTagOfGroup(item.decade, 'decade');
  if (!genre && !style && !language && !decade) {
    return { ok: false, reason: 'AI 未给出有效标签（全为 null 或不在固定枚举内）' };
  }
  const existing = songTags[id];
  if (existing && existing.locked) return { ok: false, reason: '已锁定，AI 不覆盖手动标签' };
  const entry = existing || emptySongTagEntry();
  let added = 0;
  if (genre && (force || !entry.g.length)) { entry.g = [genre]; added += 1; }
  if (style && (force || !entry.s.length)) { entry.s = [style]; added += 1; }
  if (language && (force || !entry.l.length)) { entry.l = [language]; added += 1; }
  if (decade && (force || !entry.d.length)) { entry.d = [decade]; added += 1; }
  if (!added) return { ok: false, reason: '缺失维度没有新增标签（已有标签保留）' };
  entry.src = 'ai';
  entry.conf = confidence;
  entry.at = Date.now();
  entry.locked = false;
  songTags[id] = entry;
  return { ok: true, reason: '', entry: entry };
}

async function runAiTagJob(options) {
  if (aiJob.running) throw new Error('已有补全任务在运行');
  if (!config.aiEnabled) throw new Error('请先启用 AI 标签');
  if (!config.aiApiUrl || !config.aiApiKey || !config.aiModel) throw new Error('AI 配置不完整');

  const opts = options || {};
  const force = opts.force === true;
  // AI 覆盖全库（含本地），不再只看推荐候选；锁定项视为人工完成，直接排除
  const library = await getLibrary();
  let targets = [];
  for (let i = 0; i < library.length; i++) {
    const song = library[i];
    const entry = songTagEntry(song.id);
    if (entry && entry.locked) continue;
    if (!force && !songTagMissingDims(entry).length) continue;
    targets.push(song);
  }
  const limit = Number(config.aiMaxSongsPerRun) || 0;
  if (limit > 0) targets = targets.slice(0, limit);

  aiStopRequested = false;
  aiJob = {
    running: true, startedAt: Date.now(), finishedAt: 0,
    total: targets.length, done: 0, stored: 0, skipped: 0, failed: 0,
    batches: 0, prefilled: 0, message: '准备中', error: '',
    targetScope: 'library', results: []
  };
  await persistAiJob();

  // 第一阶段：零成本语种识别
  let prefilled = 0;
  if (config.autoTagLanguage) {
    for (let i = 0; i < targets.length; i++) {
      const song = targets[i];
      const id = normalizeId(song.id);
      const existing = songTags[id];
      if (existing && existing.locked) continue;
      const language = detectLanguage(String(song.title || '') + ' ' + String(song.artist || ''));
      if (!language) continue;
      const entry = existing || emptySongTagEntry();
      if (entry.l.length) continue;
      entry.l = [language];
      entry.src = entry.src || 'auto';
      entry.conf = Math.max(entry.conf || 0, 0.85);
      entry.at = Date.now();
      songTags[id] = entry;
      prefilled += 1;
    }
    await saveSongTags();
    aiJob.prefilled = prefilled;
    aiJob.message = prefilled
      ? ('已预填语种 ' + prefilled + ' 首，开始 AI 打标')
      : '开始 AI 打标';
    await persistAiJob();
    if (prefilled) log('AI 标签补全：本地语种预填 ' + prefilled + ' 首');
  }

  const batchSize = Math.max(5, Math.min(50, Number(config.aiBatchSize) || 20));
  const minConfidence = clamp(Number(config.aiMinConfidence), 0, 1);
  let stored = 0;
  let skipped = 0;
  let failed = 0;

  for (let offset = 0; offset < targets.length; offset += batchSize) {
    if (aiStopRequested) break;
    const batch = targets.slice(offset, offset + batchSize);
    const allowedIds = {};
    for (let i = 0; i < batch.length; i++) allowedIds[normalizeId(batch[i].id)] = batch[i];
    let okCount = 0;
    let skipCount = 0;
    try {
      const reply = await aiTagBatch(batch);
      const items = reply.items;
      if (!items.length) throw new Error('AI 返回 items 数组为空（finish_reason=' + (reply.finishReason || '未知') + '）');
      const returned = {};
      let malformed = 0;
      for (let i = 0; i < items.length; i++) {
        const itemId = normalizeId(items[i] && items[i].id);
        if (!allowedIds[itemId]) { malformed += 1; continue; }
        if (returned[itemId]) { malformed += 1; continue; }
        returned[itemId] = true;
        const result = applyAiTagItem(items[i], allowedIds, minConfidence, { force: force });
        if (result.ok) {
          okCount += 1;
          recordAiResult(allowedIds[itemId], 'ok', '', songTags[itemId]);
        } else {
          skipCount += 1;
          recordAiResult(allowedIds[itemId], 'skip', result.reason, null);
        }
      }
      // AI 没返回的歌曲单独记原因，避免和置信度/枚举问题混在一起
      for (let i = 0; i < batch.length; i++) {
        const id = normalizeId(batch[i].id);
        if (returned[id]) continue;
        skipCount += 1;
        recordAiResult(batch[i], 'skip', 'AI 未返回该歌曲', null);
      }
      stored += okCount;
      skipped += skipCount;
      aiJob.error = '';
      if (reply.finishReason && reply.finishReason !== 'stop') {
        logWarn('AI 标签批次结束原因：' + reply.finishReason + '（第 ' + (aiJob.batches + 1) + ' 批）');
      }
      if (malformed) logWarn('AI 标签批次返回 ' + malformed + ' 条无效/重复 ID（第 ' + (aiJob.batches + 1) + ' 批）');
      log('AI 标签批次完成（第 ' + (aiJob.batches + 1) + ' 批）：本批 ' + batch.length
        + ' 首 · AI 返回 ' + items.length + ' 条 · 写入 ' + okCount + ' · 跳过 ' + skipCount);
    } catch (e) {
      failed += batch.length;
      aiJob.error = e.message;
      for (let i = 0; i < batch.length; i++) {
        recordAiResult(batch[i], 'fail', '批次失败：' + e.message, null);
      }
      const sample = batch.slice(0, 3).map(function (song) {
        return String(song.title || song.id);
      }).join('、');
      logWarn('AI 标签批次失败（第 ' + (aiJob.batches + 1) + ' 批，' + batch.length
        + ' 首）：' + e.message + (sample ? '；示例：' + sample : ''));
    }
    aiJob.batches += 1;
    aiJob.done = Math.min(targets.length, offset + batch.length);
    aiJob.stored = stored;
    aiJob.skipped = skipped;
    aiJob.failed = failed;
    aiJob.prefilled = prefilled;
    aiJob.message = '已处理 ' + aiJob.done + '/' + targets.length + ' 首'
      + '（写入 ' + stored + ' · 跳过 ' + skipped + ' · 失败 ' + failed + '）';
    await saveSongTags();
    await persistAiJob();
    await sleepMs(200);
  }

  aiJob.running = false;
  aiJob.finishedAt = Date.now();
  aiJob.stored = stored;
  aiJob.skipped = skipped;
  aiJob.failed = failed;
  aiJob.prefilled = prefilled;
  aiJob.message = (aiStopRequested ? '已停止' : '完成')
    + '：AI 更新 ' + stored + ' 首，跳过 ' + skipped + ' 首，失败 ' + failed + ' 首'
    + (prefilled ? '；本地预填语种 ' + prefilled + ' 首' : '');
  if (aiStopRequested) aiJob.error = '';
  await saveSongTags();
  await persistAiJob();
  log('AI 标签补全结束：' + aiJob.message);
  return aiJobSnapshot();
}
/* ─── 路由 ─── */
function createRouter() {
  const routes = [];
  return {
    get: function (path, handler) { routes.push({ method: 'GET', path: path, handler: handler }); },
    post: function (path, handler) { routes.push({ method: 'POST', path: path, handler: handler }); },
    handle: async function (req) {
      const method = String((req && req.method) || 'GET').toUpperCase();
      const path = String((req && req.path) || '');
      for (let i = 0; i < routes.length; i++) {
        const route = routes[i];
        if (route.method === method && route.path === path) {
          try { return await route.handler(req); }
          catch (e) {
            logWarn('端点 ' + path + ' 异常：' + e.message);
            return jsonResponse({ error: e.message }, 500);
          }
        }
      }
      return jsonResponse({ error: 'Not Found: ' + path }, 404);
    }
  };
}

const router = createRouter();

function profileRefOf(value) {
  if (!value) return '';
  if (typeof value === 'object') return normalizeId(value.id || value.profile);
  return normalizeId(value);
}

function resolveProfileRef(value) {
  const ref = profileRefOf(value);
  if (!ref) return getDefaultProfile();
  return findProfileByRef(ref);
}

router.get('/api/status', async function () {
  return jsonResponse({
    version: PLUGIN_VERSION,
    initialized: initialized,
    profiles: profiles.length,
    library: {
      cached: Boolean(libraryCache),
      count: libraryCache ? libraryCache.length : 0,
      loadedAt: libraryCacheAt
    },
    favorites: { count: favoriteIds.size, syncedAt: favoriteSyncedAt },
    singerTags: Object.keys(singerTags).length,
    songTags: Object.keys(songTags).length,
    ai: { enabled: config.aiEnabled, model: config.aiModel, running: aiJob.running },
    config: config
  });
});

router.get('/api/logs', async function (req) {
  const q = parseQuery(req.query);
  if (q.clear) {
    logBuf.length = 0;
    pushLog('INFO', '日志已清空');
  }
  return jsonResponse({ ok: true, lines: logBuf.slice() });
});

/* 画像 CRUD */
router.get('/api/profiles', async function () {
  const list = [];
  for (let i = 0; i < profiles.length; i++) {
    const profile = profiles[i];
    const interest = await loadInterest(profile.id);
    const manual = await loadManual(profile.id);
    const pool = await loadPool(profile.id);
    list.push(Object.assign({}, profile, {
      interest: summarizeInterest(interest),
      manual: manual,
      poolSize: pool.length
    }));
  }
  const fallback = getDefaultProfile();
  return jsonResponse({ profiles: list, defaultId: fallback ? fallback.id : null });
});

router.post('/api/profiles', async function (req) {
  const body = parseBody(req);
  const action = String(body.action || 'create');
  if (action === 'create') {
    const input = body.profile && typeof body.profile === 'object' ? body.profile : body;
    const result = await createProfile(input);
    if (result.error) return badRequest(result.error);
  } else if (action === 'update') {
    const input = Object.assign({}, body.profile && typeof body.profile === 'object' ? body.profile : {});
    if (!input.id && body.id) input.id = body.id;
    const result = await updateProfile(input);
    if (result.error) return badRequest(result.error);
  } else if (action === 'delete') {
    const id = body.id || (body.profile && body.profile.id) || body.profile;
    const result = await deleteProfile(id);
    if (result.error) return badRequest(result.error);
  } else {
    return badRequest('未知操作：' + action);
  }
  return jsonResponse({ ok: true, profiles: profiles });
});

/* 手动画像 */
router.get('/api/manual', async function (req) {
  const q = parseQuery(req.query);
  const profile = resolveProfileRef(q.profile);
  if (!profile) return badRequest('画像不存在：' + normalizeId(q.profile));
  const manual = await loadManual(profile.id);
  return jsonResponse({ profile: profile, manual: manual });
});

router.post('/api/manual', async function (req) {
  const body = parseBody(req);
  const profile = resolveProfileRef(body.profile || body.profileId);
  if (!profile) return badRequest('画像不存在：' + normalizeId(body.profile || body.profileId));
  const manual = await saveManual(profile.id, body.manual || body);
  log('更新画像「' + profile.name + '」手动画像：歌手 '
    + Object.keys(manual.artists).length + ' 个，标签 ' + Object.keys(manual.tags).length + ' 个');
  return jsonResponse({ ok: true, profile: profile, manual: manual });
});

/* 歌手标签库 */
router.get('/api/singer-tags', async function () {
  const list = Object.keys(singerTags).sort().map(function (singer) {
    return { singer: singer, tags: singerTags[singer] };
  });
  return jsonResponse({ tags: singerTags, list: list, count: list.length });
});

router.post('/api/singer-tags', async function (req) {
  const body = parseBody(req);
  const action = String(body.action || 'save');
  if (action === 'clear') {
    singerTags = {};
    await saveSingerTags();
    log('歌手标签库已清空');
    return jsonResponse({ ok: true, tags: singerTags });
  }
  const singer = String(body.singer || '').trim();
  if (!singer) return badRequest('缺少歌手名');
  if (action === 'delete') {
    delete singerTags[singer];
    await saveSingerTags();
    log('删除歌手标签：' + singer);
    return jsonResponse({ ok: true, tags: singerTags });
  }
  const tags = normalizeStringList(body.tags);
  if (!tags.length) return badRequest('至少填写一个标签');
  singerTags[singer] = tags;
  await saveSingerTags();
  log('歌手标签更新：' + singer + ' → ' + tags.join('/'));
  return jsonResponse({ ok: true, singer: singer, tags: tags, all: singerTags });
});

/* 配置 */
router.get('/api/config', async function () {
  return jsonResponse({ config: config, defaults: DEFAULT_CONFIG });
});

router.post('/api/config', async function (req) {
  const body = parseBody(req);
  const incoming = body.config && typeof body.config === 'object' ? body.config : body;
  if (incoming.aiHeaders !== undefined) {
    try { incoming.aiHeaders = validateAiHeaders(incoming.aiHeaders); }
    catch (e) { return badRequest('自定义请求头无效：' + e.message); }
  }
  const next = Object.assign({}, config);
  for (let i = 0; i < CONFIG_FIELDS.length; i++) {
    const field = CONFIG_FIELDS[i];
    if (incoming[field] !== undefined) next[field] = incoming[field];
  }
  config = normalizeConfig(next);
  await saveConfig();
  libraryCache = null;
  libraryCacheAt = 0;
  log('配置已保存：候选来源 ' + config.candidateSource + '，池容量 ' + config.poolSize);
  return jsonResponse({ ok: true, config: config });
});

/* 今日推荐（P2 会复用同一套排序，只是出口改成歌单 + 音箱播放） */
router.get('/api/recommend', async function (req) {
  const q = parseQuery(req.query);
  const profile = resolveProfileRef(q.profile);
  if (!profile) return badRequest('画像不存在：' + normalizeId(q.profile));
  const ranked = await rankForProfile(profile, q.count || config.queueBatch, {
    sessionId: q.session,
    refreshLibrary: q.refresh === '1',
    refreshFavorites: q.favoritesRefresh === '1'
  });
  return jsonResponse({
    profile: profile,
    items: ranked.items.map(formatRecommendItem),
    meta: ranked.meta
  });
});

/* 推荐池 */
router.get('/api/pool', async function (req) {
  const q = parseQuery(req.query);
  const profile = resolveProfileRef(q.profile);
  if (!profile) return badRequest('画像不存在：' + normalizeId(q.profile));
  const pool = await loadPool(profile.id);
  return jsonResponse({
    profile: profile,
    pool: pool,
    size: pool.length,
    capacity: config.poolSize
  });
});

router.post('/api/pool', async function (req) {
  const body = parseBody(req);
  const profile = resolveProfileRef(body.profile || body.profileId);
  if (!profile) return badRequest('画像不存在：' + normalizeId(body.profile || body.profileId));
  const action = String(body.action || 'refill');
  if (action === 'refill') {
    const result = await refillPool(profile, body.count || config.poolSize);
    return jsonResponse({ ok: true, action: action, result: result, pool: await loadPool(profile.id) });
  }
  if (action === 'checkout') {
    const result = await checkoutPool(profile, body.count || config.queueBatch);
    return jsonResponse({ ok: true, action: action, entries: result.entries, remaining: result.remaining });
  }
  if (action === 'release') {
    const result = await releaseSongs(profile.id, body.songIds || []);
    return jsonResponse({ ok: true, action: action, result: result });
  }
  if (action === 'clear') {
    await savePool(profile.id, []);
    return jsonResponse({ ok: true, action: action, size: 0 });
  }
  return badRequest('未知操作：' + action);
});

/* 收藏同步 */
router.post('/api/favorites/sync', async function () {
  const result = await syncFavorites(true);
  return jsonResponse({ ok: true, result: result, ids: Array.from(favoriteIds) });
});

/* ─── AI 配置与标签补全 ─── */
router.get('/api/ai/status', async function () {
  const library = await getLibrary();
  const candidates = filterCandidates(library);
  const pending = countPendingTags(library);
  return jsonResponse({
    ok: true,
    config: {
      enabled: config.aiEnabled,
      provider: config.aiProvider,
      apiUrl: config.aiApiUrl,
      model: config.aiModel,
      headers: config.aiHeaders,
      timeoutSec: config.aiTimeoutSec,
      batchSize: config.aiBatchSize,
      minConfidence: config.aiMinConfidence,
      jsonMode: config.aiJsonMode,
      autoTagLanguage: config.autoTagLanguage,
      maxSongsPerRun: config.aiMaxSongsPerRun,
      hasKey: Boolean(config.aiApiKey)
    },
    job: aiJobSnapshot(),
    // 覆盖率按全库统计；candidateCoverage 仅作参考（推荐候选可能是网络子集）
    coverage: computeTagCoverage(library),
    candidateCoverage: computeTagCoverage(candidates),
    libraryStats: computeLibraryStats(library),
    pending: pending.pending,
    lockedCount: pending.locked,
    candidateCount: candidates.length,
    scope: 'library',
    providers: AI_PROVIDERS,
    songTagCount: Object.keys(songTags).length
  });
});

router.get('/api/ai/models', async function () {
  try {
    const models = await aiFetchModels();
    return jsonResponse({ ok: true, models: models, count: models.length });
  } catch (e) {
    return jsonResponse({ error: e.message }, 400);
  }
});

router.post('/api/ai/test', async function () {
  const result = await aiTestConnection();
  if (!result.ok) return jsonResponse(Object.assign({ error: result.error }, result), 400);
  return jsonResponse(Object.assign({ ok: true }, result));
});

router.post('/api/ai/tag/run', async function (req) {
  if (aiJob.running) return badRequest('已有补全任务在运行');
  const body = parseBody(req);
  runAiTagJob(body).catch(function (e) {
    aiJob.running = false;
    aiJob.error = e.message;
    aiJob.message = '失败：' + e.message;
    try { persistAiJob(); } catch (ignore) { /* ignore */ }
    logWarn('AI 标签任务失败：' + e.message);
  });
  return jsonResponse({ ok: true, started: true, job: aiJobSnapshot() });
});

router.post('/api/ai/tag/stop', async function () {
  aiStopRequested = true;
  return jsonResponse({ ok: true, stopping: true });
});

router.get('/api/ai/tag/status', async function () {
  return jsonResponse({ ok: true, job: aiJobSnapshot() });
});

router.get('/api/tag-dictionary', async function () {
  return jsonResponse({ ok: true, groups: TAG_GROUPS, providers: AI_PROVIDERS });
});

/* 单曲标签 */
const TAG_DIM_TO_KEY = { genres: 'g', styles: 's', languages: 'l', decades: 'd' };

/** 歌曲标签明细：支持搜索、覆盖率维度筛选、来源/状态/类型筛选与分页 */
router.get('/api/song-tags/list', async function (req) {
  const q = parseQuery(req.query);
  const library = await getLibrary();
  const keyword = String(q.q || '').trim().toLowerCase();
  const dim = TAG_DIM_TO_KEY[String(q.dim || '')] ? String(q.dim) : '';
  const status = String(q.status || '');
  const source = String(q.source || '');
  const type = String(q.type || '');
  const rows = [];
  for (let i = 0; i < library.length; i++) {
    const song = library[i];
    const row = songTagDetailRow(song);
    if (type && row.type !== type) continue;
    if (source && row.source !== source) continue;
    if (dim && !row.tags[dim].length) continue;
    if (status === 'any' && row.status === 'empty') continue;
    if (status === 'full' && row.status !== 'full') continue;
    if (status === 'partial' && row.status !== 'partial') continue;
    if (status === 'empty' && row.status !== 'empty') continue;
    if (status === 'pending' && !(row.missing.length && !row.locked)) continue;
    if (status === 'locked' && !row.locked) continue;
    if (keyword) {
      const haystack = (row.title + ' ' + row.artist + ' ' + row.album + ' ' + row.id).toLowerCase();
      if (haystack.indexOf(keyword) < 0) continue;
    }
    rows.push(row);
  }
  rows.sort(function (a, b) {
    const diff = Number(b.updatedAt || 0) - Number(a.updatedAt || 0);
    if (diff) return diff;
    const left = String(a.title || a.id);
    const right = String(b.title || b.id);
    return left < right ? -1 : (left > right ? 1 : 0);
  });
  const pageSize = Math.round(clamp(Number(q.pageSize) || 20, 1, 200));
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  const page = Math.round(clamp(Number(q.page) || 1, 1, pages));
  const start = (page - 1) * pageSize;
  const pending = countPendingTags(library);
  return jsonResponse({
    ok: true,
    total: rows.length,
    page: page,
    pageSize: pageSize,
    pages: pages,
    items: rows.slice(start, start + pageSize),
    coverage: computeTagCoverage(library),
    libraryStats: computeLibraryStats(library),
    pending: pending.pending,
    lockedCount: pending.locked,
    songTagCount: Object.keys(songTags).length
  });
});

router.get('/api/song-tags', async function (req) {
  const q = parseQuery(req.query);
  const id = normalizeId(q.id);
  if (!id) return jsonResponse({ ok: true, count: Object.keys(songTags).length, tags: songTags });
  const library = await getLibrary();
  let song = null;
  for (let i = 0; i < library.length; i++) {
    if (normalizeId(library[i].id) === id) { song = library[i]; break; }
  }
  const entry = songTagEntry(id);
  const effective = song ? effectiveTagsForSong(song) : entryToDimensions(entry);
  return jsonResponse({
    ok: true,
    songId: id,
    entry: entry,
    effective: effective,
    song: song ? { id: id, title: song.title, artist: song.artist, album: song.album } : null
  });
});

router.post('/api/song-tags', async function (req) {
  const body = parseBody(req);
  const id = normalizeId(body.songId || body.id);
  if (!id) return badRequest('缺少 songId');
  if (String(body.action || 'save') === 'delete') {
    delete songTags[id];
    await saveSongTags();
    log('删除歌曲标签：' + id);
    return jsonResponse({ ok: true, deleted: id });
  }
  let input = body.tags;
  if (Array.isArray(input)) {
    const mapped = { genres: [], styles: [], languages: [], decades: [] };
    for (let i = 0; i < input.length; i++) {
      const dim = classifyTag(input[i]);
      if (mapped[dim] && mapped[dim].indexOf(String(input[i])) < 0) mapped[dim].push(String(input[i]));
    }
    input = mapped;
  }
  const entry = normalizeSongTagEntry(input);
  if (!entry.g.length && !entry.s.length && !entry.l.length && !entry.d.length) {
    return badRequest('至少选择一个标签');
  }
  entry.src = 'manual';
  entry.locked = body.locked === false ? false : true;
  entry.at = Date.now();
  songTags[id] = entry;
  await saveSongTags();
  log('歌曲标签更新：' + id + ' → ' + entry.g.concat(entry.s, entry.l, entry.d).join('/'));
  return jsonResponse({ ok: true, songId: id, entry: entry, effective: entryToDimensions(entry) });
});

router.get('/api/tags/coverage', async function () {
  const library = await getLibrary();
  const candidates = filterCandidates(library);
  const pending = countPendingTags(library);
  return jsonResponse({
    ok: true,
    coverage: computeTagCoverage(library),
    candidateCoverage: computeTagCoverage(candidates),
    libraryStats: computeLibraryStats(library),
    pending: pending.pending,
    lockedCount: pending.locked,
    scope: 'library',
    songTagCount: Object.keys(songTags).length
  });
});
/* ─── 生命周期 ─── */
let initialized = false;
let initializingPromise = null;

async function bootstrap() {
  await loadConfig();
  await loadProfiles();
  await loadSingerTags();
  await loadFavoritesCache();
  await loadSongTags();
  await loadAiJob();
  initialized = true;
}

async function ensureReady() {
  if (initialized) return;
  if (!initializingPromise) {
    initializingPromise = bootstrap().then(
      function () { initializingPromise = null; },
      function (error) { initializingPromise = null; throw error; }
    );
  }
  await initializingPromise;
}

globalThis.onInit = async function () {
  try {
    await ensureReady();
    log('个人电台已启动：画像 ' + profiles.length + ' 个');
  } catch (e) {
    logWarn('启动失败：' + e.message);
  }
};

globalThis.onDeinit = async function () {
  initialized = false;
  log('个人电台已卸载');
};

globalThis.onHTTPRequest = async function (req) {
  try {
    await ensureReady();
  } catch (e) {
    logWarn('初始化失败：' + e.message);
    return jsonResponse({ error: '插件初始化失败：' + e.message }, 500);
  }
  return router.handle(req);
};