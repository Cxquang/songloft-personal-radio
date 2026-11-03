/**
 * personal-radio v0.1.0（P1）自测：mock 宿主曲库/歌单/存储，验证引擎与多画像
 * 覆盖：默认画像初始化、画像 CRUD 与别名唯一、候选仅远程、手动画像正/负权重、
 *       歌手标签命中、收藏开关、多样性与探索、推荐池补充/取出/回池、配置与状态、日志。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
function ok(cond, label) {
  if (!cond) { console.error('FAIL: ' + label); process.exit(1); }
  pass++;
  console.log('[' + pass + '] OK: ' + label);
}

/* ---------- mock 曲库 ---------- */
function remote(id, title, artist) {
  return {
    id: id, type: 'remote', title: title, artist: artist, album: artist + '专辑',
    duration: 240, url: 'http://example.com/' + id + '.mp3', format: 'mp3'
  };
}
const LIBRARY = [
  remote('r1', '甜蜜蜜', '邓丽君'),
  remote('r2', '月亮代表我的心', '邓丽君'),
  remote('r3', '我只在乎你', '邓丽君'),
  remote('r4', '南山南', '某歌手A'),
  remote('r5', '斑马斑马', '某歌手A'),
  remote('r6', '海阔天空', '某歌手B'),
  remote('r7', '光辉岁月', '某歌手B'),
  remote('r8', '真的爱你', '某歌手B'),
  remote('r9', '夜空中最亮的星', '某歌手C'),
  remote('r10', '追梦赤子心', '某歌手C'),
  remote('r11', '平凡之路', '某歌手D'),
  remote('r12', '小幸运', '某歌手D'),
  { id: 'l1', type: 'local', title: '本地一', artist: '本地歌手', duration: 200, file_path: 'D:/music/l1.mp3', format: 'flac' },
  { id: 'l2', type: 'local', title: '本地二', artist: '本地歌手', duration: 210, file_path: 'D:/music/l2.flac', format: 'flac' },
  { id: 'l3', type: 'local', title: '本地三', artist: '本地歌手', duration: 220, file_path: 'D:/music/l3.mp3', format: 'mp3' },
  { id: 'l4', type: 'local', title: '本地四', artist: '本地歌手', duration: 230, file_path: 'D:/music/sub/l4.mp3', format: 'mp3' }
];
const FAVORITE_IDS = ['r1', 'r12'];

/* ---------- mock 宿主 ---------- */
const store = new Map();

globalThis.songloft = {
  log: { info: function () { }, warn: function () { } },
  storage: {
    get: async function (k) { return store.has(k) ? store.get(k) : null; },
    set: async function (k, v) { store.set(k, v); },
    delete: async function (k) { store.delete(k); }
  },
  songs: {
    list: async function () { return { items: LIBRARY, total: LIBRARY.length }; }
  },
  playlists: {
    list: async function () {
      return [{ id: 1, type: 'normal', name: '收藏', labels: ['built_in'], song_count: FAVORITE_IDS.length }];
    },
    getSongs: async function () { return { items: FAVORITE_IDS.map(function (id) { return { id: id }; }) }; },
    create: async function (payload) { return { id: 2, name: payload && payload.name }; },
    addSongs: async function () { },
    removeSongs: async function () { }
  }
};

/* ---------- 加载插件 ---------- */
const src = readFileSync(join(ROOT, 'src', 'main.js'), 'utf8');
vm.runInThisContext(src, { filename: 'main.js' });
ok(typeof globalThis.onInit === 'function', '模块加载：onInit 已注册');
ok(typeof globalThis.onHTTPRequest === 'function', '模块加载：onHTTPRequest 已注册');

async function call(method, path, opts) {
  const o = opts || {};
  const res = await globalThis.onHTTPRequest({
    method: method,
    path: path,
    query: o.query || '',
    body: o.body ? JSON.stringify(o.body) : ''
  });
  let data = null;
  try { data = JSON.parse(res.body); } catch (e) { data = res.body; }
  return { status: res.statusCode, data: data };
}

function findProfile(list, ref) {
  return list.filter(function (p) { return p.id === ref || p.name === ref; })[0];
}

await globalThis.onInit();
ok(store.has('personalRadio.profiles'), 'onInit：默认画像已落库');

/* ---------- 画像 CRUD ---------- */
let r = await call('GET', '/api/profiles');
ok(r.status === 200 && r.data.profiles.length === 1, '默认只有 1 个画像');
ok(r.data.profiles[0].id === 'me' && r.data.profiles[0].name === '我', '默认画像为「我」');
ok(r.data.defaultId === 'me', '默认画像标记正确');

r = await call('POST', '/api/profiles', {
  body: { action: 'create', profile: { id: 'mom', name: '老妈', aliases: ['妈妈', '妈'], useFavorites: true } }
});
ok(r.status === 200 && r.data.ok, '新建画像「老妈」成功');

r = await call('POST', '/api/profiles', {
  body: { action: 'create', profile: { name: '老妹', aliases: ['妈妈'], useFavorites: false } }
});
ok(r.status === 400 && /冲突/.test(r.data.error), '别名冲突被拒绝');

r = await call('POST', '/api/profiles', {
  body: { action: 'create', profile: { name: '老妹', aliases: ['妹妹'], useFavorites: false } }
});
ok(r.status === 200 && r.data.ok, '新建画像「老妹」成功');
const sister = findProfile(r.data.profiles, '老妹');
ok(Boolean(sister && sister.id), '「老妹」自动生成画像 ID：' + (sister ? sister.id : '-'));

// 关掉「我」的收藏开关，避免收藏加权干扰负权重测试
r = await call('POST', '/api/profiles', { body: { action: 'update', profile: { id: 'me', useFavorites: false } } });
ok(r.status === 200 && r.data.ok, '更新画像：关闭「我」的收藏开关');

r = await call('POST', '/api/profiles', {
  body: { action: 'update', profile: { id: 'mom', aliases: ['妈妈', '妈', '老娘'] } }
});
ok(r.status === 200 && r.data.ok, '更新画像：追加别名成功');

/* ---------- 候选范围 ---------- */
r = await call('GET', '/api/recommend', { query: 'profile=me&count=12' });
ok(r.status === 200 && r.data.items.length === 12, '默认推荐返回 12 首');
ok(r.data.meta.candidateCount === 12, '默认候选只含 12 首网络歌曲');
ok(r.data.items.every(function (item) { return item.type === 'remote'; }), '默认候选全部 type=remote');

/* ---------- 手动画像：正权重 ---------- */
r = await call('POST', '/api/manual', {
  body: { profile: 'mom', manual: { artists: { '邓丽君': 1 } } }
});
ok(r.status === 200 && r.data.ok, '保存「老妈」手动画像：邓丽君 +1');

r = await call('GET', '/api/recommend', { query: 'profile=mom&count=12' });
ok(r.data.items[0].artist === '邓丽君', '正权重：目标歌手排第一');
ok(r.data.items[0].breakdown.manual > 0, '正权重：手动加分进入明细');
ok(/手动画像/.test(r.data.items[0].reason), '推荐理由包含手动画像命中');

/* ---------- 手动画像：负权重 ---------- */
r = await call('POST', '/api/manual', {
  body: { profile: 'me', manual: { artists: { '邓丽君': -1 } } }
});
ok(r.status === 200 && r.data.ok, '保存「我」手动画像：邓丽君 -1');

r = await call('GET', '/api/recommend', { query: 'profile=me&count=12' });
const lastItem = r.data.items[r.data.items.length - 1];
ok(lastItem.artist === '邓丽君', '负权重：目标歌手被压到末尾');
ok(r.data.items[0].artist !== '邓丽君', '负权重：目标歌手不再排第一');

/* ---------- 歌手标签 + 手动标签偏好 ---------- */
r = await call('POST', '/api/singer-tags', { body: { singer: '某歌手A', tags: '民谣, 华语' } });
ok(r.status === 200 && r.data.ok && r.data.tags.length === 2, '写入歌手标签：某歌手A → 民谣/华语');

r = await call('POST', '/api/singer-tags', { body: { singer: '某歌手B', tags: '摇滚、粤语、2000s' } });
ok(r.status === 200 && r.data.tags.length === 3, '标签支持中文顿号分隔');

r = await call('POST', '/api/manual', {
  body: { profile: sister.id, manual: { tags: { '民谣': 0.8 } } }
});
ok(r.status === 200 && r.data.ok, '保存「老妹」手动画像：民谣 +0.8');

r = await call('GET', '/api/recommend', { query: 'profile=' + sister.id + '&count=12' });
ok(r.data.items[0].artist === '某歌手A', '歌手标签命中：民谣歌手排第一');
ok(/手动画像/.test(r.data.items[0].reason), '标签命中进入推荐理由');

/* ---------- 收藏开关 ---------- */
r = await call('GET', '/api/recommend', { query: 'profile=me&count=12' });
const meFavoriteItem = r.data.items.filter(function (item) { return item.songId === 'r1'; })[0];
ok(Boolean(meFavoriteItem), '收藏歌仍参与推荐');
ok(meFavoriteItem.breakdown.favorite === 0, 'useFavorites=false：收藏歌不加分');

r = await call('GET', '/api/recommend', { query: 'profile=mom&count=12' });
const momFavoriteItem = r.data.items.filter(function (item) { return item.songId === 'r1'; })[0];
ok(Boolean(momFavoriteItem), '「老妈」推荐包含收藏歌');
ok(momFavoriteItem.breakdown.favorite === 12, 'useFavorites=true：收藏歌 +12');
ok(r.data.meta.favoriteCount === 2, '收藏缓存已同步 2 首');

/* ---------- 多画像结果不同 ---------- */
r = await call('GET', '/api/recommend', { query: 'profile=mom&count=12' });
const momTop = r.data.items[0].songId;
r = await call('GET', '/api/recommend', { query: 'profile=' + sister.id + '&count=12' });
const sisterTop = r.data.items[0].songId;
ok(momTop !== sisterTop, '两个画像同一批歌的 top 结果不同');

/* ---------- 推荐池 ---------- */
r = await call('POST', '/api/pool', { body: { profile: 'me', action: 'refill', count: 20 } });
ok(r.status === 200 && r.data.ok, '推荐池补充成功');
ok(r.data.pool.length === 12, '推荐池装满全部 12 首候选');

r = await call('POST', '/api/pool', { body: { profile: 'me', action: 'checkout', count: 5 } });
ok(r.status === 200 && r.data.entries.length === 5, '从推荐池取出 5 首');
ok(r.data.remaining === 7, '取出后池内剩余 7 首');

r = await call('POST', '/api/pool', { body: { profile: 'me', action: 'checkout', count: 8 } });
ok(r.status === 200 && r.data.entries.length === 8, '池不足时自动补充后取出 8 首');
ok(r.data.remaining === 4, '第二次取出后池内剩余 4 首');

r = await call('POST', '/api/pool', { body: { profile: 'me', action: 'clear' } });
ok(r.status === 200 && r.data.size === 0, '清空推荐池');

r = await call('POST', '/api/pool', { body: { profile: 'me', action: 'release', songIds: ['r1', 'r2', 'r3'] } });
ok(r.status === 200 && r.data.result.added === 3, '回池 3 首');

r = await call('POST', '/api/pool', { body: { profile: 'me', action: 'checkout', count: 5 } });
ok(r.status === 200 && r.data.entries.length === 5, '回池后再取出 5 首（自动补充）');

/* ---------- 候选来源切换 ---------- */
r = await call('POST', '/api/config', { body: { config: { candidateSource: 'all', poolSize: 100 } } });
ok(r.status === 200 && r.data.config.candidateSource === 'all', '切换到全部歌曲候选');

r = await call('GET', '/api/recommend', { query: 'profile=me&count=12' });
ok(r.data.meta.candidateCount === 16, '候选来源 all：候选数变为 16');

r = await call('POST', '/api/config', { body: { config: { candidateSource: 'remote' } } });
ok(r.data.config.candidateSource === 'remote', '切回网络歌曲候选');
ok(r.data.config.poolSize === 100, '配置默认池容量保留为 100');

/* ---------- 别名声明的画像解析 ---------- */
r = await call('GET', '/api/manual', { query: 'profile=妈妈' });
ok(r.status === 200 && r.data.profile.id === 'mom', '按别名「妈妈」解析到画像 mom');
ok(r.data.manual.artists['邓丽君'] === 1, '别名解析读到正确的手动画像');

/* ---------- 状态与日志 ---------- */
r = await call('GET', '/api/status');
ok(r.status === 200 && r.data.version === '0.1.0', '/api/status：版本 0.1.0');
ok(r.data.profiles === 3, '/api/status：画像数量 3');
ok(r.data.favorites.count === 2, '/api/status：收藏缓存 2 首');
ok(r.data.singerTags === 2, '/api/status：歌手标签 2 个');

r = await call('GET', '/api/logs');
ok(r.status === 200 && Array.isArray(r.data.lines) && r.data.lines.length > 0, '/api/logs：可读取运行日志');

r = await call('GET', '/api/logs', { query: 'clear=1' });
ok(r.data.lines.length === 1, '/api/logs?clear=1：清空后只留一条提示');

r = await call('GET', '/api/unknown');
ok(r.status === 404, '未知路由返回 404');

r = await call('GET', '/api/recommend', { query: 'profile=ghost&count=5' });
ok(r.status === 400, '不存在的画像返回 400');

/* ---------- 画像删除保护 ---------- */
r = await call('POST', '/api/profiles', { body: { action: 'delete', id: 'mom' } });
ok(r.status === 200 && r.data.ok, '删除画像「老妈」成功');
r = await call('POST', '/api/profiles', { body: { action: 'delete', id: sister.id } });
ok(r.status === 200 && r.data.ok, '删除画像「老妹」成功');
r = await call('POST', '/api/profiles', { body: { action: 'delete', id: 'me' } });
ok(r.status === 400 && /至少保留/.test(r.data.error), '最后一个画像不允许删除');

console.log('\n全部 ' + pass + ' 项自测通过（personal-radio v0.1.0 P1）');