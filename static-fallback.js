/*!
 * 邻里话养生 · 静态兜底引擎
 * 云函数不可用时（额度冻结 / 网络异常 / 微信内置浏览器限制），
 * 前端直接读取静态托管上的 data/idx.json + data/c/*.json，保证站点可搜可看。
 * 云函数一旦恢复，页面刷新后会自动切回云端模式（先探活，失败才降级）。
 */
(function (global) {
  'use strict';

  var KEY = 'lnhy2026yangsheng';
  var FREE_READ = true;   // 维护期免费阅读；云端恢复后此文件不再被调用
  var DATA_BASE = './data/';
  // 自用完整数据：URL 加 ?internal=1 可显示「内服≥5味」复杂方（默认对用户隐藏，仅保留简便廉验方法）
  var SHOW_INTERNAL = /[?&]internal=1/.test((typeof location !== 'undefined' ? location.search : '') || '');
  var idxCache = null;
  var idxPromise = null;
  var shardCache = {};

  // ---------- 存储（本地积分 / 解锁 / 评论） ----------
  function lsGet(k, d) {
    try { var v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); }
    catch (e) { return d; }
  }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

  function getPoints() {
    var p = lsGet('lnhy_pts', null);
    if (p == null) { p = 100; lsSet('lnhy_pts', p); }
    return p;
  }
  function setPoints(v) { lsSet('lnhy_pts', Math.max(0, v)); return Math.max(0, v); }
  function unlockedSet() { return lsGet('lnhy_unlocked', {}); }
  function markUnlocked(id) { var u = unlockedSet(); u[id] = 1; lsSet('lnhy_unlocked', u); }

  // ---------- 解码 ----------
  function deobf(b64) {
    var bin = atob(b64);
    var n = bin.length;
    var bytes = new Uint8Array(n);
    for (var i = 0; i < n; i++) {
      bytes[i] = bin.charCodeAt(i) ^ KEY.charCodeAt(i % KEY.length);
    }
    try { return new TextDecoder('utf-8').decode(bytes); }
    catch (e) {
      var s = '';
      for (var j = 0; j < n; j++) s += String.fromCharCode(bytes[j]);
      try { return decodeURIComponent(escape(s)); } catch (e2) { return s; }
    }
  }

  // ---------- 数据加载 ----------
  function mapItem(a) {
    return { _id: a[0], title: a[1], symptom: a[2], summary: a[3], tags: a[4] ? [a[4]] : [], source: a[4] || '', _sh: a[5], q: a[6] || 0, flag: a[7] || 0 };
  }
  // 带一次重试的 fetch（防瞬断导致整块丢失）
  function fetchJSON(url) {
    return fetch(url, { cache: 'no-cache' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).catch(function (e) {
      return fetch(url, { cache: 'no-store' }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      });
    });
  }
  function loadIdx() {
    if (idxCache) return Promise.resolve(idxCache);
    if (idxPromise) return idxPromise;
    idxPromise = fetchJSON(DATA_BASE + 'idx.json')
      .then(function (j) {
        // 兼容单文件 idx(v6) 与分块 idx(v7: manifest.chunks)
        if (!j.chunks) {
          idxCache = (j.items || []).map(mapItem);
          return idxCache;
        }
        return Promise.all(j.chunks.map(function (fn) {
          return fetchJSON(DATA_BASE + fn).catch(function () { return []; });
        })).then(function (arrs) {
          var flat = [];
          arrs.forEach(function (a) { if (a && a.length) flat = flat.concat(a); });
          idxCache = flat.map(mapItem);
          return idxCache;
        });
      })
      .catch(function (e) { idxPromise = null; throw e; });
    return idxPromise;
  }

  function loadShard(n) {
    if (shardCache[n]) return Promise.resolve(shardCache[n]);
    return fetch(DATA_BASE + 'c/' + n + '.json', { cache: 'no-cache' })
      .then(function (r) {
        if (!r.ok) throw new Error('shard HTTP ' + r.status);
        return r.json();
      })
      .then(function (j) { shardCache[n] = j; return j; });
  }

  function getContent(item) {
    return loadShard(item._sh).then(function (m) {
      var raw = m[item._id];
      return raw ? deobf(raw) : (item.summary || '');
    });
  }

  function findById(id) {
    return loadIdx().then(function (list) {
      for (var i = 0; i < list.length; i++) if (list[i]._id === id) return list[i];
      return null;
    });
  }

  function card(it) {
    return { _id: it._id, title: it.title, symptom: it.symptom, summary: it.summary, tags: it.tags, source: it.source };
  }

  // ---------- 全文索引（搜索时才拉全部分片，约 1MB，只拉一次） ----------
  var ftReady = false;
  var ftPromise = null;
  function buildFullText() {
    if (ftReady) return Promise.resolve();
    if (ftPromise) return ftPromise;
    ftPromise = loadIdx().then(function (list) {
      var jobs = [];
      for (var i = 0; i < 32; i++) {
        if (shardCache[i] === undefined) jobs.push(i);
      }
      var idxSet = {};
      list.forEach(function (it) { idxSet[it._sh] = 1; });
      var need = Object.keys(idxSet).map(Number);
      return Promise.all(need.map(function (n) {
        return loadShard(n).catch(function () { return {}; });
      })).then(function () {
        for (var i = 0; i < list.length; i++) {
          var raw = (shardCache[list[i]._sh] || {})[list[i]._id];
          list[i]._ft = raw ? deobf(raw) : (list[i].summary || '');
        }
        ftReady = true;
      });
    }).catch(function (e) { ftPromise = null; throw e; });
    return ftPromise;
  }

  // ---------- 搜索 ----------
  function score(it, kw) {
    var s = 0;
    if (it.title && it.title.indexOf(kw) >= 0) s += 10;
    if (it.symptom && it.symptom.indexOf(kw) >= 0) s += 8;
    for (var i = 0; i < it.tags.length; i++) if (it.tags[i].indexOf(kw) >= 0) s += 6;
    if (it.summary && it.summary.indexOf(kw) >= 0) s += 3;
    if (!s && it._ft && it._ft.indexOf(kw) >= 0) s += 2;   // 正文命中
    if (s > 0) s += (it.q || 0) * 4;   // 已校对内容优先
    return s;
  }

  function rank(list, kw) {
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var it = list[i];
      if (it.flag === 1 && !SHOW_INTERNAL) continue;   // 默认隐藏 内服≥5味 复杂方（用户端）
      var sc = score(it, kw);
      if (sc > 0) out.push({ s: sc, it: it });
    }
    out.sort(function (a, b) { return b.s - a.s; });
    return out.map(function (x) { return x.it; });
  }

  function search(kw) {
    return loadIdx().then(function (list) {
      return buildFullText()
        .then(function () { return rank(list, kw); })
        .catch(function () { return rank(list, kw); });
    });
  }

  // ---------- 云函数协议兼容层 ----------
  function handle(fnName, data) {
    data = data || {};
    var action = data.action;

    if (fnName === 'pointsManager') {
      return Promise.resolve({ success: true, points: getPoints(), offline: true });
    }

    if (fnName === 'queryMethods') {
      // 分页工具：把整列表按 page/pageSize 切片，返回总页数等元信息
      var PG = function (l, page, pageSize) {
        page = Math.max(1, parseInt(page, 10) || 1);
        pageSize = Math.min(200, Math.max(1, parseInt(pageSize, 10) || 50));
        var total = l.length;
        var totalPages = Math.ceil(total / pageSize) || 1;
        if (page > totalPages) page = totalPages;
        var start = (page - 1) * pageSize;
        return { page: page, pageSize: pageSize, total: total, totalPages: totalPages,
                 list: l.slice(start, start + pageSize).map(card) };
      };
      if (action === 'getHot') {
        return loadIdx().then(function (l) {
          var hot = l.filter(function (x) { return !(x.flag === 1 && !SHOW_INTERNAL); });
          return { success: true, list: hot.slice(0, 20).map(card), total: l.length, offline: true };
        });
      }
      if (action === 'getAll') {
        return loadIdx().then(function (l) {
          var p = PG(l, data.page, data.pageSize);
          return { success: true, list: p.list, total: p.total, page: p.page,
                   pageSize: p.pageSize, totalPages: p.totalPages, offline: true };
        });
      }
      if (action === 'search') {
        var kw = (data.keyword || '').trim();
        if (!kw) return Promise.resolve({ success: true, list: [], total: 0, totalPages: 0, offline: true });
        return search(kw).then(function (l) {
          var p = PG(l, data.page, data.pageSize);
          return { success: true, list: p.list, total: p.total, page: p.page,
                   pageSize: p.pageSize, totalPages: p.totalPages, offline: true };
        });
      }
      if (action === 'getDetail') {
        var id = data.methodId;
        // 维护期（云端冻结）内容免费开放：无法联系云端校验积分，也无法充值，
        // 若继续拦截等于站点不可用。恢复云端后自动回到扣分模式。
        if (!FREE_READ && !unlockedSet()[id]) return Promise.resolve({ needUnlock: true, offline: true });
        return findById(id).then(function (it) {
          if (!it) return { error: 'not_found', offline: true };
          return getContent(it).then(function (c) {
            return {
              success: true, alreadyUnlocked: true, offline: true,
              data: { _id: it._id, title: it.title, content: c, tags: it.tags, symptom: it.symptom, source: it.source }
            };
          });
        });
      }
      if (action === 'unlock') {
        var mid = data.methodId;
        var pts = getPoints();
        if (!unlockedSet()[mid] && pts < 10) {
          return Promise.resolve({ error: 'insufficient_points', currentPoints: pts, offline: true });
        }
        return findById(mid).then(function (it) {
          if (!it) return { error: 'not_found', offline: true };
          return getContent(it).then(function (c) {
            var remain = pts;
            if (!unlockedSet()[mid]) { remain = setPoints(pts - 10); markUnlocked(mid); }
            return {
              success: true, remainingPoints: remain, offline: true,
              data: { _id: it._id, title: it.title, content: c, tags: it.tags, symptom: it.symptom, source: it.source }
            };
          });
        });
      }
      return Promise.resolve({ error: 'offline_unsupported', offline: true });
    }

    if (fnName === 'commentShare') {
      var key = 'lnhy_cmt_' + (data.methodId || '');
      if (action === 'getComments') {
        return Promise.resolve({ success: true, list: lsGet(key, []), offline: true });
      }
      if (action === 'comment') {
        var arr = lsGet(key, []);
        arr.unshift({ content: data.content, createTime: Date.now() });
        lsSet(key, arr.slice(0, 50));
        var np = setPoints(getPoints() + 5);
        return Promise.resolve({
          success: true, message: '评论已保存（离线模式，仅本机可见）',
          pointsAdded: 5, currentPoints: np, offline: true
        });
      }
      return Promise.resolve({ error: 'offline_unsupported', offline: true });
    }

    if (fnName === 'autoImport') {
      var am = action || data.mode;   // 兼容 uploads.html 用 action、manage.html 用 mode
      if (am === 'listUploads') {
        return fetch(DATA_BASE + 'uploads.json', { cache: 'no-cache' })
          .then(function (r) { return r.json(); })
          .then(function (j) { return { success: true, list: j.list || [], offline: true }; });
      }
      if (am === 'checkDup') {
        var q = (data.source || '').trim();
        return fetch(DATA_BASE + 'uploads.json', { cache: 'no-cache' })
          .then(function (r) { return r.json(); })
          .then(function (j) {
            var norm = function (s) {
              return String(s || '').replace(/^\d{9,}-/, '').replace(/\.[A-Za-z0-9]{1,5}$/, '').trim();
            };
            var t = norm(q), hit = null;
            (j.list || []).forEach(function (x) { if (!hit && norm(x.source) === t) hit = x; });
            return { success: true, exists: !!hit, record: hit, offline: true };
          });
      }
      if (am === 'listAll') {
        return loadIdx().then(function (l) {
          var list = l.map(function (it) {
            return { _id: it._id, title: it.title, source: '-', viewCount: 0, q: it.q || 0 };
          });
          list.sort(function (a, b) { return (b.q || 0) - (a.q || 0); });
          return { success: true, list: list, total: list.length, offline: true };
        });
      }
      return Promise.resolve({ error: 'offline_unsupported', offline: true });
    }

    return Promise.resolve({ error: 'offline_unsupported', offline: true });
  }

  // ---------- 顶部提示条 ----------
  var bannerShown = false;
  function banner(msg) {
    if (bannerShown) return;
    bannerShown = true;
    try {
      var d = document.createElement('div');
      d.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:99999;background:#fff4e5;' +
        'color:#8a5300;font-size:12px;line-height:1.5;padding:7px 12px;text-align:center;' +
        'box-shadow:0 1px 4px rgba(0,0,0,.12)';
      d.textContent = msg || '📴 维护模式：云端服务升级中，已切换为本地阅读（养生方完整可看，维护期免费）。⚠️ 内容整理自民间资料，仅供文化参考，不构成医疗建议，身体不适请就医。';
      d.onclick = function () { d.parentNode && d.parentNode.removeChild(d); };
      (document.body || document.documentElement).appendChild(d);
      setTimeout(function () { d.parentNode && d.parentNode.removeChild(d); }, 8000);
    } catch (e) {}
  }

  global.LNHY_STATIC = {
    handle: handle,
    loadIdx: loadIdx,
    search: search,
    getContent: getContent,
    findById: findById,
    banner: banner,
    getPoints: getPoints
  };
})(window);
