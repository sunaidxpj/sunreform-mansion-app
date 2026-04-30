// サンリフォーム マンション検索 SPA
// Microsoft Entra ID (MSAL.js) でログイン → Cloud Run API でデータ取得

const CONFIG = {
  AZURE_TENANT_ID: "45878bb2-84d5-46e8-b4c2-d50f6b61e4a9",
  AZURE_CLIENT_ID: "eef6d57e-fbbd-4d81-a5bd-26299819a205",
  REDIRECT_URI: "https://sunaidxpj.github.io/sunreform-mansion-app/",
  API_BASE: "https://sunbo-v2-504595374043.asia-northeast1.run.app",
  LIST_CACHE_KEY: "sunreform_mansion_list_v1",
};

const msalConfig = {
  auth: {
    clientId: CONFIG.AZURE_CLIENT_ID,
    authority: `https://login.microsoftonline.com/${CONFIG.AZURE_TENANT_ID}`,
    redirectUri: CONFIG.REDIRECT_URI,
  },
  cache: {
    cacheLocation: "localStorage",
    storeAuthStateInCookie: false,
  },
};

const loginRequest = { scopes: ["openid", "profile", "email"] };
const tokenRequest = { scopes: [`${CONFIG.AZURE_CLIENT_ID}/.default`] };

let msalClient = null;  // bootstrap() で初期化

const STATE = {
  account: null,
  idToken: null,
  mansions: [],
  filtered: [],
  sort: "site_count_desc",       // "site_count_desc" | "name_asc"
  selected: null,
  detail: null,
  expandedSites: new Set(),       // 現場行の展開状態（site.id の集合）
  rawNotes: null,                  // null=未取得, []=空, [...]=取得済
  rawNotesOpen: false,
  lastError: null,
};

// ===== 認証 =====

async function ensureToken() {
  const account = msalClient.getAllAccounts()[0];
  if (!account) return null;
  try {
    const res = await msalClient.acquireTokenSilent({
      ...loginRequest,
      account,
    });
    STATE.idToken = res.idToken;
    STATE.account = account;
    return res.idToken;
  } catch (e) {
    console.warn("Silent token failed, redirecting:", e);
    await msalClient.loginRedirect(loginRequest);
    return null;
  }
}

async function startLogin() {
  await msalClient.loginRedirect(loginRequest);
}

function logout() {
  try { sessionStorage.removeItem(CONFIG.LIST_CACHE_KEY); } catch (_) {}
  msalClient.logoutRedirect({ postLogoutRedirectUri: CONFIG.REDIRECT_URI });
}

// ===== API =====

async function api(action, params = {}) {
  const url = new URL(CONFIG.API_BASE);
  url.searchParams.set("action", action);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${STATE.idToken}` },
  });
  if (res.status === 401) {
    STATE.idToken = null;
    STATE.account = null;
    render();
    throw new Error("認証が切れました。再ログインしてください。");
  }
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`API error ${res.status}: ${t}`);
  }
  return res.json();
}

async function loadMansions() {
  STATE.lastError = null;
  // 1. キャッシュがあれば即表示（裏で最新取得）
  try {
    const cached = sessionStorage.getItem(CONFIG.LIST_CACHE_KEY);
    if (cached) {
      const items = JSON.parse(cached);
      if (Array.isArray(items) && items.length) {
        STATE.mansions = items;
        render();
      }
    }
  } catch (_) { /* 壊れていれば無視 */ }

  // 2. 最新を取得
  try {
    const data = await api("mansion-list");
    STATE.mansions = data.items || [];
    try {
      sessionStorage.setItem(CONFIG.LIST_CACHE_KEY, JSON.stringify(STATE.mansions));
    } catch (_) {}
    // 検索中なら再フィルタ
    const q = document.getElementById("q")?.value;
    if (q) filterMansions(q);
    render();
  } catch (e) {
    STATE.lastError = e.message;
    render();
  }
}

async function showDetail(key) {
  STATE.selected = key;
  STATE.detail = null;
  STATE.rawNotes = null;
  STATE.rawNotesOpen = false;
  STATE.expandedSites = new Set();
  STATE.lastError = null;
  render();
  try {
    const data = await api("mansion-detail", { key });
    STATE.detail = data;
    render();
  } catch (e) {
    STATE.lastError = e.message;
    render();
  }
}

function goBack() {
  STATE.selected = null;
  STATE.detail = null;
  STATE.rawNotes = null;
  STATE.rawNotesOpen = false;
  STATE.expandedSites = new Set();
  render();
}

function toggleSiteRow(siteId) {
  if (STATE.expandedSites.has(siteId)) {
    STATE.expandedSites.delete(siteId);
  } else {
    STATE.expandedSites.add(siteId);
  }
  render();
}

async function toggleRawNotes() {
  STATE.rawNotesOpen = !STATE.rawNotesOpen;
  if (STATE.rawNotesOpen && STATE.rawNotes === null) {
    try {
      const data = await api("mansion-raw-notes", { key: STATE.selected });
      STATE.rawNotes = data.items || [];
    } catch (e) {
      STATE.rawNotes = [];
      STATE.lastError = e.message;
    }
  }
  render();
}

// ===== 検索 =====

function normalize(s) {
  // NFKC: 全角英数→半角、半角ｶﾅ→全角ｶﾅ、互換文字統一
  let t = String(s || "").normalize("NFKC").toLowerCase();
  // 空白除去
  t = t.replace(/[\s　]/g, "");
  // カタカナ→ひらがな（NFKC後なので半角ｶﾅも全角化済み）
  t = t.replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60));
  // 長音・中黒・各種ハイフン→無視（区切り扱い）
  t = t.replace(/[ー‐\-–—・]/g, "");
  return t;
}

function sortItems(items) {
  const arr = items.slice();
  if (STATE.sort === "name_asc") {
    arr.sort((a, b) => (a.name || "").localeCompare(b.name || "", "ja"));
  } else {
    // site_count_desc（既定）: 件数多い順、同点は名前順
    arr.sort((a, b) =>
      (b.site_count || 0) - (a.site_count || 0) ||
      (a.name || "").localeCompare(b.name || "", "ja")
    );
  }
  return arr;
}

function filterMansions(query) {
  const q = normalize(query);
  if (!q) {
    STATE.filtered = [];
    return;
  }
  const matched = STATE.mansions.filter(m =>
    normalize(m.name).includes(q) || normalize(m.city).includes(q)
  );
  STATE.filtered = sortItems(matched).slice(0, 100);
}

function changeSort(value) {
  STATE.sort = value;
  const q = document.getElementById("q")?.value || "";
  filterMansions(q);
  const area = document.getElementById("results-area");
  if (area) area.innerHTML = renderList();
}

// ===== レンダリング =====

const app = document.getElementById("app");

function escHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

function formatDate(s) {
  if (!s) return "";
  // "2026-04-23 06:01:52.192000+00:00" / "2021/9/4" / ISO 等を年月日に整形
  const str = String(s).trim();
  const m = str.match(/(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
  if (!m) return str;
  const [, y, mo, d] = m;
  return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

function formatAddress(m) {
  const parts = [m.address1, m.address2].filter(Boolean).join("");
  return parts || m.city || "";
}

function formatYen(v) {
  if (v === null || v === undefined || v === "") return "";
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  return `¥${n.toLocaleString()}`;
}

function profitRate(contract, profit) {
  const c = Number(contract), p = Number(profit);
  if (!Number.isFinite(c) || c === 0 || !Number.isFinite(p)) return "";
  return `${(p / c * 100).toFixed(1)}%`;
}

function staffWithRate(name, rate) {
  if (!name) return "";
  const r = Number(rate);
  if (Number.isFinite(r) && r > 0 && r < 100) {
    return `${name} (${r}%)`;
  }
  return name;
}

function buildSiteDetailRows(s) {
  // 現場行展開時に表示する追加情報。空フィールドは省く。
  const fields = [];
  const recv = formatDate(s.reception_date);
  const cont = formatDate(s.contract_date);
  if (recv) fields.push(["受付日", recv]);
  if (cont) fields.push(["契約日", cont]);
  if (s.media_name) fields.push(["媒体", s.media_name]);
  if (s.branch_name) fields.push(["店舗", s.branch_name]);
  const total = formatYen(s.total_amount);
  if (total) fields.push(["総額", total]);

  const staff = [];
  const main = staffWithRate(s.main_staff, s.main_division_rate);
  const sub = staffWithRate(s.sub_staff, s.sub_division_rate);
  const design = staffWithRate(s.design_staff, s.design_division_rate);
  if (main) staff.push(`主担当: ${main}`);
  if (sub) staff.push(`副担当: ${sub}`);
  if (design) staff.push(`設計: ${design}`);
  const extras = [];
  for (const slot of [4, 5, 6]) {
    const n = staffWithRate(s[`staff${slot}`], s[`staff${slot}_division_rate`]);
    if (n) extras.push(n);
  }
  if (extras.length) staff.push(`他担当: ${extras.join(", ")}`);
  if (s.charge_staff) staff.push(`担当者: ${s.charge_staff}`);
  if (staff.length) fields.push(["担当", staff.join(" / ")]);

  if (!fields.length) {
    return `<div style="color:#6e6e73">追加情報なし</div>`;
  }
  return `<div class="grid">` + fields.map(([k, v]) =>
    `<div><span class="k">${escHtml(k)}:</span><span class="v">${escHtml(v)}</span></div>`
  ).join("") + `</div>`;
}

function sourceLabel(source) {
  if (source === "app") return { text: "アプリ入力", cls: "src-app" };
  if (source === "dm_completed") return { text: "完工DM返信", cls: "src-dm" };
  if (source === "dm_new") return { text: "新規引合DM返信", cls: "src-dm" };
  if (source === "legacy_import") return { text: "移行データ", cls: "src-legacy" };
  return { text: source || "不明", cls: "src-legacy" };
}

// ANDPAD情報 セクション: バックエンドから ANDPAD情報 オブジェクトが来たら表示
const ANDPAD_GROUPS = [
  {
    title: "物件",
    fields: [
      "物件備考",
      "工事可能時間（選択）", "工事可能時間",
      "土曜日の工事（選択）",
      "駐車スペース（選択）", "駐車スペース",
      "タバコ喫煙ルール（選択）",
      "近隣承認（選択）", "近隣承認",
      "近隣挨拶範囲（選択）", "近隣挨拶範囲",
      "エレベーター", "オートロック",
    ],
  },
  {
    title: "管理",
    fields: [
      "管理人名", "管理人TEL",
      "理事長名",
      "管理会社名", "管理会社担当名", "管理会社TEL",
      "管理体制", "勤務時間",
    ],
  },
  {
    title: "案件",
    fields: [
      "案件名", "案件種別", "案件フロー",
      "案件備考", "その他",
      "キーBOX", "集合ポスト",
      "養生範囲（共用部）",
      "遮音規制（選択）", "遮音規制",
      "スリーブ穴あけ可否（選択）", "スリーブ穴あけ可否",
      "インターホン交換", "専有部消火器",
      "自火報工事の有無/指定業者",
      "挨拶不在者（選択）", "挨拶不在者",
    ],
  },
];

function renderAndpadSection(m) {
  const a = m["ANDPAD情報"];
  if (!a || typeof a !== "object") return "";

  const groupHtml = ANDPAD_GROUPS.map(g => {
    const rows = g.fields
      .filter(k => a[k] !== undefined && a[k] !== null && String(a[k]).trim() !== "")
      .map(k => `
        <div class="andpad-row">
          <span class="andpad-k">${escHtml(k)}</span>
          <span class="andpad-v">${escHtml(a[k])}</span>
        </div>
      `).join("");
    if (!rows) return "";
    return `<div class="andpad-group"><h4>${escHtml(g.title)}</h4>${rows}</div>`;
  }).join("");

  if (!groupHtml) return "";
  return `
    <div class="section">
      <h3>ANDPAD情報 ${a.synced_at ? `<span class="andpad-synced">同期: ${formatDate(a.synced_at)}</span>` : ""}</h3>
      <div class="andpad-body">${groupHtml}</div>
    </div>
  `;
}

function renderRawNotesSection(m) {
  const count = m.raw_notes_count || 0;
  const label = STATE.rawNotesOpen
    ? `▾ 原文を隠す`
    : `▸ 原文を見る（${count}件）`;
  if (count === 0 && !STATE.rawNotesOpen) return "";
  let body = "";
  if (STATE.rawNotesOpen) {
    if (STATE.rawNotes === null) {
      body = `<div class="loading">読み込み中…</div>`;
    } else if (!STATE.rawNotes.length) {
      body = `<div class="empty-state" style="padding:16px">原文はまだありません。</div>`;
    } else {
      body = `<div class="raw-list">` + STATE.rawNotes.map(n => {
        const src = sourceLabel(n.source);
        const parts = [
          `<span class="${src.cls}">${escHtml(src.text)}</span>`,
          escHtml(n.author_name || ""),
          formatDate(n.created_at),
          n.site_id ? `現場 ${escHtml(n.site_id)}` : "",
        ].filter(Boolean);
        return `
          <div class="raw-item">
            <div class="meta">${parts.join(" · ")}</div>
            <div class="body">${escHtml(n.body || "")}</div>
          </div>
        `;
      }).join("") + `</div>`;
    }
  }
  return `
    <button class="raw-toggle" onclick="toggleRawNotes()">${label}</button>
    ${body}
  `;
}

function statusChip(status) {
  if (!status) return "";
  const s = String(status);
  let tone = "neutral";
  if (s.includes("完工") || s.includes("入金")) tone = "success";
  else if (s.includes("進行") || s.includes("着工") || s.includes("契約")) tone = "active";
  else if (s.includes("断") || s.includes("失注") || s.includes("中止")) tone = "muted";
  return `<span class="status-chip status-${tone}">${escHtml(s)}</span>`;
}

function renderLogin() {
  app.innerHTML = `
    <div class="login-screen">
      <div class="login-box">
        <h2>サンリフォーム マンション検索</h2>
        <p>Microsoftアカウント（@sunreform.jp）でログインしてください。</p>
        <button onclick="startLogin()">
          <svg width="18" height="18" viewBox="0 0 21 21" aria-hidden="true">
            <rect x="1" y="1" width="9" height="9" fill="#f25022"/>
            <rect x="11" y="1" width="9" height="9" fill="#7fba00"/>
            <rect x="1" y="11" width="9" height="9" fill="#00a4ef"/>
            <rect x="11" y="11" width="9" height="9" fill="#ffb900"/>
          </svg>
          Microsoftでサインイン
        </button>
      </div>
    </div>
  `;
}

function renderHeader() {
  const email = STATE.account?.username || "";
  return `
    <header>
      <h1>サンリフォーム マンション検索</h1>
      <span class="user">${escHtml(email)}</span>
      <button class="logout" onclick="logout()">ログアウト</button>
    </header>
  `;
}

function renderError(msg, retryFn) {
  return `<div class="error">
    <span>${escHtml(msg)}</span>
    ${retryFn ? `<button class="retry" onclick="${retryFn}">再試行</button>` : ""}
  </div>`;
}

function renderList() {
  if (STATE.lastError) {
    return renderError(STATE.lastError, "loadMansions()");
  }
  if (!STATE.mansions.length) {
    return `<div class="loading">マンション一覧を読み込み中…</div>`;
  }
  const q = document.getElementById("q")?.value || "";
  if (!q.trim()) {
    return `<div class="empty-state">マンション名または市名で絞り込んでください（${STATE.mansions.length.toLocaleString()}件）</div>`;
  }
  if (!STATE.filtered.length) {
    return `<div class="empty-state">該当するマンションが見つかりませんでした。</div>`;
  }
  const cards = STATE.filtered.map(m => `
    <div class="card" onclick='showDetail(${JSON.stringify(m.key)})'>
      <div class="name">
        ${escHtml(m.name)}
        ${m.site_count > 1 ? `<span class="count-badge">${m.site_count}現場</span>` : ""}
      </div>
      <div class="city">${escHtml(formatAddress(m) || "（住所未登録）")}</div>
    </div>
  `).join("");
  return `
    <div class="sort-bar">
      <span>${STATE.filtered.length}件${STATE.filtered.length >= 100 ? " 以上（先頭100件を表示）" : ""}</span>
      <span style="margin-left:auto">並び替え:</span>
      <select onchange="changeSort(this.value)">
        <option value="site_count_desc"${STATE.sort==="site_count_desc"?" selected":""}>工事件数（多い順）</option>
        <option value="name_asc"${STATE.sort==="name_asc"?" selected":""}>名前順</option>
      </select>
    </div>
    <div class="results">${cards}</div>
  `;
}

function renderDetail() {
  if (!STATE.detail) {
    return `
      <button class="back" onclick="goBack()">← 一覧に戻る</button>
      ${STATE.lastError ? renderError(STATE.lastError, `showDetail(${JSON.stringify(STATE.selected)})`) : `<div class="loading">読み込み中…</div>`}
    `;
  }
  const m = STATE.detail.mansion || {};
  const sites = (STATE.detail.sites || []).slice().sort((a, b) => {
    const da = a.reception_date || a.contract_date || "";
    const db_ = b.reception_date || b.contract_date || "";
    return db_.localeCompare(da);  // 降順
  });
  const 申し送り = (m["申し送り"] || "").trim();
  const sitesRows = sites.length
    ? sites.map(s => {
        const addr = [s.contruction_add1, s.contruction_add2].filter(Boolean).join("") || s.city || "";
        const status = s.construction_status || "";
        const staff = s.main_staff || "";
        const yen = formatYen(s.contract_amount);
        const rate = profitRate(s.contract_amount, s.profit_amount);
        const date = formatDate(s.reception_date || s.contract_date || s.synced_at);
        const expanded = STATE.expandedSites.has(s.id);
        const arrow = `<span class="arrow">▸</span>`;
        const idJson = JSON.stringify(s.id);
        const mainTr = `
        <tr class="site-row${expanded ? " expanded" : ""}" onclick='toggleSiteRow(${idJson})'>
          <td data-label="現場ID">${arrow} ${escHtml(s.id)}</td>
          <td data-label="住所"${addr ? "" : ' data-empty="1"'}>${escHtml(addr)}</td>
          <td data-label="工事状況"${status ? "" : ' data-empty="1"'}>${statusChip(status)}</td>
          <td data-label="担当"${staff ? "" : ' data-empty="1"'}>${escHtml(staff)}</td>
          <td data-label="工事金額" style="text-align:right"${yen ? "" : ' data-empty="1"'}>${escHtml(yen)}</td>
          <td data-label="利益率" style="text-align:right"${rate ? "" : ' data-empty="1"'}>${escHtml(rate)}</td>
          <td data-label="日付"${date ? "" : ' data-empty="1"'}>${escHtml(date)}</td>
        </tr>`;
        const detailTr = expanded
          ? `<tr class="site-detail"><td colspan="7">${buildSiteDetailRows(s)}</td></tr>`
          : "";
        return mainTr + detailTr;
      }).join("")
    : `<tr><td colspan="7" style="text-align:center;color:#6e6e73;padding:24px">紐付く工事履歴がありません</td></tr>`;
  return `
    <button class="back" onclick="goBack()">← 一覧に戻る</button>
    <div class="detail">
      <h2>${escHtml(m.name)}</h2>
      <div class="sub">${escHtml(formatAddress(m))}　/　現場履歴 ${sites.length}件</div>
      <div class="section">
        <h3>申し送り事項 <button class="edit-memo" onclick="startEditMemo()">編集</button></h3>
        <div id="memo-display" class="申し送り${申し送り ? "" : " empty"}">${申し送り ? escHtml(申し送り) : "（未登録）"}</div>
        <div id="memo-editor" style="display:none">
          <textarea id="memo-textarea" rows="6" style="width:100%;padding:12px;font-family:inherit;font-size:14px;border:1px solid #d2d2d7;border-radius:8px;resize:vertical">${escHtml(申し送り)}</textarea>
          <div style="margin-top:8px;display:flex;gap:8px">
            <button onclick="saveMemo()" id="memo-save-btn" style="background:#0066cc;color:#fff;border:0;padding:8px 16px;border-radius:6px;cursor:pointer">保存</button>
            <button onclick="cancelEditMemo()" style="background:#f5f5f7;color:#1d1d1f;border:1px solid #d2d2d7;padding:8px 16px;border-radius:6px;cursor:pointer">キャンセル</button>
            <span id="memo-status" style="color:#6e6e73;font-size:13px;align-self:center"></span>
          </div>
        </div>
        ${m.memo_updated_at ? `<div style="color:#6e6e73;font-size:12px;margin-top:6px">最終更新: ${formatDate(m.memo_updated_at)} by ${escHtml(m.memo_updated_by || "")}</div>` : ""}
        ${renderRawNotesSection(m)}
      </div>
      ${renderAndpadSection(m)}
      <div class="section sites">
        <h3>関連する現場</h3>
        <table>
          <thead><tr><th>現場ID</th><th>住所</th><th>工事状況</th><th>担当</th><th style="text-align:right">工事金額</th><th style="text-align:right">利益率</th><th>日付</th></tr></thead>
          <tbody>${sitesRows}</tbody>
        </table>
      </div>
    </div>
  `;
}

function renderMain() {
  app.innerHTML = `
    ${renderHeader()}
    <div class="container">
      ${STATE.selected ? renderDetail() : `
        <div class="search">
          <input id="q" type="search" placeholder="マンション名で検索…" autocomplete="off">
        </div>
        <div id="results-area">${renderList()}</div>
      `}
    </div>
  `;
  const q = document.getElementById("q");
  if (q) {
    q.focus();
    q.addEventListener("input", e => {
      filterMansions(e.target.value);
      const area = document.getElementById("results-area");
      if (area) area.innerHTML = renderList();
    });
  }
}

function render() {
  if (!STATE.idToken) {
    renderLogin();
  } else {
    renderMain();
  }
}

function startEditMemo() {
  document.getElementById("memo-display").style.display = "none";
  document.getElementById("memo-editor").style.display = "block";
  document.getElementById("memo-textarea").focus();
}

function cancelEditMemo() {
  document.getElementById("memo-display").style.display = "";
  document.getElementById("memo-editor").style.display = "none";
  document.getElementById("memo-status").textContent = "";
}

async function saveMemo() {
  const memo = document.getElementById("memo-textarea").value;
  const btn = document.getElementById("memo-save-btn");
  const status = document.getElementById("memo-status");
  btn.disabled = true;
  status.textContent = "保存中…（Geminiが要約を更新します）";
  try {
    const url = new URL(CONFIG.API_BASE);
    url.searchParams.set("action", "mansion-update-memo");
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${STATE.idToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ key: STATE.selected, memo }),
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`保存失敗: ${res.status} ${t}`);
    }
    const data = await res.json().catch(() => ({}));
    // 新仕様: バックエンドが Gemini 要約を summary で返す。
    // 旧仕様フォールバック: 無ければユーザー入力をそのまま表示。
    STATE.detail.mansion["申し送り"] =
      (data.summary !== undefined) ? data.summary : memo;
    if (typeof data.raw_notes_count === "number") {
      STATE.detail.mansion.raw_notes_count = data.raw_notes_count;
    }
    // 原文キャッシュは無効化（次回展開時に再取得）
    STATE.rawNotes = null;
    STATE.detail.mansion.memo_updated_at = new Date().toISOString();
    STATE.detail.mansion.memo_updated_by = STATE.account?.username || "";
    render();
  } catch (e) {
    status.textContent = e.message;
    btn.disabled = false;
  }
}

window.startLogin = startLogin;
window.logout = logout;
window.showDetail = showDetail;
window.goBack = goBack;
window.startEditMemo = startEditMemo;
window.cancelEditMemo = cancelEditMemo;
window.saveMemo = saveMemo;
window.toggleRawNotes = toggleRawNotes;
window.toggleSiteRow = toggleSiteRow;
window.changeSort = changeSort;

// ===== 初期化 =====

(async function bootstrap() {
  if (!window.msal || !window.msal.PublicClientApplication) {
    document.getElementById("app").innerHTML =
      '<div style="padding:2em;font-family:sans-serif;color:#c00">' +
      'Microsoft認証ライブラリ (MSAL) の読み込みに失敗しました。' +
      'ネットワーク環境を確認してから再読み込みしてください。</div>';
    return;
  }
  msalClient = new window.msal.PublicClientApplication(msalConfig);
  await msalClient.initialize();

  // Redirect コールバック処理
  try {
    const res = await msalClient.handleRedirectPromise();
    if (res) {
      STATE.idToken = res.idToken;
      STATE.account = res.account;
    }
  } catch (e) {
    console.error("handleRedirectPromise error:", e);
    STATE.lastError = `サインインに失敗しました: ${e.errorMessage || e.message}`;
    render();
    return;
  }

  // 既存セッション復元
  if (!STATE.idToken) {
    const account = msalClient.getAllAccounts()[0];
    if (account) {
      try {
        const r = await msalClient.acquireTokenSilent({ ...loginRequest, account });
        STATE.idToken = r.idToken;
        STATE.account = account;
      } catch (e) {
        // silent 失敗なら未ログインとして扱う
      }
    }
  }

  render();
  if (STATE.idToken) loadMansions();
})();
