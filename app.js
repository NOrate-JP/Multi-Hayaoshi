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
  var cfg = { n: 4, max: 0, showResults: false, labels: {} }, round = null, players = {}, presses = {}, pRef = null;

  function label(i) { var v = cfg.labels && cfg.labels[i]; return v != null && v !== '' ? v : String(i % 10); }
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
        u.config = { n: 4, max: 0, showResults: false, labels: { 1: 'A', 2: 'B', 3: 'C', 4: 'D' } };
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
      cfg = Object.assign({ n: 4, max: 0, showResults: false, labels: {} }, s.val());
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
    return out.sort(function (a, b) { return a.t - b.t; });
  }

  function resultsHTML() {
    var r = rows();
    if (!r.length) return '<p class="empty">まだ誰も押していません。</p>';
    var t0 = r[0].t, op = round && round.openedAt, cnt = {}, sum = 0;
    var h = '<table class="tb"><tr><th>順</th><th>名前</th><th>ボタン</th><th>開始から</th><th>先頭との差</th></tr>';
    r.forEach(function (x, k) {
      cnt[x.b] = (cnt[x.b] || 0) + 1; sum += Number(label(x.b));
      h += '<tr><td>' + (k + 1) + '</td><td>' + esc(nm(x.pid)) + '</td><td><span class="chip c' + x.b + '">' + esc(label(x.b)) + '</span></td><td>' +
        (op ? sec(x.t - op) : '–') + '</td><td>' + (k ? '+' + sec(x.t - t0) : '先頭') + '</td></tr>';
    });
    h += '</table><p class="row">';
    for (var i = 1; i <= cfg.n; i++) h += '<span><span class="chip c' + i + '">' + esc(label(i)) + '</span> ×' + (cnt[i] || 0) + '</span>';
    var numeric = true;
    for (i = 1; i <= cfg.n; i++) if (label(i) === '' || isNaN(Number(label(i)))) numeric = false;
    if (numeric) h += '<span>合計 <b>' + sum + '</b>　平均 <b>' + (sum / r.length).toFixed(2) + '</b>（' + r.length + '回）</span>';
    return h + '</p>';
  }

  function render() { if (!round) return; if (isHost) renderHost(); else renderPlayer(); }

  // ---------- host ----------
  function buildHost() {
    var url = location.origin + location.pathname + '?room=' + room;
    app.innerHTML = '<div class="top"><div><b>マルチ早押し</b>　<span class="code">' + room + '</span></div><button id="cp">参加URLをコピー</button></div>' +
      '<div class="host"><section class="card" id="ctl"></section>' +
      '<section class="card"><h3>設定</h3><div class="row"><label>ボタン数（1〜10）<input type="number" id="sn" min="1" max="10"></label>' +
      '<label>1人が押せる数<input type="number" id="sm" min="0" max="10"></label><small>0 = 制限なし</small></div>' +
      '<p class="mut" style="margin:4px 0">ラベル（空欄ならキー番号を表示）</p><div class="labs" id="labs"></div></section>' +
      '<section class="card wide"><h3>結果</h3><div id="res"></div></section>' +
      '<section class="card wide"><h3>参加者</h3><ul class="plist" id="ply"></ul><div class="row"><button id="clr">全問の履歴を削除</button></div></section></div>';
    $('cp').onclick = function () { (navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject()).then(function () { $('cp').textContent = 'コピーしました'; }, function () { prompt('参加URL', url); }); };
    $('sn').oninput = function () { var v = Math.max(1, Math.min(10, +this.value || 0)); if (this.value !== '' && v) base.child('config/n').set(v); };
    $('sm').oninput = function () { var v = Math.max(0, Math.min(10, +this.value || 0)); base.child('config/max').set(v); };
    $('labs').oninput = function (e) { if (e.target.dataset.l) base.child('config/labels/' + e.target.dataset.l).set(e.target.value); };
    $('ctl').onclick = function (e) {
      var a = e.target.dataset.a, r = base.child('round');
      if (a === 'start') r.update({ state: 'open', openedAt: Math.round(nowS()) });
      if (a === 'stop') r.update({ state: 'closed' });
      if (a === 'next') r.set({ id: round.id + 1, state: 'idle' });
    };
    $('ctl').onchange = function (e) { if (e.target.dataset.a === 'show') base.child('config/showResults').set(e.target.checked); };
    $('clr').onclick = function () { if (confirm('これまでの押下記録をすべて削除します。よろしいですか？')) base.child('presses').remove(); };
  }
  function renderLabs() {
    if (!$('labs')) return;
    $('sn').value === '' || document.activeElement !== $('sn') ? $('sn').value = cfg.n : 0;
    if (document.activeElement !== $('sm')) $('sm').value = cfg.max;
    if (builtN === cfg.n) return;
    builtN = cfg.n;
    var h = '';
    for (var i = 1; i <= cfg.n; i++) h += '<label class="lab"><span class="key">' + (i % 10) + '</span><input type="text" maxlength="12" data-l="' + i + '" value="' + esc(cfg.labels && cfg.labels[i] != null ? cfg.labels[i] : '') + '"></label>';
    $('labs').innerHTML = h;
  }
  function renderHost() {
    var st = round.state;
    $('ctl').innerHTML = '<div class="row"><span class="pill ' + st + '">' + { idle: '待機中', open: '受付中', closed: '締切' }[st] + '</span><b>第' + round.id + '問</b></div>' +
      '<div class="row"><button class="pri" data-a="start"' + (st !== 'idle' ? ' disabled' : '') + '>受付開始</button>' +
      '<button data-a="stop"' + (st !== 'open' ? ' disabled' : '') + '>締切</button><button data-a="next">次の問題へ</button></div>' +
      '<label class="row"><input type="checkbox" data-a="show"' + (cfg.showResults ? ' checked' : '') + '> 結果を参加者にも表示する</label>';
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
      g += '<button class="bz c' + i + (on ? ' on' : '') + '" data-i="' + i + '"' + (!open || on || full ? ' disabled' : '') + '><span class="key">' + (i % 10) + '</span>' + esc(label(i)) + (on ? '<span class="ck">✓</span>' : '') + '</button>';
    }
    var msg = open ? (full ? '上限まで押しました' : '押せます！') : round.state === 'closed' ? '締切りました' : '出題を待っています…';
    var order = Object.keys(mine).sort(function (a, b) { return mine[a] - mine[b]; }).map(function (b) { return '<span class="chip c' + b + '">' + esc(label(b)) + '</span>'; }).join(' ');
    app.innerHTML = '<div class="top"><div><span class="code">' + room + '</span>　' + esc(me.name) + '</div><div class="row"><span class="pill ' + round.state + '">第' + round.id + '問</span><button id="rn">名前を変更</button></div></div>' +
      '<div class="msg">' + msg + '</div><div class="grid" style="--cols:' + (cfg.n <= 4 ? cfg.n : cfg.n <= 6 ? 3 : 5) + '">' + g + '</div>' +
      (order ? '<p>あなたが押した順：' + order + '</p>' : '') +
      (cfg.showResults ? '<section class="card"><h3>結果</h3>' + resultsHTML() + '</section>' : '');
    $('rn').onclick = function () {
      var n = (prompt('名前を入力', me.name) || '').trim(); if (!n) return;
      me.name = n; localStorage.setItem('mbp_' + room, JSON.stringify(me)); base.child('players/' + me.pid + '/name').set(n);
    };
    app.querySelector('.grid').onpointerdown = function (e) { var b = e.target.closest('.bz'); if (b) { e.preventDefault(); press(+b.dataset.i); } };
  }
})();
