(function () {
  'use strict';
  var app = document.getElementById('app');
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function show(title, msg) { app.innerHTML = '<div class="card home"><h2>' + esc(title) + '</h2><p>' + esc(msg) + '</p><p><a href="./">トップへ</a></p></div>'; }
  window.addEventListener('error', function (e) { show('エラー', e.message); });

  var cfgFb = window.FIREBASE_CONFIG;
  if (typeof firebase === 'undefined') return show('起動できません', 'Firebase SDKを読み込めませんでした。ネットワーク接続を確認してください。');
  if (!cfgFb || !cfgFb.databaseURL || /YOUR/.test(cfgFb.databaseURL)) return show('設定が必要です', 'firebase-config.js にFirebaseの設定(databaseURL含む)を貼り付けてください。');
  firebase.initializeApp(cfgFb);
  var db = firebase.database();

  // 端末ごとの時計ズレをFirebaseサーバー時刻で補正（早書きと同じ考え方）
  var offset = 0;
  db.ref('.info/serverTimeOffset').on('value', function (s) { offset = s.val() || 0; });
  function nowS() { return performance.timeOrigin + performance.now() + offset; }

  var $ = function (id) { return document.getElementById(id); };
  var q = new URLSearchParams(location.search);
  var room = (q.get('room') || '').toUpperCase();
  var rand = function (n, set) { var s = ''; for (var i = 0; i < n; i++) s += set[Math.floor(Math.random() * set.length)]; return s; };
  var CODESET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

  // ---------- state ----------
  var base, isHost = false, me = null, joinShown = false, builtN = 0;
  var DEF = ['#e5483b','#f08a24','#f2c200','#2fa35b','#1fa6a0','#2f78e0','#5b4fd6','#9a4fc9','#d9488f','#6b7a89'];
  var STL = { idle: '待機中', open: '受付中', closed: '締切' };
  var PRE = [['赤','#e5483b'],['青','#2f78e0'],['黄','#f2c200'],['緑','#2fa35b'],['紫','#9a4fc9'],['橙','#f08a24'],['桃','#ec6fa8'],['白','#ffffff'],['黒','#222831']];
  var cfg = { n: 4, max: 0, showResults: true, pubPress: true, lim: 0, labels: {} }, round = null, players = {}, presses = {}, pRef = null;

  function label(i) { var v = cfg.labels && cfg.labels[i]; return v != null && v !== '' ? v : String(i % 10); }
  function color(i) { var v = cfg.colors && cfg.colors[i]; return /^#[0-9a-f]{6}$/i.test(v || '') ? v : DEF[i - 1]; }
  function sty(i) {
    var c = color(i), y = (parseInt(c.substr(1, 2), 16) * 299 + parseInt(c.substr(3, 2), 16) * 587 + parseInt(c.substr(5, 2), 16) * 114) / 1000;
    return 'style="--c:' + c + ';--t:' + (y > 150 ? '#1b2733' : '#fff') + '"';
  }
  function nm(pid) { return (players[pid] && players[pid].name) || '？'; }
  function sec(ms) { return (ms / 1000).toFixed(3) + '秒'; }

  // ---------- home ----------
  if (!room) {
    app.innerHTML = '<div class="card home"><h1>マルチ早押し</h1><p class="mut">0〜9キーで、複数のボタンを押せる早押しツール。</p>' +
      '<p><button class="pri" id="mk">部屋を作る（司会）</button></p><hr>' +
      '<form id="jf"><input type="text" id="jc" placeholder="部屋コード" maxlength="4" autocapitalize="characters" autocomplete="off"><button class="pri">参加する</button></form></div>';
    $('mk').onclick = function () {
      var code = rand(4, CODESET), hostId = rand(16, CODESET);
      db.ref('rooms/' + code + '/meta').once('value').then(function (s) {
        if (s.exists()) return $('mk').click();
        var u = {};
        u.meta = { hostId: hostId, createdAt: firebase.database.ServerValue.TIMESTAMP };
        u.config = { n: 4, max: 0, showResults: true, labels: { 1: 'A', 2: 'B', 3: 'C', 4: 'D' } };
        u.round = { id: 1, state: 'idle' };
        return db.ref('rooms/' + code).update(u).then(function () {
          localStorage.setItem('mbh_host_' + code, hostId);
          location.search = '?room=' + code;
        });
      }).catch(function (e) { show('部屋を作れません', e.message + '（Realtime Databaseのルールと databaseURL を確認してください）'); });
    };
    $('jf').onsubmit = function (e) { e.preventDefault(); var c = $('jc').value.trim().toUpperCase(); if (c) location.search = '?room=' + c; };
    return;
  }

  // ---------- room ----------
  base = db.ref('rooms/' + room);
  base.child('meta').once('value').then(function (s) {
    var meta = s.val();
    if (!meta) return show('部屋が見つかりません', 'コード「' + room + '」の部屋はありません。');
    isHost = localStorage.getItem('mbh_host_' + room) === meta.hostId;
    if (isHost) buildHost(); else me = JSON.parse(localStorage.getItem('mbp_' + room) || 'null');
    if (me) joinRoom();
    listen();
  }).catch(function (e) { show('読み込めません', e.message); });

  function listen() {
    base.child('config').on('value', function (s) {
      cfg = Object.assign({ n: 4, max: 0, showResults: true, pubPress: true, lim: 0, labels: {} }, s.val());
      if (isHost) renderLabs();
      render();
    });
    base.child('round').on('value', function (s) {
      var r = s.val() || { id: 1, state: 'idle' }, changed = !round || round.id !== r.id;
      round = r;
      if (changed) {
        if (pRef) pRef.off();
        presses = {};
        pRef = base.child('presses/' + r.id);
        pRef.on('value', function (ps) { presses = ps.val() || {}; render(); });
      }
      render();
    });
    base.child('players').on('value', function (s) { players = s.val() || {}; render(); });
  }

  function rows() {
    var out = [];
    for (var pid in presses) for (var b in presses[pid]) out.push({ pid: pid, b: +b, t: presses[pid][b] });
    out.sort(function (a, b) { return a.t - b.t; });
    var c = {};
    out.forEach(function (x) { c[x.b] = (c[x.b] || 0) + 1; x.ok = !cfg.lim || c[x.b] <= cfg.lim; });
    return out;
  }

  function resultsHTML() {
    var r = rows();
    if (!r.length) return '<p class="empty">まだ誰も押していません。</p>';
    var t0 = r[0].t, op = round && round.openedAt, cnt = {}, sum = 0, nok = 0;
    var h = '<table class="tb"><tr><th>順</th><th>名前</th><th>ボタン</th><th>開始から</th><th>先頭との差</th></tr>';
    r.forEach(function (x, k) {
      if (x.ok) { cnt[x.b] = (cnt[x.b] || 0) + 1; sum += Number(label(x.b)); nok++; }
      h += '<tr' + (x.ok ? '' : ' class="ng"') + '><td>' + (k + 1) + '</td><td>' + esc(nm(x.pid)) + '</td><td><span class="chip" ' + sty(x.b) + '>' + esc(label(x.b)) + '</span>' + (x.ok ? '' : ' <small>先着外</small>') + '</td><td>' +
        (op ? sec(x.t - op) : '–') + '</td><td>' + (k ? '+' + sec(x.t - t0) : '先頭') + '</td></tr>';
    });
    h += '</table><p class="row">';
    for (var i = 1; i <= cfg.n; i++) h += '<span><span class="chip" ' + sty(i) + '>' + esc(label(i)) + '</span> ×' + (cnt[i] || 0) + '</span>';
    var numeric = true;
    for (i = 1; i <= cfg.n; i++) if (label(i) === '' || isNaN(Number(label(i)))) numeric = false;
    if (numeric) h += '<span>合計 <b>' + sum + '</b>　平均 <b>' + (nok ? sum / nok : 0).toFixed(2) + '</b>（' + nok + '回）</span>';
    return h + '</p>';
  }

  function stageHTML() {
    var all = rows(), hide = !isHost && !cfg.pubPress;
    var r = hide ? all.filter(function (x) { return me && x.pid === me.pid; }) : all;
    var first = '', t0 = r.length && r[0].t;
    if (!hide) for (var k0 = 0; k0 < all.length; k0++) if (all[k0].ok) { first = all[k0].pid; break; }
    var tl = r.length ? r.map(function (x, k) {
      return '<li' + (x.ok ? '' : ' class="ng"') + '><b>' + (k + 1) + '</b><span>' + esc(nm(x.pid)) + '</span><span class="chip" ' + sty(x.b) + '>' + esc(label(x.b)) + '</span><small>' + (k ? '+' + sec(x.t - t0) : '先頭') + (x.ok ? '' : ' 先着外') + '</small></li>';
    }).join('') : '<li class="empty">押された順にここへ表示</li>';
    var ids = Object.keys(players).sort(function (a, b) { return nm(a) < nm(b) ? -1 : 1; });
    var pn = ids.map(function (id) {
      var on = {}, any = false;
      r.forEach(function (x) { if (x.pid === id && x.ok) { on[x.b] = 1; any = true; } });
      var chips = '';
      for (var i = 1; i <= cfg.n; i++) chips += '<span class="chip' + (on[i] ? ' lit' : '') + '" ' + sty(i) + '>' + esc(label(i)) + '</span>';
      return '<div class="pn' + (id === first ? ' first' : '') + (any ? ' lit' : '') + '"><i class="lamp"></i><div class="pname">' + esc(players[id].name) + '</div><div class="pchips">' + chips + '</div></div>';
    }).join('');
    return '<div class="stage"><ol class="tl">' + tl + '</ol><div class="panels">' + (pn || '<p class="empty">参加者を待っています…</p>') + '</div></div>';
  }

  function render() { if (!round) return; if (isHost) renderHost(); else renderPlayer(); }

  // ---------- host ----------
  function buildHost() {
    var url = location.origin + location.pathname + '?room=' + room;
    var D = function (id, t, body) { return '<div class="dlg" id="' + id + '" hidden><div class="dbox"><div class="row"><h3 style="margin:0;flex:1">' + t + '</h3><button class="dx">閉じる</button></div>' + body + '</div></div>'; };
    app.innerHTML = '<div class="top"><div class="row"><span class="code">' + room + '</span><span id="pl"></span></div></div><div id="stg"></div>' +
      '<div class="bar"><div class="row" id="ctl"></div><div class="row"><button id="cp">参加URL</button><button id="mn">設定</button><button id="mb">ボタン設定</button><button id="mr">詳細結果</button></div></div>' +
      D('dlg', '設定', '<div class="row"><label>1人が押せる数<input type="number" id="sm" min="0" max="10"></label><small>0 = 制限なし</small></div>' +
        '<div class="row"><label>各ボタン先着<input type="number" id="sl" min="0" max="99"></label>名まで光る <small>0 = 制限なし（先着外も履歴には残ります）</small></div>' +
        '<label class="row"><input type="checkbox" id="pp"> ボタンを押したかどうかを他の参加者に公開する</label>' +
        '<label class="row"><input type="checkbox" id="shw"> パネル・タイムラインを参加者にも表示する</label>' +
        '<h3>参加者</h3><ul class="plist" id="ply"></ul><div class="row"><button id="clr">全問の履歴を削除</button></div>') +
      D('dlb', 'ボタン設定', '<div class="row"><label>ボタン数（1〜10）<input type="number" id="sn" min="1" max="10"></label></div>' +
        '<p class="mut" style="margin:4px 0">ボタンの内容と色（ラベルが空ならキー番号。色はプリセットか自由選択）</p><div class="labs" id="labs"></div>') +
      D('dlr', '詳細結果', '<div id="res"></div>');
    [['mn', 'dlg'], ['mb', 'dlb'], ['mr', 'dlr']].forEach(function (p) { $(p[0]).onclick = function () { $(p[1]).hidden = false; }; });
    Array.prototype.forEach.call(app.querySelectorAll('.dlg'), function (d) { d.onclick = function (e) { if (e.target === d || e.target.className === 'dx') d.hidden = true; }; });
    $('sl').oninput = function () { base.child('config/lim').set(Math.max(0, Math.min(99, +this.value || 0))); };
    $('cp').onclick = function () { (navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject()).then(function () { $('cp').textContent = 'コピーしました'; }, function () { prompt('参加URL', url); }); };
    $('sn').oninput = function () { var v = Math.max(1, Math.min(10, +this.value || 0)); if (this.value !== '' && v) base.child('config/n').set(v); };
    $('sm').oninput = function () { var v = Math.max(0, Math.min(10, +this.value || 0)); base.child('config/max').set(v); };
    $('labs').oninput = function (e) { if (e.target.dataset.l) base.child('config/labels/' + e.target.dataset.l).set(e.target.value); if (e.target.dataset.c) base.child('config/colors/' + e.target.dataset.c).set(e.target.value);
      if (e.target.dataset.p && e.target.value) { var v = e.target.value, ci = e.target.parentNode.querySelector('[data-c]'); ci.value = v; base.child('config/colors/' + e.target.dataset.p).set(v); e.target.value = ''; } };
    $('ctl').onclick = function (e) {
      var a = e.target.dataset.a, r = base.child('round');
      if (a === 'start') r.update({ state: 'open', openedAt: Math.round(nowS()) });
      if (a === 'stop') r.update({ state: 'closed' });
      if (a === 'next') r.set({ id: round.id + 1, state: 'idle' });
    };
    app.onchange = function (e) { if (e.target.id === 'shw') base.child('config/showResults').set(e.target.checked); if (e.target.id === 'pp') base.child('config/pubPress').set(e.target.checked); };
    $('clr').onclick = function () { if (confirm('これまでの押下記録をすべて削除します。よろしいですか？')) base.child('presses').remove(); };
  }
  function renderLabs() {
    if (!$('labs')) return;
    $('sn').value === '' || document.activeElement !== $('sn') ? $('sn').value = cfg.n : 0;
    if (document.activeElement !== $('sm')) $('sm').value = cfg.max;
    if (builtN === cfg.n) return;
    builtN = cfg.n;
    var h = '';
    var po = '<option value="">色</option>' + PRE.map(function (p) { return '<option value="' + p[1] + '">' + p[0] + '</option>'; }).join('');
    for (var i = 1; i <= cfg.n; i++) h += '<label class="lab"><span class="key">' + (i % 10) + '</span><input type="text" maxlength="12" data-l="' + i + '" value="' + esc(cfg.labels && cfg.labels[i] != null ? cfg.labels[i] : '') + '"><input type="color" data-c="' + i + '" value="' + color(i) + '"><select data-p="' + i + '">' + po + '</select></label>';
    $('labs').innerHTML = h;
  }
  function renderHost() {
    var st = round.state;
    $('pl').innerHTML = '<span class="pill ' + st + '">' + STL[st] + '</span>'; $('ctl').innerHTML = '<button class="pri" data-a="start"' + (st !== 'idle' ? ' disabled' : '') + '>受付開始</button>' +
      '<button data-a="stop"' + (st !== 'open' ? ' disabled' : '') + '>締切</button><button data-a="next">次の問題へ</button>';
    $('shw').checked = !!cfg.showResults; $('pp').checked = cfg.pubPress !== false; if (document.activeElement !== $('sl')) $('sl').value = cfg.lim || 0;
    $('stg').innerHTML = stageHTML();
    $('res').innerHTML = resultsHTML();
    var ids = Object.keys(players);
    $('ply').innerHTML = ids.length ? ids.map(function (id) { return '<li><span class="dot' + (players[id].on ? ' on' : '') + '"></span>' + esc(players[id].name) + '</li>'; }).join('') : '<li class="empty">まだ参加者がいません。</li>';
  }

  // ---------- player ----------
  function joinRoom() {
    var mr = base.child('players/' + me.pid);
    mr.update({ name: me.name });
    db.ref('.info/connected').on('value', function (s) {
      if (s.val()) { mr.child('on').onDisconnect().set(false); mr.child('on').set(true); }
    });
  }
  function showJoin() {
    app.innerHTML = '<div class="card home"><h2>部屋 ' + room + '</h2><form id="nf"><p>名前を入力してください</p><input type="text" id="nn" maxlength="12" autocomplete="off"><button class="pri">参加する</button></form></div>';
    $('nf').onsubmit = function (e) {
      e.preventDefault();
      var n = $('nn').value.trim(); if (!n) return;
      me = { pid: rand(12, CODESET), name: n };
      localStorage.setItem('mbp_' + room, JSON.stringify(me));
      joinRoom(); render();
    };
    $('nn').focus();
  }
  function press(i) {
    if (!me || !round || round.state !== 'open' || i > cfg.n) return;
    var mine = presses[me.pid] || {};
    if (mine[i] != null || (cfg.max && Object.keys(mine).length >= cfg.max)) return;
    base.child('presses/' + round.id + '/' + me.pid + '/' + i).set(Math.round(nowS() * 10) / 10);
  }
  document.addEventListener('keydown', function (e) {
    if (isHost || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    if (/^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
    var m = /^(?:Digit|Numpad)(\d)$/.exec(e.code); if (!m) return;
    press(+m[1] === 0 ? 10 : +m[1]);
  });
  function renderPlayer() {
    if (!me) { if (!joinShown) { joinShown = true; showJoin(); } return; }
    var mine = presses[me.pid] || {}, open = round.state === 'open', cnt = Object.keys(mine).length, full = cfg.max && cnt >= cfg.max;
    var g = '';
    for (var i = 1; i <= cfg.n; i++) {
      var on = mine[i] != null;
      g += '<button class="bz' + (on ? ' on' : '') + '" ' + sty(i) + ' data-i="' + i + '"' + (!open || on || full ? ' disabled' : '') + '><span class="key">' + (i % 10) + '</span>' + esc(label(i)) + (on ? '<span class="ck">✓</span>' : '') + '</button>';
    }
    var msg = open ? (full ? '上限まで押しました' : '押せます！') : round.state === 'closed' ? '締切りました' : '出題を待っています…';
    var order = Object.keys(mine).sort(function (a, b) { return mine[a] - mine[b]; }).map(function (b) { return '<span class="chip" ' + sty(b) + '>' + esc(label(b)) + '</span>'; }).join(' ');
    app.innerHTML = '<div class="top"><div class="row"><span class="code">' + room + '</span><span>' + esc(me.name) + '</span><span class="pill ' + round.state + '">' + (full ? '上限' : STL[round.state]) + '</span></div><button id="rn">名前を変更</button></div>' +
      '<div id="stg">' + (cfg.showResults ? stageHTML() : '') + '</div><div class="grid" style="--cols:' + (cfg.n <= 4 ? cfg.n : cfg.n <= 6 ? 3 : 5) + ';--cm:' + (cfg.n <= 4 ? 2 : 3) + '">' + g + '</div>';
    $('rn').onclick = function () {
      var n = (prompt('名前を入力', me.name) || '').trim(); if (!n) return;
      me.name = n; localStorage.setItem('mbp_' + room, JSON.stringify(me)); base.child('players/' + me.pid + '/name').set(n);
    };
    app.querySelector('.grid').onpointerdown = function (e) { var b = e.target.closest('.bz'); if (b) { e.preventDefault(); press(+b.dataset.i); } };
  }
})();
