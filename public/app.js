/* مفردات – واجهة المستخدم (JS عادي بدون مكتبات) */
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const KIND_AR = { meaning: "معنى الكلمة", sentence: "أكمل الجملة", synonym: "مرادف", antonym: "عكس الكلمة" };
const MODE_AR = { weak: "نقاط الضعف", all: "كل الكلمات", words: "كلمات مختارة" };
const CODE_AR = {
  DUPLICATE: "الكلمة دي مضافة عندك قبل كده.",
  NOT_A_WORD: "ده مش شكله كلمة إنجليزية. راجع الكتابة وجرّب تاني.",
  WORD_INVALID: "اكتب كلمة أو عبارة قصيرة بالإنجليزي بس.",
  WORD_REQUIRED: "اكتب الكلمة الأول.",
  AI_UNAVAILABLE: "الذكاء الاصطناعي مش متاح دلوقتي. جرّب بعد شوية.",
  NO_WORDS: "ضيف كلمات الأول.",
  NO_WEAK_WORDS: "مفيش عندك نقاط ضعف لسه. اعمل اختبار على كل كلماتك الأول.",
  NO_QUESTIONS: "معرفتش أعمل أسئلة للكلمات دي.",
  ALREADY_SUBMITTED: "الاختبار ده اتسلّم قبل كده.",
  IMAGES_UNAVAILABLE: "البحث عن الصور مش متاح دلوقتي. جرّب بعد شوية.",
  NO_IMAGES: "مالقيناش صور للكلمة دي.",
  RATE_LIMIT: "طلبات كتير. استنى شوية وجرّب تاني.",
  NOT_DUE: "البطاقة دي اتراجعت قبل كده ومش مستحقة دلوقتي.",
  CONFLICT: "البطاقة اتغيّرت من مكان تاني. هنكمّل على اللي بعدها.",
  INVALID_RATING: "التقييم مش صحيح.",
  INVALID_LIMIT: "الحد اليومي لازم يكون رقم من 0 لـ 500.",
  INVALID_TIME: "اكتب وقت صحيح للتذكير.",
  INVALID_TIMEZONE: "المنطقة الزمنية مش صحيحة.",
  PUSH_NOT_CONFIGURED: "الإشعارات مش متظبطة على السيرفر لسه.",
  NO_SUBSCRIPTION: "فعّل الإشعارات على الجهاز ده الأول.",
};

const S = {
  user: null, view: "words", vocab: [], weak: [], q: "", draft: "",
  setup: { mode: "all", count: 10, words: new Set() },
  test: null, idx: 0, answers: {}, result: null, history: null,
  rv: { summary: null, remind: null, loading: false, error: "", queue: [], i: 0, total: 0, shown: false, busy: false, reqId: "", stats: null, pushBusy: false },
};

/* ---------- helpers ---------- */
let statusTimer;
function notify(text, type = "ok") {
  const el = $("#status");
  el.innerHTML = text ? `<p class="${type === "err" ? "err" : ""}">${esc(text)}</p>` : "";
  clearTimeout(statusTimer);
  if (text) statusTimer = setTimeout(() => (el.innerHTML = ""), 6000);
}

async function api(path, method = "GET", body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      credentials: "same-origin",
    });
  } catch (_) {
    const err = new Error("مفيش اتصال بالإنترنت. اتأكد من النت وجرّب تاني.");
    err.offline = true;
    throw err;
  }
  let data = {};
  try { data = await res.json(); } catch (_) { /* not json */ }
  if (!res.ok) {
    const err = new Error(CODE_AR[data.code] || (res.status === 429 ? CODE_AR.RATE_LIMIT : "حصل خطأ. جرّب تاني.") );
    err.status = res.status; err.data = data;
    throw err;
  }
  return data;
}

const fmtDate = (d) => new Date(d).toLocaleString("ar-EG", { dateStyle: "medium", timeStyle: "short" });

/* ---------- boot / auth ---------- */
async function boot() {
  try {
    const me = await api("/api/auth/me");
    S.user = me.user;
    await loadVocab();
    S.view = "words";
  } catch (_) { S.user = null; }
  render();
  if (S.user) {
    registerSW();
    if (location.hash === "#review") go("review");   // opened from the reminder notification
  }
}

async function loadVocab() {
  const r = await api("/api/get_vocab");
  S.vocab = r.data; S.weak = r.weak_words;
}

function authView(mode) {
  const reg = mode === "register";
  return `<section class="auth">
    <h1>${reg ? "إنشاء حساب" : "تسجيل الدخول"}</h1>
    <p class="muted">اكتب الكلمة الإنجليزية، والباقي علينا: المعنى والأمثلة والمرادفات والاختبارات.</p>
    <form id="${reg ? "register" : "login"}-form" novalidate>
      ${reg ? `<div class="field"><label for="name">الاسم</label><input id="name" type="text" autocomplete="name" required></div>` : ""}
      <div class="field"><label for="email">الإيميل</label><input id="email" type="email" dir="ltr" autocomplete="email" required></div>
      <div class="field"><label for="password">كلمة السر</label><input id="password" type="password" dir="ltr" autocomplete="${reg ? "new-password" : "current-password"}" required></div>
      <p class="form-error" id="form-error"></p>
      <button class="btn primary" type="submit">${reg ? "سجّل" : "ادخل"}</button>
    </form>
    <p class="switch muted">${reg ? "عندك حساب؟" : "لسه مسجلتش؟"} <button class="link" data-act="${reg ? "to-login" : "to-register"}">${reg ? "سجّل دخول" : "اعمل حساب"}</button></p>
  </section>`;
}

async function submitAuth(form) {
  const reg = form.id === "register-form";
  const body = { email: $("#email", form).value.trim(), password: $("#password", form).value };
  if (reg) body.name = $("#name", form).value.trim();
  const errEl = $("#form-error", form), btn = $("button[type=submit]", form);
  errEl.textContent = ""; btn.disabled = true;
  try {
    await api(reg ? "/api/auth/register" : "/api/auth/log_in", "POST", body);
    await boot();
  } catch (e) {
    const m = e.data?.message || "";
    errEl.textContent =
      e.status === 429 ? "محاولات كتير. استنى شوية وجرّب تاني."
      : e.status === 401 ? "الإيميل أو كلمة السر غلط."
      : /already/i.test(m) ? "الإيميل ده متسجل قبل كده."
      : e.status === 400 ? "راجع البيانات: كلمة السر من 8 لـ 128 حرف والإيميل صحيح."
      : "حصل خطأ. جرّب تاني.";
    btn.disabled = false;
  }
}

/* ---------- words ---------- */
function gallery(w) {
  const imgs = w.images?.length ? w.images : (w.image ? [w.image] : []);
  const pics = imgs.map((u) => `<img src="${esc(u)}" alt="صورة توضح ${esc(w.word)}" loading="lazy" referrerpolicy="no-referrer">`).join("");
  const more = imgs.length < 3 ? `<button class="link" data-img="${esc(w._id)}">${imgs.length ? "دوّر على صور أكتر" : "دوّر على صور"}</button>` : "";
  return pics || more ? `<div class="pics">${pics}${more}</div>` : "";
}

function wordCard(w) {
  const rel = (label, arr, cls) => arr?.length
    ? `<div class="rel"><span class="lbl">${label}</span>${arr.map((x) => `<span class="chip ${cls}">${esc(x)}</span>`).join("")}</div>` : "";
  return `<article class="word-card ${w.is_weak ? "is-weak" : ""}">
    <div class="wc-head">
      <h3 class="wc-word en">${esc(w.word)}</h3>
      ${w.part_of_speech ? `<span class="pos">${esc(w.part_of_speech)}</span>` : ""}
      ${w.is_weak ? `<span class="tag-weak">نقطة ضعف</span>` : ""}
      <button class="del" data-del="${esc(w._id)}" aria-label="حذف كلمة ${esc(w.word)}">حذف</button>
    </div>
    ${w.meaning_ar ? `<p class="mean-ar">${esc(w.meaning_ar)}</p>` : ""}
    ${gallery(w)}
    <p class="mean-en en">${esc(w.meaning)}</p>
    <p class="ex en">${esc(w.example)}</p>
    ${rel("مرادفات", w.synonyms, "")}${rel("عكسها", w.antonyms, "opp")}
    <p class="cat">${esc(w.category)}</p>
  </article>`;
}

function wordList() {
  const q = S.q.trim().toLowerCase();
  const list = S.vocab.filter((w) => !q || w.word.toLowerCase().includes(q) || (w.meaning_ar || "").includes(q));
  if (!S.vocab.length) return `<div class="empty"><p><b>لسه مضفتش كلمات.</b></p><p class="muted">اكتب أول كلمة فوق وهنجهزلك بطاقتها.</p></div>`;
  if (!list.length) return `<p class="muted">مفيش كلمة بالاسم ده.</p>`;
  return list.map(wordCard).join("");
}

function wordsView() {
  const weakCount = S.vocab.filter((w) => w.is_weak).length;
  return `<h1 class="page-title">كلماتي</h1>
    <form id="add-form" class="add">
      <input id="word" type="text" dir="ltr" placeholder="اكتب كلمة إنجليزية، مثلاً: reluctant" value="${esc(S.draft)}" autocomplete="off" autocapitalize="none" spellcheck="false" aria-label="الكلمة">
      <button class="btn primary" type="submit">أضف الكلمة</button>
    </form>
    <p class="hint">بنجهّز المعنى والأمثلة والمرادفات والعكس تلقائيًا.</p>
    <div class="toolbar">
      <p class="muted">${S.vocab.length} كلمة${weakCount ? `، منها ${weakCount} نقطة ضعف` : ""}</p>
      ${S.vocab.length > 3 ? `<input id="search" type="text" placeholder="ابحث في كلماتك" value="${esc(S.q)}" aria-label="بحث">` : ""}
    </div>
    <div class="list" id="list">${wordList()}</div>`;
}

async function addWord(form) {
  const input = $("#word", form), btn = $("button", form);
  const word = input.value.trim();
  if (!word) return notify("اكتب الكلمة الأول.", "err");
  btn.disabled = input.disabled = true; btn.textContent = "بنجهّز البطاقة…";
  try {
    const r = await api("/api/add_vocab", "POST", { word });
    S.vocab.unshift(r.data); S.draft = "";
    notify(r.images_ok ? `اتضافت الكلمة: ${r.data.word}` : `اتضافت ${r.data.word} بس مالقيناش 3 صور. تقدر تدوّر تاني من البطاقة.`);
    render();
    $("#word")?.focus();
  } catch (e) {
    notify(e.message, "err");
    btn.disabled = input.disabled = false; btn.textContent = "أضف الكلمة";
  }
}

async function refreshImages(id, btn) {
  btn.disabled = true; btn.textContent = "بندوّر…";
  try {
    const r = await api("/api/vocab_images", "POST", { vocab_id: id });
    const w = S.vocab.find((v) => v._id === id);
    if (w) { w.images = r.data.images; w.image = r.data.images[0]; }
    if (!r.images_ok) notify("لقينا أقل من 3 صور للكلمة دي.", "err");
    render();
  } catch (e) { notify(e.message, "err"); btn.disabled = false; btn.textContent = "دوّر على صور"; }
}

async function deleteWord(id) {
  const w = S.vocab.find((v) => v._id === id);
  if (!w || !confirm(`تحذف كلمة "${w.word}"؟`)) return;
  try {
    await api(`/api/DEL_vocab?vocab_id=${encodeURIComponent(id)}`, "DELETE");
    S.vocab = S.vocab.filter((v) => v._id !== id);
    render();
  } catch (e) { notify(e.message, "err"); }
}

/* ---------- test setup ---------- */
function testSetupView() {
  const { mode, count, words } = S.setup;
  const weakN = S.vocab.filter((w) => w.is_weak).length;
  if (!S.vocab.length) return `<h1 class="page-title">اختبار</h1><div class="empty"><p><b>محتاج كلمات الأول.</b></p><button class="btn primary" data-view="words">ضيف كلمات</button></div>`;
  const opt = (v, title, desc, disabled = false) => `<label class="mode"><input type="radio" name="mode" value="${v}" ${mode === v ? "checked" : ""} ${disabled ? "disabled" : ""}><div><b>${title}</b><span>${desc}</span></div></label>`;
  return `<h1 class="page-title">اختبار جديد</h1>
    <form id="test-form" class="panel">
      <div class="modes" role="radiogroup" aria-label="نوع الاختبار">
        ${opt("weak", "نقاط ضعفي", weakN ? `${weakN} كلمة غلطت فيها قبل كده` : "لسه مفيش. هتظهر بعد أول غلطة", !weakN)}
        ${opt("all", "كل كلماتي", "عينة عشوائية من كل الكلمات اللي ضفتها")}
        ${opt("words", "كلمات أختارها", "اختار الكلمات اللي عايز تتختبر فيها")}
      </div>
      ${mode === "words" ? `<div class="pick" aria-label="اختار الكلمات">${S.vocab.map((w) => `<label><input type="checkbox" name="pick" value="${esc(w.word)}" ${words.has(w.word) ? "checked" : ""}>${esc(w.word)}</label>`).join("")}</div>` : ""}
      ${mode !== "words" ? `<div class="field"><label for="count">عدد الكلمات</label><select id="count">${[5, 10, 15, 20, 30].map((n) => `<option value="${n}" ${n === count ? "selected" : ""}>${n}</option>`).join("")}</select></div>` : ""}
      <button class="btn primary" type="submit">ابدأ الاختبار</button>
    </form>`;
}

async function startTest(form) {
  const btn = $("button[type=submit]", form);
  const body = { mode: S.setup.mode, count: S.setup.count };
  if (S.setup.mode === "words") {
    body.words = [...S.setup.words];
    if (!body.words.length) return notify("اختار كلمة واحدة على الأقل.", "err");
  }
  btn.disabled = true; btn.textContent = "الذكاء الاصطناعي بيكتب الأسئلة…";
  try {
    const r = await api("/api/test", "POST", body);
    beginTest(r.data);
  } catch (e) {
    notify(e.message, "err");
    btn.disabled = false; btn.textContent = "ابدأ الاختبار";
  }
}

function beginTest(t) {
  S.test = t; S.idx = 0; S.answers = {}; S.result = null; S.view = "taking";
  render(); window.scrollTo(0, 0);
}

/* ---------- taking a test ---------- */
function takingView() {
  const t = S.test, q = t.questions[S.idx], last = S.idx === t.questions.length - 1;
  const sel = S.answers[q.id];
  const body = q.input === "choice"
    ? `<div class="opts">${q.options.map((o, i) => `<button type="button" class="opt" data-opt="${i}" aria-pressed="${sel === o}"><span class="k">${"ABCD"[i]}</span><span>${esc(o)}</span></button>`).join("")}</div>`
    : `<input id="typed" type="text" dir="ltr" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="اكتب إجابتك" value="${esc(sel || "")}" aria-label="إجابتك">`;
  return `<div class="prog" aria-hidden="true">${t.questions.map((x, i) => `<i class="${i === S.idx ? "cur" : S.answers[x.id] ? "done" : ""}"></i>`).join("")}</div>
    <div class="qmeta"><span>${KIND_AR[q.kind] || ""}</span><span>سؤال ${S.idx + 1} من ${t.questions.length}</span></div>
    <section class="q"><p class="q-prompt">${esc(q.prompt)}</p>${body}</section>
    <div class="nav-row">
      <button class="btn" data-act="prev" ${S.idx === 0 ? "disabled" : ""}>السابق</button>
      ${last ? `<button class="btn primary" data-act="submit">سلّم الاختبار</button>` : `<button class="btn primary" data-act="next">التالي</button>`}
    </div>`;
}

async function submitTest() {
  const t = S.test;
  const blank = t.questions.filter((q) => !S.answers[q.id]).length;
  if (blank && !confirm(`فيه ${blank} سؤال من غير إجابة وهيتحسبوا غلط. تسلّم؟`)) return;
  const btn = $("[data-act=submit]"); if (btn) btn.disabled = true;
  try {
    const r = await api("/api/test/answers", "POST", {
      test_id: t.id,
      answers: t.questions.map((q) => ({ question_id: q.id, selected: S.answers[q.id] ?? "" })),
    });
    S.result = r.data; S.view = "result";
    await loadVocab().catch(() => {});
    render(); window.scrollTo(0, 0);
  } catch (e) { notify(e.message, "err"); if (btn) btn.disabled = false; }
}

/* ---------- result ---------- */
function resultView() {
  const r = S.result;
  const items = r.results.map((x, i) => `<article class="rv ${x.is_correct ? "ok" : "no"}">
      <div class="rv-top"><span>${i + 1}. ${KIND_AR[x.kind] || ""}</span><span class="verdict ${x.is_correct ? "ok" : "no"}">${x.is_correct ? "✓ صح" : "✗ غلط"}</span></div>
      <p class="q-prompt">${esc(x.prompt)}</p>
      <div class="ans">
        <p class="you ${x.is_correct ? "" : "no"}">إجابتك: ${x.selected ? esc(x.selected) : "(مفيش إجابة)"}</p>
        ${x.is_correct ? "" : `<p class="right">الإجابة الصحيحة: ${esc(x.correct_answer)}</p>`}
      </div>
      ${x.explanation ? `<p class="expl">${esc(x.explanation)}</p>` : ""}
    </article>`).join("");
  const nw = r.new_weak_words || [];
  const weakN = S.vocab.filter((w) => w.is_weak).length;
  return `<h1 class="page-title">النتيجة</h1>
    <div class="panel"><div class="score"><b>${r.score}/${r.total}</b><span>${r.percentage}%</span></div>
      ${nw.length ? `<p class="newweak">اتضافت لنقاط ضعفك: <span class="en" style="display:inline">${nw.map(esc).join("، ")}</span></p>` : ""}
    </div>
    <div class="actions">
      ${weakN ? `<button class="btn primary" data-act="retry-weak">اختبار على نقاط ضعفي (${weakN})</button>` : ""}
      <button class="btn" data-view="test">اختبار جديد</button>
      <button class="btn" data-view="history">السجل</button>
    </div>
    <div class="list">${items}</div>`;
}

/* ---------- history ---------- */
function historyView() {
  const h = S.history;
  if (!h) return `<h1 class="page-title">السجل</h1><p class="muted">جاري التحميل…</p>`;
  if (!h.length) return `<h1 class="page-title">السجل</h1><div class="empty"><p class="muted">لسه معملتش أي اختبار.</p></div>`;
  return `<h1 class="page-title">السجل</h1><div class="list">${h.map((t) => `<button class="h-item" data-open="${esc(t.id)}">
      <span><b>${MODE_AR[t.mode] || t.mode}</b><small>${fmtDate(t.created_at)}</small></span>
      <span class="h-score">${t.status === "submitted" ? `${t.score}/${t.total}` : "مكمّلش"}</span></button>`).join("")}</div>`;
}

async function openTest(id) {
  try {
    const r = await api(`/api/test/${encodeURIComponent(id)}`);
    if (r.data.status === "submitted") { S.result = r.data.result; S.view = "result"; render(); window.scrollTo(0, 0); }
    else beginTest(r.data);
  } catch (e) { notify(e.message, "err"); }
}

/* ---------- review (FSRS) ---------- */
const RATE_AR = { Again: "نسيتها", Hard: "بصعوبة", Good: "تذكرتها", Easy: "سهلة جدًا" };
const RATINGS = ["Again", "Hard", "Good", "Easy"];
const userTZ = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch (_) { return "UTC"; } };
const newReqId = () => (crypto.randomUUID ? crypto.randomUUID() : `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`);
const netMsg = (e) => (e.offline ? e.message : e.message || "حصل خطأ. جرّب تاني.");

function registerSW() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
}

function pushSupported() {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

async function loadReviewHome() {
  const R = S.rv;
  R.loading = true; R.error = "";
  if (S.view === "review") render();
  try {
    const [sum, rem] = await Promise.all([
      api(`/api/review/summary?tz=${encodeURIComponent(userTZ())}`),
      api("/api/reminders/settings"),
    ]);
    R.summary = sum.data; R.remind = rem.data;
  } catch (e) { R.error = netMsg(e); }
  R.loading = false;
  if (S.view === "review") render();
}

function reminderStatus() {
  const m = S.rv.remind;
  if (!pushSupported()) return ["المتصفح ده مش بيدعم الإشعارات.", "bad"];
  if (!m) return ["", ""];
  if (!m.push_configured) return ["الإشعارات مش متظبطة على السيرفر (VAPID). المراجعة نفسها شغالة عادي.", "bad"];
  if (Notification.permission === "denied") return ["الإذن مرفوض. فعّله من إعدادات المتصفح للموقع ده وبعدين جرّب تاني.", "bad"];
  if (m.enabled && m.subscriptions > 0) return [`التذكير شغّال كل يوم الساعة ${m.time} (${m.timezone}).`, "ok"];
  if (Notification.permission === "default") return ["التذكير مقفول. هنطلب إذن الإشعارات لما تضغط «شغّل التذكير».", ""];
  return ["التذكير مقفول.", ""];
}

function reviewHomeView() {
  const R = S.rv, s = R.summary;
  if (R.loading && !s) return `<h1 class="page-title">المراجعة</h1><p class="muted">جاري التحميل…</p>`;
  if (R.error && !s) return `<h1 class="page-title">المراجعة</h1><div class="empty"><p>${esc(R.error)}</p><button class="btn primary" data-act="rv-retry">جرّب تاني</button></div>`;
  if (!s) return `<h1 class="page-title">المراجعة</h1>`;
  const ready = s.due_now + s.new_available;
  const week = s.last_7_days;
  const nextTxt = s.next_due ? `أقرب مراجعة جاية: ${fmtDate(s.next_due)}` : "";
  const start = !s.total_words
    ? `<p class="muted">لسه مضفتش كلمات.</p><button class="btn primary" data-view="words">ضيف كلمات</button>`
    : ready
      ? `<button class="btn primary big" data-act="rv-start" ${R.loading ? "disabled" : ""}>ابدأ المراجعة (${ready})</button>`
      : `<p><b>مفيش كلمات مستحقة دلوقتي.</b></p><p class="muted">${esc(nextTxt || (s.new_total ? "وصلت للحد اليومي للكلمات الجديدة. ارجع بكرة." : ""))}</p>`;
  const [st, cls] = reminderStatus();
  const m = R.remind;
  const on = m && m.enabled && m.subscriptions > 0;
  return `<h1 class="page-title">مراجعة اليوم</h1>
    ${R.error ? `<p class="form-error">${esc(R.error)}</p>` : ""}
    <div class="stats">
      <div class="stat"><b>${s.due_now}</b><span>مستحقة للمراجعة</span></div>
      <div class="stat"><b>${s.new_available}</b><span>كلمات جديدة متاحة</span></div>
      <div class="stat"><b>${s.reviewed_today}</b><span>راجعتها النهارده</span></div>
    </div>
    <div class="panel rv-start">${start}
      ${week.reviews ? `<p class="muted small">آخر 7 أيام: ${week.reviews} مراجعة، نسبة التذكّر ${week.success_rate}%</p>` : ""}
    </div>
    <h2 class="sec-title">الإعدادات</h2>
    <div class="panel rv-settings">
      <div class="set-row">
        <label for="rv-limit">أقصى عدد كلمات جديدة في اليوم</label>
        <div class="inline"><input id="rv-limit" type="number" min="0" max="500" inputmode="numeric" dir="ltr" value="${s.daily_new_limit}"><button class="btn" data-act="rv-save-limit">احفظ</button></div>
      </div>
      <div class="set-row">
        <label>التذكير اليومي</label>
        <p class="remind-status ${cls}">${esc(st)}</p>
        <div class="inline">
          <input id="rm-time" type="time" dir="ltr" value="${esc(m ? m.time : "20:00")}" aria-label="وقت التذكير">
          ${on
            ? `<button class="btn" data-act="rv-save-time" ${R.pushBusy ? "disabled" : ""}>احفظ الوقت</button><button class="btn" data-act="rv-push-off" ${R.pushBusy ? "disabled" : ""}>أوقف التذكير</button>`
            : `<button class="btn primary" data-act="rv-push-on" ${R.pushBusy || !pushSupported() || (m && !m.push_configured) ? "disabled" : ""}>شغّل التذكير</button>`}
        </div>
        <p class="muted small">المنطقة الزمنية: <span class="en" style="display:inline">${esc(userTZ())}</span>. الإشعار بيوصل لو المتصفح بيدعمه وانت وافقت عليه، والسيرفر شغّال.</p>
      </div>
    </div>`;
}

async function startReview() {
  const R = S.rv;
  R.loading = true; R.error = ""; render();
  try {
    const r = await api(`/api/review/due?tz=${encodeURIComponent(userTZ())}`);
    R.loading = false;
    R.stats = { n: 0, Again: 0, Hard: 0, Good: 0, Easy: 0 };
    if (!r.data.cards.length) { R.error = ""; await loadReviewHome(); return notify("مفيش بطاقات مستحقة دلوقتي."); }
    R.queue = r.data.cards; R.i = 0; R.total = r.data.cards.length; R.shown = false; R.busy = false; R.reqId = newReqId();
    S.view = "reviewing"; render(); window.scrollTo(0, 0);
  } catch (e) {
    R.loading = false; R.error = netMsg(e); render();
  }
}

function reviewingView() {
  const R = S.rv, c = R.queue[R.i];
  if (!c) return `<p class="muted">جاري التحميل…</p>`;
  const pct = Math.round((R.i / R.total) * 100);
  const imgs = (c.images && c.images.length ? c.images : c.image ? [c.image] : [])
    .map((u) => `<img src="${esc(u)}" alt="صورة توضح ${esc(c.word)}" loading="lazy" referrerpolicy="no-referrer">`).join("");
  const rel = (label, arr, cls) => arr && arr.length
    ? `<div class="rel"><span class="lbl">${label}</span>${arr.map((x) => `<span class="chip ${cls}">${esc(x)}</span>`).join("")}</div>` : "";
  const exs = (c.examples && c.examples.length ? c.examples : [c.example]).filter(Boolean).slice(0, 3);
  const answer = `<div class="rc-answer">
      ${c.meaning_ar ? `<p class="mean-ar">${esc(c.meaning_ar)}</p>` : ""}
      ${imgs ? `<div class="pics">${imgs}</div>` : ""}
      <p class="mean-en en">${esc(c.meaning)}</p>
      ${exs.map((x) => `<p class="ex en">${esc(x)}</p>`).join("")}
      ${rel("مرادفات", c.synonyms, "")}${rel("عكسها", c.antonyms, "opp")}
      ${c.category ? `<p class="cat">${esc(c.category)}</p>` : ""}
    </div>`;
  const rates = `<div class="rate-row" role="group" aria-label="قيّم تذكّرك للكلمة">${RATINGS.map((n, k) =>
    `<button class="rate r-${n.toLowerCase()}" data-rate="${n}" ${R.busy ? "disabled" : ""}><b>${n}</b><span>${RATE_AR[n]}</span><em>${esc(c.preview[n].label)}</em><kbd aria-hidden="true">${k + 1}</kbd></button>`).join("")}</div>`;
  return `<div class="rv-bar" role="progressbar" aria-valuemin="0" aria-valuemax="${R.total}" aria-valuenow="${R.i}"><i style="width:${pct}%"></i></div>
    <div class="qmeta"><span>${c.is_new ? "كلمة جديدة" : "مراجعة"}</span><span>بطاقة ${R.i + 1} من ${R.total}</span></div>
    <section class="rcard">
      <div class="rc-face"><h2 class="rc-word en">${esc(c.word)}</h2>${c.part_of_speech ? `<span class="pos">${esc(c.part_of_speech)}</span>` : ""}</div>
      ${R.shown ? answer : `<button class="btn primary big" data-act="rv-show">إظهار الإجابة</button><p class="muted small">أو اضغط Space</p>`}
    </section>
    ${R.shown ? rates : ""}
    <div class="nav-row"><button class="link" data-act="rv-quit">إنهاء الجلسة</button></div>`;
}

function showAnswer() {
  if (S.view !== "reviewing" || S.rv.shown) return;
  S.rv.shown = true; render();
}

async function rateCurrent(rating) {
  const R = S.rv, c = R.queue[R.i];
  if (S.view !== "reviewing" || !R.shown || R.busy || !c || !RATINGS.includes(rating)) return;
  R.busy = true; render();
  try {
    // The same request_id is reused when this press is retried, so it can never be saved twice.
    await api(`/api/review/${encodeURIComponent(c._id)}/rate`, "POST", { rating, request_id: R.reqId });
    R.stats.n++; R.stats[rating]++;
    await nextCard();
  } catch (e) {
    R.busy = false;
    if (e.status === 409 || e.status === 404) { notify(e.message, "err"); await nextCard(true); }   // card changed elsewhere: skip it
    else { notify(netMsg(e), "err"); render(); }                                                  // stay on the card, nothing was saved
  }
}

async function nextCard(skipped) {
  const R = S.rv;
  R.busy = false; R.shown = false; R.reqId = newReqId();
  if (R.i + 1 < R.queue.length) { R.i++; render(); window.scrollTo(0, 0); return; }
  // Queue finished: learning cards (e.g. "Again" after 1 minute) may be due again already.
  try {
    const r = await api(`/api/review/due?tz=${encodeURIComponent(userTZ())}`);
    const seen = new Set();
    const more = r.data.cards.filter((x) => !seen.has(x._id) && seen.add(x._id));
    if (more.length && more.some((x) => !x.is_new)) {
      R.queue = more; R.i = 0; R.total += more.length; render(); return;
    }
  } catch (_) { /* finish normally */ }
  await finishReview();
}

async function finishReview() {
  S.view = "reviewdone"; S.rv.summary = null; render(); window.scrollTo(0, 0);
  try { S.rv.summary = (await api(`/api/review/summary?tz=${encodeURIComponent(userTZ())}`)).data; } catch (_) { /* optional */ }
  if (S.view === "reviewdone") render();
}

function reviewDoneView() {
  const R = S.rv, st = R.stats || { n: 0, Again: 0, Hard: 0, Good: 0, Easy: 0 }, s = R.summary;
  const rate = st.n ? Math.round(((st.n - st.Again) / st.n) * 100) : null;
  return `<h1 class="page-title">${st.n ? "خلّصت مراجعة النهارده" : "الجلسة اتقفلت"}</h1>
    <div class="panel">
      <div class="score"><b>${st.n}</b><span>بطاقة اتراجعت${rate !== null ? ` · نسبة التذكّر ${rate}%` : ""}</span></div>
      <div class="stats small-stats">${RATINGS.map((n) => `<div class="stat r-${n.toLowerCase()}"><b>${st[n]}</b><span>${n}</span></div>`).join("")}</div>
      ${s ? `<p class="muted">${s.due_now ? `لسه فيه ${s.due_now} بطاقة مستحقة.` : "مفيش بطاقات مستحقة دلوقتي."}${s.next_due ? ` أقرب مراجعة جاية: ${fmtDate(s.next_due)}.` : ""}</p>` : ""}
    </div>
    <div class="actions">
      <button class="btn primary" data-view="review">رجوع للمراجعة</button>
      <button class="btn" data-view="words">كلماتي</button>
    </div>`;
}

function quitReview() {
  if (S.rv.stats && S.rv.stats.n) return finishReview();
  go("review");
}

async function saveLimit() {
  const input = $("#rv-limit"), n = Number(input.value);
  if (!Number.isInteger(n) || n < 0 || n > 500) return notify(CODE_AR.INVALID_LIMIT, "err");
  try {
    await api("/api/review/settings", "PUT", { daily_new_limit: n });
    notify("اتحفظ الحد اليومي.");
    await loadReviewHome();
  } catch (e) { notify(netMsg(e), "err"); }
}

const keyToBytes = (b64) => {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (ch) => ch.charCodeAt(0));
};
const sameKey = (buf, bytes) => {
  if (!buf) return false;
  const a = new Uint8Array(buf);
  return a.length === bytes.length && a.every((v, i) => v === bytes[i]);
};

async function enablePush() {
  const R = S.rv;
  if (!pushSupported()) return notify("المتصفح ده مش بيدعم الإشعارات.", "err");
  const time = $("#rm-time").value || "20:00";
  R.pushBusy = true; render();
  try {
    const key = R.remind && R.remind.vapid_public_key;
    if (!key) throw new Error(CODE_AR.PUSH_NOT_CONFIGURED);
    const perm = await Notification.requestPermission();               // only after the user pressed the button
    if (perm !== "granted") throw new Error("من غير إذن الإشعارات مش هنقدر نفكّرك. تقدر توافق من إعدادات المتصفح.");
    const reg = await navigator.serviceWorker.register("/sw.js");
    await navigator.serviceWorker.ready;
    const bytes = keyToBytes(key);
    let sub = await reg.pushManager.getSubscription();
    if (sub && !sameKey(sub.options && sub.options.applicationServerKey, bytes)) { await sub.unsubscribe(); sub = null; }
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes });
    await api("/api/reminders/subscribe", "POST", { subscription: sub.toJSON(), timezone: userTZ() });
    await api("/api/reminders/settings", "PUT", { enabled: true, time, timezone: userTZ() });
    notify("التذكير اليومي اشتغل.");
  } catch (e) { notify(netMsg(e), "err"); }
  R.pushBusy = false;
  await loadReviewHome();
}

async function disablePush() {
  const R = S.rv;
  R.pushBusy = true; render();
  try {
    await api("/api/reminders/settings", "PUT", { enabled: false });
    if (pushSupported()) {
      const reg = await navigator.serviceWorker.getRegistration("/sw.js");
      const sub = reg && (await reg.pushManager.getSubscription());
      if (sub) { await api("/api/reminders/unsubscribe", "POST", { endpoint: sub.endpoint }).catch(() => {}); await sub.unsubscribe().catch(() => {}); }
    }
    notify("اتوقف التذكير.");
  } catch (e) { notify(netMsg(e), "err"); }
  R.pushBusy = false;
  await loadReviewHome();
}

async function saveReminderTime() {
  const time = $("#rm-time").value;
  try {
    await api("/api/reminders/settings", "PUT", { time, timezone: userTZ() });
    notify("اتحفظ وقت التذكير.");
    await loadReviewHome();
  } catch (e) { notify(netMsg(e), "err"); }
}

/* ---------- shell ---------- */
const TABS = [["words", "كلماتي"], ["review", "المراجعة"], ["test", "اختبار"], ["history", "السجل"]];

function go(view) {
  S.view = view;
  if (view !== "review" && location.hash === "#review") history.replaceState(null, "", location.pathname + location.search);
  if (view === "review") loadReviewHome();
  if (view === "history") { S.history = null; api("/api/tests").then((r) => { S.history = r.data; if (S.view === "history") render(); }).catch((e) => notify(e.message, "err")); }
  render();
}

function render() {
  const bar = $("#bar"), app = $("#app");
  bar.hidden = !S.user;
  if (!S.user) { app.innerHTML = authView(S.authMode); return; }
  $("#who").textContent = S.user.name;
  const active = S.view === "taking" || S.view === "result" ? "test" : S.view === "reviewing" || S.view === "reviewdone" ? "review" : S.view;
  $("#nav").innerHTML = TABS.map(([v, l]) => `<button data-view="${v}" ${active === v ? 'aria-current="page"' : ""}>${l}</button>`).join("");
  app.innerHTML = { words: wordsView, review: reviewHomeView, reviewing: reviewingView, reviewdone: reviewDoneView, test: testSetupView, taking: takingView, result: resultView, history: historyView }[S.view]();
}

/* ---------- events ---------- */
document.addEventListener("click", async (e) => {
  const t = e.target.closest("button"); if (!t) return;
  if (t.dataset.view) return go(t.dataset.view);
  if (t.dataset.del) return deleteWord(t.dataset.del);
  if (t.dataset.img) return refreshImages(t.dataset.img, t);
  if (t.dataset.open) return openTest(t.dataset.open);
  if (t.dataset.rate) return rateCurrent(t.dataset.rate);
  if (t.dataset.opt !== undefined) {
    const q = S.test.questions[S.idx]; S.answers[q.id] = q.options[+t.dataset.opt]; return render();
  }
  switch (t.dataset.act) {
    case "to-register": S.authMode = "register"; return render();
    case "to-login": S.authMode = "login"; return render();
    case "logout": await api("/api/auth/log_out", "POST").catch(() => {}); S.user = null; S.authMode = "login"; return render();
    case "prev": S.idx--; return render();
    case "next": S.idx++; return render();
    case "submit": return submitTest();
    case "rv-start": return startReview();
    case "rv-show": return showAnswer();
    case "rv-quit": return quitReview();
    case "rv-retry": return loadReviewHome();
    case "rv-save-limit": return saveLimit();
    case "rv-push-on": return enablePush();
    case "rv-push-off": return disablePush();
    case "rv-save-time": return saveReminderTime();
    case "retry-weak": S.setup.mode = "weak"; S.view = "test"; return startTest(Object.assign(document.createElement("form"), { innerHTML: "<button type=submit></button>" }));
  }
});

// A picture that fails to load is simply removed.
document.addEventListener("error", (e) => { if (e.target.tagName === "IMG") e.target.remove(); }, true);

document.addEventListener("submit", (e) => {
  e.preventDefault();
  const f = e.target;
  if (f.id === "login-form" || f.id === "register-form") submitAuth(f);
  else if (f.id === "add-form") addWord(f);
  else if (f.id === "test-form") startTest(f);
});

document.addEventListener("input", (e) => {
  const t = e.target;
  if (t.id === "word") S.draft = t.value;
  else if (t.id === "search") { S.q = t.value; $("#list").innerHTML = wordList(); }
  else if (t.id === "typed") { S.answers[S.test.questions[S.idx].id] = t.value; }
});

document.addEventListener("change", (e) => {
  const t = e.target;
  if (t.name === "mode") { S.setup.mode = t.value; render(); }
  else if (t.id === "count") S.setup.count = +t.value;
  else if (t.name === "pick") { t.checked ? S.setup.words.add(t.value) : S.setup.words.delete(t.value); }
});

// Keyboard shortcuts inside a review session: Space / Enter = show answer, 1-4 = Again / Hard / Good / Easy.
document.addEventListener("keydown", (e) => {
  if (S.view !== "reviewing" || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.target.closest && e.target.closest("input, select, textarea")) return;
  if (e.key === " " || e.key === "Enter") {
    if (!S.rv.shown && !(e.target.closest && e.target.closest("button"))) { e.preventDefault(); showAnswer(); }
  } else if (S.rv.shown && "1234".includes(e.key) && e.key.length === 1) {
    rateCurrent(RATINGS[+e.key - 1]);
  }
});

// A click on the reminder notification: open the review tab in an already open page.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("message", (e) => {
    if (e.data && e.data.type === "open-review" && S.user && S.view !== "reviewing") go("review");
  });
}
window.addEventListener("hashchange", () => { if (location.hash === "#review" && S.user && S.view !== "reviewing") go("review"); });

S.authMode = "login";
boot();