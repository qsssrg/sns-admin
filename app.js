/* SNS運用 管理画面 — GitHub Contents API 直結の静的SPA
 *
 * データリポジトリ(private可)の以下を読み書きする:
 *   読み: sns_team/{state,queue,strategy,config}/...
 *   書き: sns_team/config/*.yaml(コメント保持), sns_team/state/decisions/<post-id>.json
 * ローカル cron マシン側は git_sync.sh / apply_decisions.py が同期・適用する。
 */
"use strict";

const LS_KEY = "snsadmin.cfg.v1";
const SNS = "sns_team";
const JST = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo", month: "numeric", day: "numeric",
  hour: "2-digit", minute: "2-digit",
});

let cfg = null;
try { cfg = JSON.parse(localStorage.getItem(LS_KEY) || "null"); } catch (_) {}

/* ---------------- GitHub API レイヤー ---------------- */

function b64decode(b64) {
  const bin = atob(b64.replace(/\n/g, ""));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder("utf-8").decode(bytes);
}
function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}
function encPath(p) { return p.split("/").map(encodeURIComponent).join("/"); }

async function gh(path, opts = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    cache: "no-store",
    ...opts,
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(opts.headers || {}),
    },
  });
  if (res.status === 401) {
    showAuth("トークンが無効か期限切れです(401)。PAT を再設定してください。");
    throw new Error("401 unauthorized");
  }
  return res;
}
function contentsPath(p) {
  return `/repos/${cfg.owner}/${cfg.repo}/contents/${encPath(p)}`;
}

async function getFile(path) {
  const r = await gh(`${contentsPath(path)}?ref=${encodeURIComponent(cfg.branch)}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GET ${path}: HTTP ${r.status}`);
  const j = await r.json();
  return { text: b64decode(j.content), sha: j.sha };
}
async function getJson(path) {
  const f = await getFile(path);
  return f ? JSON.parse(f.text) : null;
}
async function getImageDataUri(path, mime = "image/jpeg") {
  const r = await gh(`${contentsPath(path)}?ref=${encodeURIComponent(cfg.branch)}`);
  if (!r.ok) return null;
  const j = await r.json();
  if (!j.content) return null;
  return `data:${mime};base64,${j.content.replace(/\n/g, "")}`;
}
async function listDir(path) {
  const r = await gh(`${contentsPath(path)}?ref=${encodeURIComponent(cfg.branch)}`);
  if (r.status === 404) return [];
  if (!r.ok) throw new Error(`LIST ${path}: HTTP ${r.status}`);
  const j = await r.json();
  return Array.isArray(j) ? j.filter((e) => e.name !== ".gitkeep") : [];
}

// 書き込みは常に直列化(ブランチ先頭の競合を避ける)
let writeChain = Promise.resolve();
function serialized(fn) {
  const p = writeChain.then(fn);
  writeChain = p.catch(() => {});
  return p;
}

// mode: "retry"(decisions 用: 409/422 は sha を取り直して再試行)
//       "fail" (設定ファイル用: 他者の編集を潰さないよう即エラー)
function putFile(path, text, message, sha, mode = "fail") {
  return serialized(async () => {
    let curSha = sha;
    for (let attempt = 0; attempt < 3; attempt++) {
      const body = { message, content: b64encode(text), branch: cfg.branch };
      if (curSha) body.sha = curSha;
      const r = await gh(contentsPath(path), { method: "PUT", body: JSON.stringify(body) });
      if (r.ok) return (await r.json()).content;
      if ((r.status === 409 || r.status === 422) && mode === "retry") {
        const cur = await getFile(path);
        curSha = cur ? cur.sha : undefined;
        continue;
      }
      if (r.status === 409 || r.status === 422) {
        throw new Error("他の変更と衝突しました。再読み込みしてから保存し直してください。");
      }
      throw new Error(`保存失敗 ${path}: HTTP ${r.status}`);
    }
    throw new Error(`保存失敗 ${path}: 競合が解消できません`);
  });
}
function deleteFile(path, message) {
  return serialized(async () => {
    const cur = await getFile(path);
    if (!cur) return;
    const r = await gh(contentsPath(path), {
      method: "DELETE",
      body: JSON.stringify({ message, sha: cur.sha, branch: cfg.branch }),
    });
    if (!r.ok && r.status !== 404) throw new Error(`削除失敗 ${path}: HTTP ${r.status}`);
  });
}

/* ---------------- UI ユーティリティ ---------------- */

const $ = (sel, el = document) => el.querySelector(sel);
const view = $("#view");

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (k === "text") node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null) continue;
    node.append(c.nodeType ? c : document.createTextNode(c));
  }
  return node;
}
function toast(msg, ms = 2600) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove("show"), ms);
}
function renderMd(md) {
  const div = el("div", { class: "md" });
  div.innerHTML = DOMPurify.sanitize(marked.parse(md || ""));
  return div;
}
function errorCard(e) {
  return el("div", { class: "error-box", text: `エラー: ${e.message || e}` });
}
function fmtJst(iso) {
  try { return JST.format(new Date(iso)); } catch (_) { return String(iso); }
}

/* ---------------- 接続設定 ---------------- */

function showAuth(note) {
  const d = $("#auth-dialog");
  if (cfg) {
    $("#in-token").value = cfg.token || "";
    $("#in-owner").value = cfg.owner || "qsssrg";
    $("#in-repo").value = cfg.repo || "claudecode";
    $("#in-branch").value = cfg.branch || "main";
  }
  if (note) toast(note, 4000);
  if (!d.open) d.showModal();
}
$("#auth-form").addEventListener("submit", (ev) => {
  if (ev.submitter && ev.submitter.value === "save") {
    cfg = {
      token: $("#in-token").value.trim(),
      owner: $("#in-owner").value.trim(),
      repo: $("#in-repo").value.trim(),
      branch: $("#in-branch").value.trim() || "main",
    };
    localStorage.setItem(LS_KEY, JSON.stringify(cfg));
    route();
  }
});
$("#btn-auth").addEventListener("click", () => showAuth());
$("#btn-reload").addEventListener("click", () => route());

/* ---------------- ルーター ---------------- */

let currentTab = "dashboard";
document.querySelectorAll("#tabbar .tab").forEach((b) =>
  b.addEventListener("click", () => {
    currentTab = b.dataset.tab;
    document.querySelectorAll("#tabbar .tab").forEach((x) =>
      x.classList.toggle("active", x === b));
    route();
  }));

async function route() {
  if (!cfg || !cfg.token) { view.replaceChildren(el("p", { class: "muted", text: "GitHub 接続設定をしてください(右上 ⚙)" })); showAuth(); return; }
  view.replaceChildren(el("p", { class: "muted", text: "読み込み中…" }));
  try {
    if (currentTab === "dashboard") await renderDashboard();
    else if (currentTab === "approve") await renderApprove();
    else if (currentTab === "activity") await renderActivity();
    else await renderSettings();
  } catch (e) {
    console.error(e);
    view.replaceChildren(errorCard(e));
  }
}

/* ---------------- ダッシュボード ---------------- */

async function renderDashboard() {
  const [pending, approved, published, rejected, heartbeat, ledger, schedFile,
         budgetFile, budgetLedger, metrics, dailyList, activity] = await Promise.all([
    listDir(`${SNS}/queue/pending`), listDir(`${SNS}/queue/approved`),
    listDir(`${SNS}/queue/published`), listDir(`${SNS}/queue/rejected`),
    getJson(`${SNS}/state/heartbeat.json`).catch(() => null),
    getJson(`${SNS}/state/token_ledger.json`).catch(() => null),
    getFile(`${SNS}/config/schedule.yaml`),
    getFile(`${SNS}/config/budget.yaml`),
    getJson(`${SNS}/state/budget_ledger.json`).catch(() => null),
    getJson(`${SNS}/state/metrics.json`).catch(() => null),
    listDir(`${SNS}/strategy/daily`),
    getJson(`${SNS}/state/activity_log.json`).catch(() => null),
  ]);

  const frag = [];

  // ローカル機ハートビート
  let hb = el("span", { class: "badge err", text: "ローカル機: 未同期" });
  if (heartbeat && heartbeat.ts) {
    const ageMin = Math.round((Date.now() - new Date(heartbeat.ts).getTime()) / 60000);
    const cls = ageMin > 720 ? "err" : ageMin > 120 ? "warn" : "ok";
    hb = el("span", { class: `badge ${cls}`, text: `ローカル機 最終同期: ${ageMin}分前 (${fmtJst(heartbeat.ts)})` });
  }
  frag.push(el("div", { class: "card" }, el("h2", { text: "稼働状況" }), hb));

  // 直近の実行(エージェントが何をしたか)
  const entries = ((activity && activity.entries) || []).slice(-5).reverse();
  const runCard = el("div", { class: "card" }, el("h2", { text: "直近の実行" }));
  if (!entries.length) {
    runCard.append(el("p", { class: "muted small", text: "まだ実行記録がありません(パイプライン実行後に表示されます)" }));
  }
  for (const en of entries) {
    runCard.append(el("div", { class: "post-meta" },
      statusBadge(en.status),
      el("span", { class: "badge", text: en.name }),
      ` ${fmtJst(en.ts)} `,
      el("div", { class: "small", text: en.summary || "" })));
    runCard.append(el("hr", { class: "sep" }));
  }
  runCard.append(el("p", { class: "muted small", text: "全履歴は「ログ」タブへ" }));
  frag.push(runCard);

  // キュー
  const stat = (n, label) => el("div", { class: "stat" },
    el("div", { class: "num", text: String(n) }), el("div", { class: "label", text: label }));
  frag.push(el("div", { class: "card" }, el("h2", { text: "投稿キュー" }),
    el("div", { class: "stat-row" },
      stat(pending.length, "承認待ち"), stat(approved.length, "承認済み"),
      stat(published.length, "公開済み"), stat(rejected.length, "却下"))));

  // 成果サマリー(直近7日): 公開数(post-id の日付から集計)+ 反応合計
  {
    const cut = new Date(Date.now() - 7 * 86400e3);
    const cutKey = `${cut.getFullYear()}${String(cut.getMonth() + 1).padStart(2, "0")}${String(cut.getDate()).padStart(2, "0")}`;
    const recent = published.filter((e) => (e.name.match(/^(\d{8})-/) || [])[1] >= cutKey);
    const perPlatform = {};
    for (const e2 of recent) {
      const pf = (e2.name.split("-")[2] || "?");
      perPlatform[pf] = (perPlatform[pf] || 0) + 1;
    }
    let imp = 0, likes = 0, clicks = 0;
    const best = new Map();
    for (const r of (metrics && metrics.records) || []) {
      if (new Date(r.ts) < cut) continue;
      const prev = best.get(r.post_id);
      if (!prev || r.snapshot_day > prev.snapshot_day) best.set(r.post_id, r);
    }
    for (const r of best.values()) {
      imp += r.metrics.impressions || 0; likes += r.metrics.likes || 0; clicks += r.metrics.clicks || 0;
    }
    const card = el("div", { class: "card" }, el("h2", { text: "成果(直近7日)" }),
      el("div", { class: "stat-row" },
        stat(recent.length, "公開投稿"), stat(imp.toLocaleString(), "インプレッション"),
        stat(likes.toLocaleString(), "いいね"), stat(clicks.toLocaleString(), "クリック")));
    if (Object.keys(perPlatform).length) {
      card.append(el("div", { class: "post-meta", text:
        "内訳: " + Object.entries(perPlatform).map(([k, v]) => `${k} ${v}件`).join(" / ") }));
    }
    frag.push(card);
  }

  // トークンウィンドウ
  if (ledger) {
    let limits = ledger.limits || {};
    try {
      const sched = YAML.parse(schedFile.text);
      if (sched && sched.limits) limits = { ...limits, ...sched.limits };
    } catch (_) {}
    const now = Date.now() / 1000;
    const winSum = (sec) => (ledger.runs || [])
      .filter((r) => r.ts >= now - sec)
      .reduce((a, r) => a + (r.weight || 1), 0);
    const gauge = (used, limit, label) => {
      const pct = limit ? Math.min(100, (used / limit) * 100) : 0;
      const cls = pct >= 90 ? "err" : pct >= 70 ? "warn" : "";
      const g = el("div", { class: `gauge ${cls}` }, el("div"));
      g.firstChild.style.width = `${pct}%`;
      return el("div", {}, el("div", { class: "small muted", text: `${label}: ${used} / ${limit}` }), g);
    };
    frag.push(el("div", { class: "card" }, el("h2", { text: "トークンウィンドウ(重み)" }),
      gauge(winSum(5 * 3600), limits.per_5h_weight || 6, "直近5時間"),
      gauge(winSum(7 * 86400), limits.per_week_weight || 120, "直近1週間")));
  }

  // 予算
  if (budgetFile) {
    try {
      const budget = YAML.parse(budgetFile.text);
      const month = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" }).slice(0, 7);
      const spent = ((budgetLedger && budgetLedger.spend) || [])
        .filter((s) => (s.ts || "").startsWith(month))
        .reduce((a, s) => a + (s.cost_jpy || 0), 0);
      const total = budget.monthly_budget_jpy || 0;
      const pct = total ? Math.min(100, (spent / total) * 100) : 0;
      const cls = pct >= (budget.alert_threshold || 0.8) * 100 ? "warn" : "";
      const g = el("div", { class: `gauge ${cls}` }, el("div"));
      g.firstChild.style.width = `${pct}%`;
      frag.push(el("div", { class: "card" }, el("h2", { text: "動画API予算(今月)" }),
        el("div", { class: "small muted", text: `¥${spent.toLocaleString()} / ¥${total.toLocaleString()}` }), g));
    } catch (_) {}
  }

  // 直近メトリクス上位
  if (metrics && (metrics.records || []).length) {
    const cutoff = Date.now() - 7 * 86400e3;
    const best = new Map();
    for (const r of metrics.records) {
      if (new Date(r.ts).getTime() < cutoff) continue;
      const prev = best.get(r.post_id);
      if (!prev || (r.metrics.impressions || 0) > (prev.metrics.impressions || 0)) best.set(r.post_id, r);
    }
    const top = [...best.values()]
      .sort((a, b) => (b.metrics.impressions || 0) - (a.metrics.impressions || 0)).slice(0, 5);
    const card = el("div", { class: "card" }, el("h2", { text: "直近7日 上位投稿" }));
    if (!top.length) card.append(el("p", { class: "muted small", text: "データなし" }));
    for (const r of top) {
      card.append(el("div", { class: "post-meta" },
        el("span", { class: "badge accent", text: r.platform }),
        ` imp ${r.metrics.impressions ?? "-"} / like ${r.metrics.likes ?? "-"} / click ${r.metrics.clicks ?? "-"} `,
        el("div", { class: "mono", text: r.post_id })));
      card.append(el("hr", { class: "sep" }));
    }
    frag.push(card);
  }

  // 最新の日次PDCAレポート
  const mds = dailyList.filter((e) => e.name.endsWith(".md")).sort((a, b) => a.name.localeCompare(b.name));
  if (mds.length) {
    const latest = mds[mds.length - 1];
    const f = await getFile(`${SNS}/strategy/daily/${latest.name}`);
    frag.push(el("div", { class: "card" },
      el("h2", { text: `日次PDCAレポート (${latest.name.replace(".md", "")})` }),
      renderMd(f.text)));
  } else {
    frag.push(el("div", { class: "card" }, el("h2", { text: "日次PDCAレポート" }),
      el("p", { class: "muted small", text: "まだレポートがありません(運用開始後に毎晩生成されます)" })));
  }

  view.replaceChildren(...frag);
}

/* ---------------- ログタブ(実行内容と成果の履歴) ---------------- */

function statusBadge(status) {
  const map = { ok: ["ok", "成功"], deferred: ["warn", "延期"], error: ["err", "エラー"] };
  const [cls, label] = map[status] || ["", status];
  return el("span", { class: `badge ${cls}`, text: label });
}

const KIND_LABEL = { pipeline: "パイプライン", publish: "投稿", analytics: "計測", decision: "承認反映" };

async function renderActivity() {
  const activity = await getJson(`${SNS}/state/activity_log.json`).catch(() => null);
  const entries = ((activity && activity.entries) || []).slice(-100).reverse();

  const frag = [el("div", { class: "card" },
    el("h2", { text: `実行ログ(直近 ${entries.length}件)` }),
    el("p", { class: "muted small", text:
      "エージェントの実行内容と成果の記録。「成功」の詳細を開くと、その回の実行レポート全文(要約)が読めます。" }))];

  if (!entries.length) {
    frag.push(el("div", { class: "card" },
      el("p", { class: "muted", text: "まだ実行記録がありません。cron でパイプラインが動き始めると、ここに履歴が積み上がります。" })));
  }

  let lastDay = "";
  for (const en of entries) {
    const day = (en.ts || "").slice(0, 10);
    if (day !== lastDay) {
      frag.push(el("h2", { class: "muted small", text: day }));
      lastDay = day;
    }
    const card = el("div", { class: "card" });
    card.append(el("div", {},
      statusBadge(en.status),
      el("span", { class: "badge accent", text: KIND_LABEL[en.kind] || en.kind }),
      el("span", { class: "badge", text: en.name }),
      ` ${fmtJst(en.ts)}`,
      en.duration_s ? el("span", { class: "muted small", text: ` ・${Math.round(en.duration_s)}秒` }) : null));
    card.append(el("div", { class: "post-meta", text: en.summary || "" }));
    const result = en.detail && en.detail.result;
    if (result) {
      const pre = el("div", { class: "post-body", text: result });
      card.append(el("details", { class: "raw-section" },
        el("summary", { text: "実行レポートを読む" }), pre));
    }
    frag.push(card);
  }
  view.replaceChildren(...frag);
}

/* ---------------- 承認タブ ---------------- */

async function renderApprove() {
  const [pendingDirs, decisionFiles] = await Promise.all([
    listDir(`${SNS}/queue/pending`),
    listDir(`${SNS}/state/decisions`),
  ]);
  const decisions = new Set(decisionFiles.map((f) => f.name.replace(/\.json$/, "")));
  const dirs = pendingDirs.filter((e) => e.type === "dir");

  const frag = [el("div", { class: "card" },
    el("h2", { text: `承認待ち: ${dirs.length}件` }),
    el("p", { class: "muted small", text: "決定は state/decisions/ に記録され、ローカル機の次回同期(publish 時刻)で反映されます。" }))];

  for (const dir of dirs) {
    const id = dir.name; // 一覧の文字列をそのまま使う(日本語IDの正規化ずれ防止)
    try {
      const post = JSON.parse((await getFile(`${SNS}/queue/pending/${id}/post.json`)).text);
      frag.push(await approveCard(id, post, decisions.has(id)));
    } catch (e) {
      frag.push(el("div", { class: "card" }, el("h3", { class: "mono", text: id }), errorCard(e)));
    }
  }
  if (!dirs.length) frag.push(el("div", { class: "card" }, el("p", { class: "muted", text: "承認待ちの投稿はありません 🎉" })));
  view.replaceChildren(...frag);
}

async function approveCard(id, post, hasDecision) {
  const s = post.safety || {};
  const flags = s.flags || [];
  const errors = s.errors || [];
  const cta = post.cta || null;
  const insp = post.inspiration || null;

  const card = el("div", { class: "card" });
  card.append(el("div", {},
    el("span", { class: "badge accent", text: post.platform }),
    el("span", { class: "badge", text: post.type }),
    hasDecision ? el("span", { class: "badge warn", text: "反映待ち(決定済み)" }) : null,
    errors.length ? el("span", { class: "badge err", text: `エラー${errors.length}` }) : null,
    flags.length ? el("span", { class: "badge warn", text: `⚑ ${flags.length}` }) : null,
  ));
  card.append(el("div", { class: "post-body", text: post.body || "" }));
  const meta = el("div", { class: "post-meta" });
  if ((post.hashtags || []).length) meta.append(el("div", { text: (post.hashtags || []).map((h) => `#${String(h).replace(/^#/, "")}`).join(" ") }));
  if (post.scheduled_at) meta.append(el("div", { text: `予定: ${fmtJst(post.scheduled_at)}` }));
  if (cta) meta.append(el("div", {}, `CTA: ${cta.goal_id || "-"} `, cta.utm_url ? el("span", { class: "mono", text: cta.utm_url }) : null));
  if (insp && insp.source_url) {
    const a = el("a", { href: insp.source_url, target: "_blank", rel: "noopener noreferrer", text: "参考元" });
    meta.append(el("div", {}, a, ` — ${insp.adaptation_note || ""}`));
  }
  for (const f of flags) meta.append(el("div", { class: "small", text: `⚑ ${f}` }));
  for (const e2 of errors) meta.append(el("div", { class: "small", text: `❌ ${e2}` }));
  meta.append(el("div", { class: "mono", text: id }));
  card.append(meta);

  if (post.type === "video") {
    const uri = await getImageDataUri(`${SNS}/queue/pending/${id}/media/poster.jpg`).catch(() => null);
    if (uri) card.append(el("img", { class: "poster", src: uri, alt: "poster" }));
    else card.append(el("p", { class: "muted small", text: "(ポスター画像なし — 動画本体はローカル機にあります)" }));
  }

  const row = el("div", { class: "row" });
  if (hasDecision) {
    row.append(el("button", { class: "btn secondary", text: "決定を取り消す", onclick: async (ev) => {
      ev.target.disabled = true;
      try { await deleteFile(`${SNS}/state/decisions/${id}.json`, `webui: cancel decision for ${id}`); toast("決定を取り消しました"); route(); }
      catch (e) { toast(e.message); ev.target.disabled = false; }
    }}));
  } else {
    const decide = async (action, reason, btn) => {
      btn.disabled = true;
      try {
        const body = JSON.stringify({ action, reason, ts: new Date().toISOString(), by: "webui" }, null, 2);
        await putFile(`${SNS}/state/decisions/${id}.json`, body, `webui: ${action} ${id}`, undefined, "retry");
        toast(action === "approve" ? "承認しました(次回同期で反映)" : "却下しました");
        route();
      } catch (e) { toast(e.message); btn.disabled = false; }
    };
    const approveBtn = el("button", { class: "btn ok", text: "承認", onclick: (ev) => {
      if (errors.length && !confirm("検証エラーがあります。承認してもローカル側で拒否されます。続けますか?")) return;
      decide("approve", "webui approve", ev.target);
    }});
    const rejectBtn = el("button", { class: "btn danger", text: "却下", onclick: (ev) => {
      const reason = prompt("却下理由(PDCAの学習材料になります):");
      if (!reason) return;
      decide("reject", reason, ev.target);
    }});
    row.append(approveBtn, rejectBtn);
  }
  card.append(row);
  return card;
}

/* ---------------- 設定タブ ---------------- */

const SETTING_TABS = [
  { key: "accounts", label: "アカウント", file: `${SNS}/config/accounts.yaml` },
  { key: "conversions", label: "コンバージョン", file: `${SNS}/config/conversions.yaml` },
  { key: "budget", label: "予算", file: `${SNS}/config/budget.yaml` },
  { key: "safety", label: "セーフティ", file: `${SNS}/config/safety.yaml` },
  { key: "schedule", label: "スケジュール", file: `${SNS}/config/schedule.yaml` },
];
let settingTab = "accounts";

/* ---- AIおまかせ設定(要望→AI提案→人間ジャッジ) ---- */

async function renderPlannerCard() {
  const card = el("div", { class: "card" }, el("h2", { text: "🤖 AIおまかせ設定" }));
  try {
    const [reqFiles, propDirs, decisionFiles] = await Promise.all([
      listDir(`${SNS}/state/plan_requests`),
      listDir(`${SNS}/state/config_proposals`),
      listDir(`${SNS}/state/decisions`),
    ]);
    const reqJsons = reqFiles.filter((e) => e.name.endsWith(".json")).sort((a, b) => a.name.localeCompare(b.name));
    const latestReqFile = reqJsons[reqJsons.length - 1];
    const latestReq = latestReqFile
      ? JSON.parse((await getFile(`${SNS}/state/plan_requests/${latestReqFile.name}`)).text) : null;
    const reqId = latestReq ? latestReq.id : null;

    const propDir = reqId && propDirs.find((d) => d.type === "dir" && d.name === reqId);
    let propFiles = [];
    if (propDir) propFiles = await listDir(`${SNS}/state/config_proposals/${reqId}`);
    const propApplied = propFiles.some((f2) => f2.name === "applied.json");
    const propRejected = propFiles.some((f2) => f2.name === "rejected.json");
    const hasOpenProposal = propDir && !propApplied && !propRejected;
    const hasPlanDecision = reqId && decisionFiles.some((f2) => f2.name === `plan-${reqId}.json`);

    if (hasOpenProposal && hasPlanDecision) {
      card.append(el("p", { class: "post-meta", text: "判定済み — ローカル機の次回同期で反映されます。" }),
        el("span", { class: "badge warn", text: "反映待ち" }));
    } else if (hasOpenProposal) {
      // ---- 提案レビュー ----
      const rat = await getFile(`${SNS}/state/config_proposals/${reqId}/rationale.md`).catch(() => null);
      card.append(el("p", { class: "muted small", text: "AIからの提案が届いています。内容を読んで採用/却下をジャッジしてください。" }));
      if (rat) card.append(renderMd(rat.text));
      for (const pf of propFiles.filter((f2) => /\.(yaml|md)$/.test(f2.name) && f2.name !== "rationale.md")) {
        const body = await getFile(`${SNS}/state/config_proposals/${reqId}/${pf.name}`).catch(() => null);
        if (body) card.append(el("details", { class: "raw-section" },
          el("summary", { text: `提案ファイル: ${pf.name}` }),
          el("div", { class: "post-body", text: body.text })));
      }
      const row = el("div", { class: "row" });
      row.append(el("button", { class: "btn ok", text: "この提案を採用", onclick: async (ev) => {
        ev.target.disabled = true;
        try {
          await putFile(`${SNS}/state/decisions/plan-${reqId}.json`,
            JSON.stringify({ action: "apply_plan", proposal_id: reqId,
              ts: new Date().toISOString(), by: "webui" }, null, 2),
            `webui: apply plan ${reqId}`, undefined, "retry");
          toast("採用しました。ローカル機の次回同期で設定に反映されます"); route();
        } catch (e) { toast(e.message); ev.target.disabled = false; }
      }}));
      row.append(el("button", { class: "btn danger", text: "却下(改訂を依頼)", onclick: async (ev) => {
        const reason = prompt("却下理由・直してほしい点(AIが次の提案に反映します):");
        if (!reason) return;
        ev.target.disabled = true;
        try {
          await putFile(`${SNS}/state/decisions/plan-${reqId}.json`,
            JSON.stringify({ action: "reject_plan", proposal_id: reqId, reason,
              ts: new Date().toISOString(), by: "webui" }, null, 2),
            `webui: reject plan ${reqId}`, undefined, "retry");
          toast("却下を記録しました。改訂案が次回作成されます"); route();
        } catch (e) { toast(e.message); ev.target.disabled = false; }
      }}));
      card.append(row);
    } else if (latestReq && latestReq.status === "pending") {
      card.append(el("p", { class: "post-meta" },
        el("span", { class: "badge warn", text: "AIプラン作成待ち" }),
        el("div", { class: "small", text: `要望: ${latestReq.brief || ""}` }),
        el("div", { class: "muted small", text:
          "次回の plan_config 実行(毎日 9:30 / 16:30、またはローカルで sns_team/scripts/run_pipeline.sh plan_config)で提案が作成されます。" })));
      if ((latestReq.feedback || []).length) {
        card.append(el("p", { class: "muted small", text:
          `前回の却下理由を反映した改訂案を作成予定: ${latestReq.feedback[latestReq.feedback.length - 1].reason}` }));
      }
    } else {
      // ---- 要望フォーム ----
      card.append(el("p", { class: "muted small", text:
        "やりたいことを一言で書くだけでOK。AIがSNSの成功事例を調査し、テーマ・トーン・投稿頻度・時間帯・CV導線までの設定プランを設計して提案します。あなたは採用/却下を判断するだけです。" }));
      const brief = textareaField("何を発信したい?どうなりたい?",
        "", "例: ガンプラ好き向けに情報発信して、月1万円のアフィリエイト収益を目指したい");
      const sell = input("売りたいもの・誘導したい先(任意)", "", { placeholder: "例: Amazonアソシエイト、自分のメルマガ" });
      const links = input("そのURL(任意)", "", { placeholder: "https://..." });
      const refs = input("参考にしたいアカウント(任意)", "", { placeholder: "@例 など" });
      const btn = el("button", { class: "btn primary", text: "AIにプラン設計を依頼", onclick: async (ev) => {
        if (!brief.ta.value.trim()) { toast("要望を入力してください"); return; }
        ev.target.disabled = true;
        try {
          const now = new Date();
          const id = `req-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`;
          await putFile(`${SNS}/state/plan_requests/${id}.json`,
            JSON.stringify({ id, ts: now.toISOString(), brief: brief.ta.value.trim(),
              sell: sell.inp.value.trim(), links: links.inp.value.trim(),
              reference_accounts: refs.inp.value.trim(), status: "pending", by: "webui",
              feedback: [] }, null, 2),
            `webui: plan request ${id}`, undefined, "retry");
          toast("依頼しました。次回の plan_config 実行で提案が作成されます"); route();
        } catch (e) { toast(e.message); ev.target.disabled = false; }
      }});
      card.append(brief.wrap, sell.wrap, links.wrap, refs.wrap, el("div", { class: "row" }, btn));
    }
  } catch (e) {
    card.append(errorCard(e));
  }
  return card;
}

async function renderSettings() {
  const tabs = el("div", { class: "subtabs" });
  for (const t of SETTING_TABS) {
    tabs.append(el("button", {
      class: t.key === settingTab ? "active" : "",
      text: t.label,
      onclick: () => { settingTab = t.key; route(); },
    }));
  }
  const plannerCard = await renderPlannerCard();

  const t = SETTING_TABS.find((x) => x.key === settingTab);
  const file = await getFile(t.file);
  if (!file) { view.replaceChildren(plannerCard, tabs, errorCard(new Error(`${t.file} がありません`))); return; }
  const doc = YAML.parseDocument(file.text);
  const js = doc.toJS() || {};

  const body = el("div", {});
  const save = async (mutate, btn) => {
    btn.disabled = true;
    try {
      mutate(doc);
      const res = await putFile(t.file, doc.toString(), `webui: update ${t.file.split("/").pop()}`, file.sha, "fail");
      file.sha = res.sha;
      toast("保存しました(ローカル機の次回同期で反映)");
      route();
    } catch (e) { toast(e.message, 5000); btn.disabled = false; }
  };

  if (t.key === "accounts") renderAccountsForm(body, js, save);
  else if (t.key === "conversions") renderConversionsForm(body, js, save);
  else if (t.key === "budget") renderBudgetForm(body, js, save);
  else if (t.key === "safety") renderSafetyForm(body, js, save);
  else renderScheduleForm(body, js, save);

  // 生YAMLエディタ(全ファイル共通のフォールバック)
  const ta = el("textarea", { class: "yaml-raw" });
  ta.value = file.text;
  const rawBtn = el("button", { class: "btn primary", text: "生YAMLを保存", onclick: async (ev) => {
    ev.target.disabled = true;
    try {
      YAML.parse(ta.value); // 構文チェック
      const res = await putFile(t.file, ta.value, `webui: raw edit ${t.file.split("/").pop()}`, file.sha, "fail");
      file.sha = res.sha;
      toast("保存しました");
      route();
    } catch (e) { toast(`YAMLエラー: ${e.message}`, 6000); ev.target.disabled = false; }
  }});
  body.append(el("details", { class: "raw-section" },
    el("summary", { text: "生YAMLを直接編集(上級者向け)" }), ta,
    el("div", { class: "row" }, rawBtn)));

  view.replaceChildren(plannerCard, tabs, body);
}

function input(labelText, value, attrs = {}) {
  const inp = el("input", { type: "text", ...attrs });
  inp.value = value ?? "";
  return { wrap: el("div", {}, el("label", { text: labelText }), inp), inp };
}
function checkbox(labelText, checked) {
  const inp = el("input", { type: "checkbox" });
  inp.checked = !!checked;
  return { wrap: el("label", { class: "check" }, inp, labelText), inp };
}
function textareaField(labelText, value, hint) {
  const ta = el("textarea");
  ta.value = value ?? "";
  return { wrap: el("div", {}, el("label", { text: labelText + (hint ? `(${hint})` : "") }), ta), ta };
}
function saveBtn(text = "保存") { return el("button", { class: "btn primary", text }); }
const lines = (s) => s.split("\n").map((x) => x.trim()).filter(Boolean);

function renderAccountsForm(body, js, save) {
  const controls = [];
  for (const [key, p] of Object.entries(js.platforms || {})) {
    const enabled = checkbox("有効", p.enabled);
    const theme = textareaField("テーマ", p.theme);
    const tone = textareaField("トーン", p.tone);
    const ftext = input("テキスト投稿数/日", (p.frequency || {}).text ?? 0, { type: "number", min: 0 });
    const vweek = input("動画本数/週", p.video_per_week ?? 0, { type: "number", min: 0 });
    const windows = input("投稿時間帯(カンマ区切り)", (p.posting_windows || []).join(", "));
    const apText = checkbox("テキスト自動投稿 (auto_publish)", (p.auto_publish || {}).text);
    const apVideo = checkbox("動画自動投稿 (auto_publish)", (p.auto_publish || {}).video);
    controls.push({ key, p, enabled, theme, tone, ftext, vweek, windows, apText, apVideo });
    body.append(el("div", { class: "card" },
      el("h3", { text: `${key}(優先度 ${p.priority ?? "-"})` }),
      enabled.wrap, theme.wrap, tone.wrap, ftext.wrap,
      p.video_per_week !== undefined ? vweek.wrap : null,
      windows.wrap, apText.wrap, apVideo.wrap));
  }
  const btn = saveBtn("アカウント設定を保存");
  btn.addEventListener("click", () => save((doc) => {
    for (const c of controls) {
      const base = ["platforms", c.key];
      doc.setIn([...base, "enabled"], c.enabled.inp.checked);
      doc.setIn([...base, "theme"], c.theme.ta.value);
      doc.setIn([...base, "tone"], c.tone.ta.value);
      doc.setIn([...base, "frequency", "text"], Number(c.ftext.inp.value) || 0);
      if (c.p.video_per_week !== undefined) doc.setIn([...base, "video_per_week"], Number(c.vweek.inp.value) || 0);
      doc.setIn([...base, "posting_windows"], c.windows.inp.value.split(",").map((s) => s.trim()).filter(Boolean));
      doc.setIn([...base, "auto_publish", "text"], c.apText.inp.checked);
      doc.setIn([...base, "auto_publish", "video"], c.apVideo.inp.checked);
    }
  }, btn));
  body.append(el("div", { class: "row" }, btn));
}

function renderConversionsForm(body, js, save) {
  const goals = (js.goals || []).map((g) => ({ ...g }));
  const listWrap = el("div", {});
  const controls = [];

  const renderGoals = () => {
    listWrap.replaceChildren();
    controls.length = 0;
    goals.forEach((g, i) => {
      const id = input("ID(英数字)", g.id);
      const type = el("select", {},
        ...["affiliate", "signup", "sales", "other"].map((v) =>
          el("option", { value: v, text: v, ...(g.type === v ? { selected: "" } : {}) })));
      const label = input("表示名", g.label);
      const url = input("リンク先URL", g.base_url);
      const platforms = input("対象プラットフォーム(カンマ区切り)", (g.platforms || []).join(", "));
      const enabled = checkbox("有効", g.enabled !== false);
      const del = el("button", { class: "btn danger", text: "この目標を削除", onclick: () => { goals.splice(i, 1); renderGoals(); } });
      controls.push({ g, id, type, label, url, platforms, enabled });
      listWrap.append(el("div", { class: "card" },
        el("h3", { text: g.id || "(新規)" }),
        id.wrap, el("div", {}, el("label", { text: "種別" }), type),
        label.wrap, url.wrap, platforms.wrap, enabled.wrap,
        el("div", { class: "row" }, del)));
    });
  };
  renderGoals();

  const addBtn = el("button", { class: "btn secondary", text: "＋ 目標を追加", onclick: () => {
    goals.push({ id: "", type: "affiliate", label: "", base_url: "",
      utm_template: "utm_source={platform}&utm_medium=social&utm_campaign={pillar}&utm_content={post_id}",
      platforms: ["x"], enabled: true });
    renderGoals();
  }});

  const rot = js.cta_rotation || {};
  const ratio = input("価値提供投稿の比率 (0-1)", rot.value_post_ratio ?? 0.7, { type: "number", step: "0.05", min: 0, max: 1 });
  const maxCta = input("CTA投稿の上限/日/プラットフォーム", rot.max_cta_per_day_per_platform ?? 1, { type: "number", min: 0 });

  const btn = saveBtn("コンバージョン設定を保存");
  btn.addEventListener("click", () => save((doc) => {
    const arr = controls.map((c) => ({
      id: c.id.inp.value.trim(),
      type: c.type.value,
      label: c.label.inp.value,
      base_url: c.url.inp.value.trim(),
      utm_template: c.g.utm_template ||
        "utm_source={platform}&utm_medium=social&utm_campaign={pillar}&utm_content={post_id}",
      platforms: c.platforms.inp.value.split(",").map((s) => s.trim()).filter(Boolean),
      enabled: c.enabled.inp.checked,
    }));
    if (arr.some((g) => !g.id || !g.base_url)) throw new Error("ID と URL は必須です");
    doc.setIn(["goals"], arr);
    doc.setIn(["cta_rotation", "value_post_ratio"], Number(ratio.inp.value));
    doc.setIn(["cta_rotation", "max_cta_per_day_per_platform"], Number(maxCta.inp.value));
  }, btn));

  body.append(listWrap, el("div", { class: "row" }, addBtn),
    el("div", { class: "card" }, el("h3", { text: "CTAローテーション" }), ratio.wrap, maxCta.wrap),
    el("div", { class: "row" }, btn));
}

function renderBudgetForm(body, js, save) {
  const total = input("月間予算(円)", js.monthly_budget_jpy ?? 0, { type: "number", min: 0 });
  const alert = input("警告しきい値 (0-1)", js.alert_threshold ?? 0.8, { type: "number", step: "0.05", min: 0, max: 1 });
  const toolCtl = [];
  const toolsCard = el("div", { class: "card" }, el("h3", { text: "動画生成ツール" }));
  for (const [name, tconf] of Object.entries(js.tools || {})) {
    const enabled = checkbox(`${name} を有効化`, tconf.enabled);
    const cost = input(`${name} 単価(円/本)`, tconf.cost_per_video_jpy ?? 0, { type: "number", min: 0 });
    toolCtl.push({ name, enabled, cost });
    toolsCard.append(enabled.wrap, cost.wrap, el("hr", { class: "sep" }));
  }
  const btn = saveBtn("予算設定を保存");
  btn.addEventListener("click", () => save((doc) => {
    doc.setIn(["monthly_budget_jpy"], Number(total.inp.value) || 0);
    doc.setIn(["alert_threshold"], Number(alert.inp.value) || 0.8);
    for (const c of toolCtl) {
      doc.setIn(["tools", c.name, "enabled"], c.enabled.inp.checked);
      doc.setIn(["tools", c.name, "cost_per_video_jpy"], Number(c.cost.inp.value) || 0);
    }
  }, btn));
  body.append(el("div", { class: "card" }, total.wrap, alert.wrap), toolsCard, el("div", { class: "row" }, btn));
}

function renderSafetyForm(body, js, save) {
  const ng = textareaField("NGワード", (js.ng_words || []).join("\n"), "1行に1語");
  const flag = textareaField("要注意キーワード", ((js.review || {}).flag_keywords || []).join("\n"), "1行に1語。含む投稿は自動承認されない");
  const manual = textareaField("常時手動承認プラットフォーム", ((js.review || {}).always_manual || []).join("\n"), "1行に1つ");
  const btn = saveBtn("セーフティ設定を保存");
  btn.addEventListener("click", () => save((doc) => {
    doc.setIn(["ng_words"], lines(ng.ta.value));
    doc.setIn(["review", "flag_keywords"], lines(flag.ta.value));
    doc.setIn(["review", "always_manual"], lines(manual.ta.value));
  }, btn));
  body.append(el("div", { class: "card" },
    el("p", { class: "muted small", text: "禁止トピック・文字数上限は生YAMLで編集してください。" }),
    ng.wrap, flag.wrap, manual.wrap),
    el("div", { class: "row" }, btn));
}

function renderScheduleForm(body, js, save) {
  const lim = js.limits || {};
  const w5 = input("5時間ウィンドウ上限(重み合計)", lim.per_5h_weight ?? 6, { type: "number", min: 1 });
  const wk = input("週間ウィンドウ上限(重み合計)", lim.per_week_weight ?? 120, { type: "number", min: 1 });
  const btn = saveBtn("トークン上限を保存");
  btn.addEventListener("click", () => save((doc) => {
    doc.setIn(["limits", "per_5h_weight"], Number(w5.inp.value) || 6);
    doc.setIn(["limits", "per_week_weight"], Number(wk.inp.value) || 120);
  }, btn));
  body.append(el("div", { class: "card" },
    el("h3", { text: "トークン制限(5時間 / 週間)" }),
    el("p", { class: "muted small", text: "Claude サブスクのトークン枠に対する保守的なゲート。パイプラインの重み・cron 時刻は生YAMLで編集。" }),
    w5.wrap, wk.wrap),
    el("div", { class: "row" }, btn));
}

/* ---------------- 起動 ---------------- */
route();
