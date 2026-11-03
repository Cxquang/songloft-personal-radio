/**
 * personal-radio 插件前端（P1：画像 + 今日推荐 + 引擎设置）
 * 兼容宿主注入的 SongloftPlugin 桥；无桥时回退原生 fetch + Bearer token。
 */
(function () {
  'use strict';

  var hasSDK = typeof SongloftPlugin !== 'undefined' && SongloftPlugin !== null;

  function token() {
    try {
      var q = new URLSearchParams(location.search).get('access_token');
      if (q) return q;
      if (hasSDK && SongloftPlugin.getAuthToken) return SongloftPlugin.getAuthToken() || '';
    } catch (e) { /* ignore */ }
    return '';
  }

  function pluginBasePath() {
    var marker = '/api/v1/jsplugin/';
    var index = window.location.pathname.indexOf(marker);
    if (index < 0) return '';
    return marker + window.location.pathname.slice(index + marker.length).split('/')[0];
  }

  function apiGet(path) {
    if (hasSDK && SongloftPlugin.apiGet) return Promise.resolve(SongloftPlugin.apiGet(path));
    return rawFetch('GET', path, null);
  }

  function apiPost(path, body) {
    if (hasSDK && SongloftPlugin.apiPost) return Promise.resolve(SongloftPlugin.apiPost(path, body || {}));
    return rawFetch('POST', path, body || {});
  }

  function rawFetch(method, path, body) {
    var base = pluginBasePath();
    var headers = { 'Content-Type': 'application/json' };
    var t = token();
    if (t) headers.Authorization = 'Bearer ' + t;
    return fetch(base + path, {
      method: method,
      headers: headers,
      body: method === 'GET' ? undefined : JSON.stringify(body || {})
    }).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok || (data && data.error)) throw new Error((data && data.error) || ('HTTP ' + res.status));
        return data;
      });
    });
  }

  /* ---------- 小工具 ---------- */
  function $(id) { return document.getElementById(id); }

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var toastTimer = null;
  function toast(message) {
    var el = $('toast');
    el.textContent = String(message || '');
    el.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 2400);
  }

  /* ---------- 状态 ---------- */
  var state = {
    profiles: [],
    currentId: '',
    manualArtists: {},
    manualTags: {}
  };

  function currentProfile() {
    for (var i = 0; i < state.profiles.length; i++) {
      if (state.profiles[i].id === state.currentId) return state.profiles[i];
    }
    return state.profiles[0] || null;
  }

  function findProfile(id) {
    for (var i = 0; i < state.profiles.length; i++) {
      if (state.profiles[i].id === id) return state.profiles[i];
    }
    return null;
  }

  /* ---------- 状态条 ---------- */
  function loadStatus() {
    return apiGet('/api/status').then(function (data) {
      $('ver').textContent = 'v' + data.version;
      $('chip-library').textContent = '曲库 ' + ((data.library && data.library.count) || 0) + ' 首';
      $('chip-favorites').textContent = '收藏 ' + ((data.favorites && data.favorites.count) || 0) + ' 首';
      $('chip-profiles').textContent = '画像 ' + (data.profiles || 0) + ' 个';
    }).catch(function () { /* 状态条失败不阻塞页面 */ });
  }

  /* ---------- 画像切换 ---------- */
  function loadProfiles(preferredId) {
    return apiGet('/api/profiles').then(function (data) {
      state.profiles = data.profiles || [];
      var target = preferredId || state.currentId;
      if (!target || !findProfile(target)) {
        target = data.defaultId || (state.profiles[0] && state.profiles[0].id) || '';
      }
      state.currentId = target;
      renderTabs();
      renderProfileForm();
      renderManual();
      updateProfileTip();
      return state.profiles;
    });
  }

  function renderTabs() {
    var box = $('profile-tabs');
    box.innerHTML = state.profiles.map(function (profile) {
      var active = profile.id === state.currentId ? ' active' : '';
      var badge = profile.isDefault ? '<span class="tab-badge">默认</span>' : '';
      return '<button class="tab' + active + '" data-profile="' + esc(profile.id) + '">'
        + esc(profile.name) + badge + '</button>';
    }).join('');
  }

  function updateProfileTip() {
    var profile = currentProfile();
    if (!profile) { $('profile-tip').textContent = '还没有画像'; return; }
    var interest = profile.interest || {};
    $('profile-tip').textContent = '当前画像：' + profile.name
      + ' · 行为证据 ' + (interest.evidence || 0) + ' 条'
      + ' · 推荐池 ' + (profile.poolSize || 0) + ' 首'
      + ' · 收藏加权' + (profile.useFavorites ? '已开启' : '已关闭');
  }

  function selectProfile(id) {
    if (!id || id === state.currentId) return;
    var profile = findProfile(id);
    if (!profile) return;
    state.currentId = id;
    renderTabs();
    renderProfileForm();
    renderManual();
    updateProfileTip();
    loadRecommend();
  }

  /* ---------- 今日推荐 ---------- */
  function loadRecommend() {
    var list = $('recommend-list');
    var count = $('recommend-count').value;
    if (!state.currentId) return Promise.resolve();
    list.innerHTML = '<li class="empty">正在计算推荐…</li>';
    return apiGet('/api/recommend?profile=' + encodeURIComponent(state.currentId) + '&count=' + count)
      .then(function (data) {
        renderRecommend(data);
      })
      .catch(function (err) {
        $('recommend-meta').textContent = '生成失败：' + err.message;
        list.innerHTML = '<li class="empty">' + esc(err.message) + '</li>';
      });
  }

  function renderRecommend(data) {
    var meta = data.meta || {};
    $('recommend-meta').textContent = '候选 ' + (meta.candidateCount || 0) + ' 首'
      + ' · 兴趣选 ' + (meta.interestCount || 0)
      + ' · 探索选 ' + (meta.exploreCount || 0)
      + ' · 探索比例 ' + Math.round((meta.explorationRatio || 0) * 100) + '%'
      + ' · 行为证据 ' + (meta.evidence || 0)
      + ' · 收藏 ' + (meta.favoriteCount || 0) + ' 首';
    var items = data.items || [];
    if (!items.length) {
      $('recommend-list').innerHTML = '<li class="empty">没有候选歌曲：请检查「候选来源」和曲库</li>';
      return;
    }
    $('recommend-list').innerHTML = items.map(function (item) {
      var badges = [];
      if (item.mode === 'explore') badges.push('<span class="badge explore">探索</span>');
      if (item.favorite) badges.push('<span class="badge fav">收藏</span>');
      var breakdown = item.breakdown || {};
      var tip = '自动 ' + (breakdown.auto || 0) + ' / 手动 ' + (breakdown.manual || 0)
        + ' / 收藏 ' + (breakdown.favorite || 0) + ' / 抖动 ' + (breakdown.jitter || 0);
      return '<li class="song-item">'
        + '<span class="rank">' + item.rank + '</span>'
        + '<span class="song-main">'
        + '<span class="song-title">' + esc(item.title || item.songId) + '</span>'
        + '<span class="song-sub">' + esc(item.artist || '未知歌手')
        + (item.album ? ' · ' + esc(item.album) : '') + '</span>'
        + '<span class="song-reason">' + esc(item.reason || '') + '</span>'
        + '</span>'
        + '<span class="song-badges">' + badges.join('') + '</span>'
        + '<span class="song-score" title="' + esc(tip) + '">' + (item.score || 0) + '</span>'
        + '</li>';
    }).join('');
  }
  /* ---------- 画像资料 ---------- */
  function renderProfileForm() {
    var profile = currentProfile();
    if (!profile) return;
    $('profile-id-label').textContent = 'ID：' + profile.id;
    $('pf-name').value = profile.name || '';
    $('pf-aliases').value = (profile.aliases || []).join('，');
    $('pf-default').checked = Boolean(profile.isDefault);
    $('pf-favorites').checked = Boolean(profile.useFavorites);
  }

  function saveProfile() {
    var name = $('pf-name').value.trim();
    if (!name) return toast('画像名称不能为空');
    apiPost('/api/profiles', {
      action: 'update',
      profile: {
        id: state.currentId,
        name: name,
        aliases: $('pf-aliases').value,
        isDefault: $('pf-default').checked,
        useFavorites: $('pf-favorites').checked
      }
    }).then(function () {
      toast('画像已保存');
      return loadProfiles();
    }).then(function () {
      loadRecommend();
      loadStatus();
    }).catch(function (err) { toast(err.message); });
  }

  function deleteProfile() {
    var profile = currentProfile();
    if (!profile) return;
    if (!window.confirm('确定删除画像「' + profile.name + '」？其兴趣模型、推荐池、手动偏好都会一并清除。')) return;
    apiPost('/api/profiles', { action: 'delete', id: profile.id })
      .then(function () {
        toast('画像已删除');
        state.currentId = '';
        return loadProfiles();
      })
      .then(function () {
        loadRecommend();
        loadStatus();
      })
      .catch(function (err) { toast(err.message); });
  }

  function createProfile() {
    var name = window.prompt('新画像的显示名（例如：老妈 / 老妹）');
    if (!name) return;
    name = name.trim();
    if (!name) return;
    apiPost('/api/profiles', { action: 'create', profile: { name: name, aliases: [] } })
      .then(function (data) {
        var created = null;
        for (var i = 0; i < (data.profiles || []).length; i++) {
          if (data.profiles[i].name === name) created = data.profiles[i];
        }
        toast('画像「' + name + '」已创建');
        return loadProfiles(created ? created.id : '');
      })
      .then(function () {
        loadRecommend();
        loadStatus();
      })
      .catch(function (err) { toast(err.message); });
  }

  /* ---------- 手动偏好 ---------- */
  function renderManual() {
    var profile = currentProfile();
    var manual = (profile && profile.manual) || { artists: {}, tags: {} };
    state.manualArtists = Object.assign({}, manual.artists || {});
    state.manualTags = Object.assign({}, manual.tags || {});
    renderWeightList('manual-artists', state.manualArtists, 'artist');
    renderWeightList('manual-tags', state.manualTags, 'tag');
  }

  function renderWeightList(containerId, map, kind) {
    var box = $(containerId);
    var names = Object.keys(map).sort(function (a, b) { return (map[b] || 0) - (map[a] || 0); });
    if (!names.length) {
      box.innerHTML = '<p class="tip small">还没有条目</p>';
      return;
    }
    box.innerHTML = names.map(function (name) {
      return '<div class="weight-row">'
        + '<span class="weight-name" title="' + esc(name) + '">' + esc(name) + '</span>'
        + '<input class="short" type="number" step="0.1" min="-1" max="1" value="' + esc(map[name])
        + '" data-name="' + esc(name) + '" data-kind="' + kind + '">'
        + '<button class="btn ghost small" data-remove="' + esc(name) + '" data-kind="' + kind + '">移除</button>'
        + '</div>';
    }).join('');
  }

  function addWeight(kind) {
    var nameInput = kind === 'artist' ? $('artist-name') : $('tag-weight-name');
    var valueInput = kind === 'artist' ? $('artist-weight') : $('tag-weight-value');
    var name = nameInput.value.trim();
    var value = Number(valueInput.value);
    if (!name) return toast('请填写名称');
    if (!isFinite(value) || value < -1 || value > 1) return toast('权重需在 -1 ~ 1 之间');
    if (kind === 'artist') {
      state.manualArtists[name] = value;
      renderWeightList('manual-artists', state.manualArtists, 'artist');
    } else {
      state.manualTags[name] = value;
      renderWeightList('manual-tags', state.manualTags, 'tag');
    }
    nameInput.value = '';
  }

  function onWeightInput(event) {
    var target = event.target;
    var name = target.getAttribute && target.getAttribute('data-name');
    if (!name) return;
    var kind = target.getAttribute('data-kind');
    var value = Number(target.value);
    if (!isFinite(value)) return;
    value = Math.max(-1, Math.min(1, value));
    if (kind === 'artist') state.manualArtists[name] = value;
    else state.manualTags[name] = value;
  }

  function onWeightClick(event) {
    var target = event.target;
    var name = target.getAttribute && target.getAttribute('data-remove');
    if (!name) return;
    var kind = target.getAttribute('data-kind');
    if (kind === 'artist') {
      delete state.manualArtists[name];
      renderWeightList('manual-artists', state.manualArtists, 'artist');
    } else {
      delete state.manualTags[name];
      renderWeightList('manual-tags', state.manualTags, 'tag');
    }
  }

  function saveManual() {
    if (!state.currentId) return toast('请先选择画像');
    apiPost('/api/manual', {
      profile: state.currentId,
      manual: { artists: state.manualArtists, tags: state.manualTags }
    }).then(function () {
      toast('手动偏好已保存');
      return loadProfiles();
    }).then(function () {
      loadRecommend();
    }).catch(function (err) { toast(err.message); });
  }

  /* ---------- 歌手标签库 ---------- */
  function loadSingerTags() {
    return apiGet('/api/singer-tags').then(function (data) {
      var list = data.list || [];
      var box = $('singer-tags');
      if (!list.length) {
        box.innerHTML = '<p class="tip small">还没有歌手标签。给常用歌手打上「华语」「民谣」「1980s」等标签后，推荐会按标签近似流派/语种/年代。</p>';
        return;
      }
      box.innerHTML = list.map(function (row) {
        var pills = (row.tags || []).map(function (tag) {
          return '<span class="pill">' + esc(tag) + '</span>';
        }).join('');
        return '<div class="tag-row"><b class="tag-singer">' + esc(row.singer) + '</b>' + pills
          + '<button class="btn ghost small" data-singer="' + esc(row.singer) + '">删除</button></div>';
      }).join('');
    }).catch(function (err) { toast(err.message); });
  }

  function saveSingerTag() {
    var singer = $('tag-singer').value.trim();
    var tags = $('tag-list').value.trim();
    if (!singer) return toast('请填写歌手名');
    if (!tags) return toast('请填写至少一个标签');
    apiPost('/api/singer-tags', { singer: singer, tags: tags })
      .then(function () {
        toast('歌手标签已保存');
        $('tag-singer').value = '';
        $('tag-list').value = '';
        return loadSingerTags();
      })
      .then(function () { loadRecommend(); })
      .catch(function (err) { toast(err.message); });
  }

  function onSingerTagClick(event) {
    var target = event.target;
    var singer = target.getAttribute && target.getAttribute('data-singer');
    if (!singer) return;
    if (!window.confirm('删除歌手「' + singer + '」的标签？')) return;
    apiPost('/api/singer-tags', { action: 'delete', singer: singer })
      .then(function () {
        toast('已删除');
        return loadSingerTags();
      })
      .then(function () { loadRecommend(); })
      .catch(function (err) { toast(err.message); });
  }

  /* ---------- 引擎设置 ---------- */
  function loadConfig() {
    return apiGet('/api/config').then(function (data) {
      var cfg = data.config || {};
      $('cfg-source').value = cfg.candidateSource || 'remote';
      $('cfg-pool').value = cfg.poolSize;
      $('cfg-batch').value = cfg.queueBatch;
      $('cfg-explore').value = cfg.explorationRatio;
      $('cfg-manual').value = cfg.manualWeight;
      $('cfg-favorite').value = cfg.favoriteBonus;
    }).catch(function (err) { toast(err.message); });
  }

  function saveConfig() {
    apiPost('/api/config', {
      config: {
        candidateSource: $('cfg-source').value,
        poolSize: Number($('cfg-pool').value),
        queueBatch: Number($('cfg-batch').value),
        explorationRatio: Number($('cfg-explore').value),
        manualWeight: Number($('cfg-manual').value),
        favoriteBonus: Number($('cfg-favorite').value)
      }
    }).then(function (data) {
      toast('设置已保存');
      var cfg = data.config || {};
      $('cfg-pool').value = cfg.poolSize;
      $('cfg-batch').value = cfg.queueBatch;
      $('cfg-explore').value = cfg.explorationRatio;
      $('cfg-manual').value = cfg.manualWeight;
      $('cfg-favorite').value = cfg.favoriteBonus;
      return loadRecommend();
    }).catch(function (err) { toast(err.message); });
  }

  function syncFavorites() {
    apiPost('/api/favorites/sync', {}).then(function (data) {
      var result = data.result || {};
      toast(result.missing ? '未找到收藏歌单' : '收藏同步完成：' + (result.count || 0) + ' 首');
      loadStatus();
      loadRecommend();
    }).catch(function (err) { toast(err.message); });
  }

  /* ---------- 日志 ---------- */
  function loadLogs() {
    return apiGet('/api/logs').then(function (data) {
      var lines = (data.lines || []).slice(-80);
      var box = $('log-list');
      if (!lines.length) {
        box.innerHTML = '<p class="tip small">暂无日志</p>';
        return;
      }
      box.innerHTML = lines.map(function (line) {
        return '<div class="log-line' + (line.level === 'WARN' ? ' warn' : '') + '">'
          + '<span class="log-time">' + esc(line.time) + '</span>'
          + '<span class="log-level">' + esc(line.level) + '</span>'
          + '<span class="log-msg">' + esc(line.message) + '</span>'
          + '</div>';
      }).join('');
      box.scrollTop = box.scrollHeight;
    }).catch(function () { /* ignore */ });
  }

  function clearLogs() {
    apiGet('/api/logs?clear=1').then(function () {
      toast('日志已清空');
      return loadLogs();
    }).catch(function (err) { toast(err.message); });
  }

  /* ---------- 事件绑定 ---------- */
  function bindEvents() {
    $('profile-tabs').addEventListener('click', function (event) {
      var target = event.target;
      if (target && target.closest) target = target.closest('[data-profile]');
      var id = target && target.getAttribute && target.getAttribute('data-profile');
      if (id) selectProfile(id);
    });
    $('btn-new-profile').addEventListener('click', createProfile);
    $('btn-refresh').addEventListener('click', loadRecommend);
    $('recommend-count').addEventListener('change', loadRecommend);

    $('btn-save-profile').addEventListener('click', saveProfile);
    $('btn-delete-profile').addEventListener('click', deleteProfile);

    $('btn-add-artist').addEventListener('click', function () { addWeight('artist'); });
    $('btn-add-tag').addEventListener('click', function () { addWeight('tag'); });
    $('btn-save-manual').addEventListener('click', saveManual);
    $('manual-artists').addEventListener('input', onWeightInput);
    $('manual-artists').addEventListener('click', onWeightClick);
    $('manual-tags').addEventListener('input', onWeightInput);
    $('manual-tags').addEventListener('click', onWeightClick);

    $('btn-save-singer').addEventListener('click', saveSingerTag);
    $('singer-tags').addEventListener('click', onSingerTagClick);

    $('btn-save-config').addEventListener('click', saveConfig);
    $('btn-sync-favorites').addEventListener('click', syncFavorites);
    $('btn-clear-logs').addEventListener('click', clearLogs);
  }

  function init() {
    bindEvents();
    loadStatus();
    loadProfiles()
      .then(function () {
        return Promise.all([loadRecommend(), loadSingerTags(), loadConfig(), loadLogs()]);
      })
      .then(function () {
        setInterval(function () {
          loadLogs();
          loadStatus();
        }, 5000);
      })
      .catch(function (err) { toast(err.message); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();