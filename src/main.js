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

const PLUGIN_VERSION = '0.1.0';
const STORAGE_PREFIX = 'personalRadio.';
const MODEL_VERSION = 1;

const SKEY = {
  config: STORAGE_PREFIX + 'config',
  profiles: STORAGE_PREFIX + 'profiles',
  singerTags: STORAGE_PREFIX + 'singerTags',
  favorites: STORAGE_PREFIX + 'favorites',
  interest: function (id) { return STORAGE_PREFIX + 'profile.' + id + '.interest'; },
  pool: function (id) { return STORAGE_PREFIX + 'profile.' + id + '.pool'; },
  history: function (id) { return STORAGE_PREFIX + 'profile.' + id + '.history'; },
  manual: function (id) { return STORAGE_PREFIX + 'manual.' + id; }
};

const DEFAULT_CONFIG = {
  // P1 引擎参数
  candidateSource: 'remote',
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
  defaultPlayMode: 'order'
};

const CONFIG_FIELDS = [
  'candidateSource', 'poolSize', 'queueBatch', 'explorationRatio', 'manualWeight',
  'favoriteBonus', 'libraryCacheTtlSec', 'favoritesTtlMin', 'historyLimit', 'playlistSuffix',
  'songloftBase', 'miotBase', 'adminUsername', 'adminPassword', 'hookSecret',
  'pollIntervalMs', 'defaultPlayMode'
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
  result.candidateSource = result.candidateSource === 'all' ? 'all' : 'remote';
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

  // 宿主曲库没有流派/语种/年代字段，只能通过「歌手 → 标签」近似
  const tags = tagsForArtist(song.artist);
  for (let i = 0; i < tags.length; i++) {
    const dim = classifyTag(tags[i]);
    if (dim) push(dim, tags[i]);
  }
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
    const tags = tagsForArtist(artist);
    for (let t = 0; t < tags.length; t++) {
      const weight = Number(tagWeights[tags[t]]) || 0;
      if (!weight) continue;
      const dim = classifyTag(tags[t]);
      raw += weight * (Number(DIMENSION_SCORE_WEIGHTS[dim]) || 0);
      hits.push({ type: 'tag', value: tags[t], weight: weight });
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

/* ─── 生命周期 ─── */
let initialized = false;
let initializingPromise = null;

async function bootstrap() {
  await loadConfig();
  await loadProfiles();
  await loadSingerTags();
  await loadFavoritesCache();
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