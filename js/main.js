/* ================================================================
 * THU 选课社区 - Pages 静态托管
 *
 * 架构:
 *   Cloudflare Pages 托管 HTML/CSS/JS + JSON 数据
 *
 * 加载策略:
 *   首页:      manifest + views_summary + reviews_latest  (~365 KB)
 *   课程详情:  sqid → data/courses/{sqid}.json + tid → data/teachers/{tid}.json
 *   课程列表:  manifest + views_summary + course_index + 5 course chunks (~5.6 MB)
 *   搜索:      with_comment_index.json（仅有点评）或 full_index.json（全部课程）
 *              → 结果链接到 course.html?sqid=X&tid=Y
 *   统计:      manifest + views_summary                   (~43 KB)
 * ================================================================ */

// API 地址（部署后替换为实际地址）
const API_BASE = `http://api.yourschool.cc.cd`;

// Pages 本地 JSON 路径
const STATIC_BASE = "data/optimized/";
const RAW_BASE = "data/";

const CACHE_PREFIX = "thu_v4_";
const CACHE_TTL = 30 * 60 * 1000;

// ========== Global State ==========
let manifest = null;
let courseIdx = {}; // {cid: [dept, teacher, name]}  (lazy, only for courses/search)
let viewsSummary = {}; // {cid: {c, a, r}}
let latestReviews = []; // 首页用
let coursesAll = []; // 所有课程 (lazy, for courses/search page)
let courseIdxLoaded = false;
let searchIndexCache = null; // 缓存搜索用的 with_comment_index 或 full_index

// Page state
let indexState = { page: 1, size: 10 };
let courseState = { page: 1, size: 10 };
let searchState = { page: 1, size: 10 };
let detailState = { page: 1, size: 5 };
let filteredCourses = [];
let currentRaf = null;

// ========== Utils ==========
function $(id) {
  return document.getElementById(id);
}
function qs(sel) {
  return document.querySelector(sel);
}

function getCache(key) {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + key);
    if (!raw) return null;
    const { data, ts } = JSON.parse(raw);
    if (Date.now() - ts > CACHE_TTL) {
      localStorage.removeItem(CACHE_PREFIX + key);
      return null;
    }
    return data;
  } catch {
    return null;
  }
}
function setCache(key, data) {
  try {
    localStorage.setItem(
      CACHE_PREFIX + key,
      JSON.stringify({ data, ts: Date.now() }),
    );
  } catch {}
}

function getPaged(list, page, size) {
  return list.slice((page - 1) * size, page * size);
}

function getCourseName(cid) {
  const c = courseIdx[String(cid)];
  return c ? `${c[2]}（${c[1]}）` : "未知课程";
}

// ========== Init ==========
document.addEventListener("DOMContentLoaded", async () => {
  await loadManifest();
  await routePage();
});

async function loadManifest() {
  const cached = getCache("manifest");
  // 校验缓存版本：v3 必须有 detail_chunks 字段
  if (cached && cached.v === 3 && cached.detail_chunks) {
    manifest = cached;
    return;
  }
  // 缓存过期或版本不匹配 → 清除并重新加载
  try {
    const res = await fetch(STATIC_BASE + "manifest.json");
    manifest = await res.json();
    setCache("manifest", manifest);
  } catch (e) {
    console.error("Manifest load error", e);
  }
}

// 加载静态文件
async function loadStatic(key, filename, expectedType = null) {
  const cached = getCache(key);
  if (
    cached !== null &&
    cached !== undefined &&
    !(Array.isArray(cached) && cached.length === 0)
  ) {
    // 缓存存在且非空数组 → 使用缓存
    if (expectedType === "array" && !Array.isArray(cached)) {
      // 类型不匹配，清除缓存重新加载
      console.warn(`[loadStatic] Cache type mismatch for ${key}, re-fetching`);
    } else {
      return cached;
    }
  }
  try {
    const res = await fetch(STATIC_BASE + filename);
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${filename}`);
    const data = await res.json();
    setCache(key, data);
    return data;
  } catch (e) {
    console.error(`[loadStatic] Error loading ${filename}:`, e);
    // 失败时不返回 {} 以避免掩盖错误，返回 null 让调用方处理
    return expectedType === "array" ? [] : null;
  }
}

// ========== Routing ==========
async function routePage() {
  const path = location.pathname;
  if (path.endsWith("index.html") || path === "/" || path.endsWith("/"))
    await initIndexPage();
  else if (path.endsWith("courses.html")) await initCoursesPage();
  else if (path.endsWith("statistics.html")) await initStatPage();
  else if (path.endsWith("course.html")) await initCourseDetail();
  else if (path.endsWith("search.html")) await initSearchPage();
}

// ========== Pagination ==========
function renderPagination({
  containerId,
  totalItems,
  currentPage,
  pageSize,
  onPageChange,
}) {
  const container = $(containerId);
  if (!container) return;
  if (totalItems === 0) {
    container.innerHTML = "";
    return;
  }
  const totalPages = Math.ceil(totalItems / pageSize);
  if (totalPages <= 1) {
    container.innerHTML = "";
    return;
  }

  const frag = document.createDocumentFragment();
  const mkBtn = (text, cb, disabled) => {
    const b = document.createElement("button");
    b.textContent = text;
    if (disabled) b.disabled = true;
    if (cb) b.onclick = cb;
    return b;
  };

  frag.appendChild(
    mkBtn(
      "上一页",
      () => currentPage > 1 && onPageChange(currentPage - 1, pageSize),
      currentPage === 1,
    ),
  );

  const pages = [];
  pages.push(1);
  if (currentPage - 2 > 2) pages.push(-1);
  for (
    let i = Math.max(2, currentPage - 2);
    i <= Math.min(totalPages - 1, currentPage + 2);
    i++
  )
    pages.push(i);
  if (currentPage + 2 < totalPages - 1) pages.push(-1);
  if (totalPages > 1) pages.push(totalPages);

  pages.forEach((p) => {
    if (p === -1) {
      const s = document.createElement("span");
      s.className = "ellipsis";
      s.textContent = "...";
      frag.appendChild(s);
    } else {
      const b = mkBtn(String(p), () => onPageChange(p, pageSize));
      if (p === currentPage) b.className = "active";
      frag.appendChild(b);
    }
  });

  frag.appendChild(
    mkBtn(
      "下一页",
      () => currentPage < totalPages && onPageChange(currentPage + 1, pageSize),
      currentPage === totalPages,
    ),
  );

  const sel = document.createElement("select");
  [10, 20, 50].forEach((s) => {
    const o = document.createElement("option");
    o.value = s;
    o.textContent = s + "条/页";
    if (s === pageSize) o.selected = true;
    sel.appendChild(o);
  });
  sel.onchange = (e) => onPageChange(1, +e.target.value);
  frag.appendChild(sel);

  container.innerHTML = "";
  container.appendChild(frag);
}

// ==================== INDEX PAGE ====================
async function initIndexPage() {
  // v3: reviews_latest has embedded _course_name / _course_teacher
  // No need to load 2.2MB course_index for the homepage!
  const [vsRaw, rlRaw] = await Promise.all([
    loadStatic("views_summary", "views_summary.json", "object"),
    loadStatic("reviews_latest", "reviews_latest.json", "array"),
  ]);
  viewsSummary = vsRaw || {};
  latestReviews = Array.isArray(rlRaw) ? rlRaw : [];
  renderIndex();
}

function renderIndex() {
  const wrap = $("review-list");
  const totalEl = $("total-review-num");
  if (!wrap || !totalEl) return;

  // 使用实际加载的点评数量，而非全量总数（首页仅加载最新500条）
  const total = latestReviews.length;
  totalEl.textContent = manifest ? manifest.total_reviews : total;
  if (!total) {
    wrap.innerHTML = '<div class="empty-tip">暂无点评内容</div>';
    $("review-pagination").innerHTML = "";
    return;
  }

  const { page, size } = indexState;
  const paged = getPaged(latestReviews, page, size);
  const frag = document.createDocumentFragment();

  paged.forEach((item) => {
    const name = item._course_name || `课程 #${item.course.id}`;
    const teacher = item._course_teacher || "";
    const courseName = teacher ? `${name}（${teacher}）` : name;
    const card = document.createElement("div");
    card.className = "review-card";
    card.innerHTML = `<a href="course.html?sqid=${item.course.id}&name=${encodeURIComponent(name)}&teacher=${encodeURIComponent(teacher)}" class="review-course-link">${courseName}</a>
            <div class="review-rating-text">推荐指数：${item.rating}</div>
            <div class="review-comment">${item.comment || "无点评内容"}</div>
            <div class="review-meta"><span>#${item.id}</span><span>${item.modified_at || ""}</span></div>`;
    frag.appendChild(card);
  });

  wrap.innerHTML = "";
  wrap.appendChild(frag);
  renderPagination({
    containerId: "review-pagination",
    totalItems: total,
    currentPage: page,
    pageSize: size,
    onPageChange: (np, ns) => {
      indexState.page = np;
      indexState.size = ns;
      renderIndex();
    },
  });
}

// ==================== COURSES PAGE ====================
// 数据源：与搜索页一致——仅有点评时用 with_comment_index.json，否则用 full_index.json
// 仅加载当前模式对应的索引文件，不再客户端过滤 count
let fullIndexLoaded = false;
let coursesReviewOnly = false; // 当前加载的是否为仅有点评的索引

async function loadAllCourses(onlyReviewed) {
  // 如果已加载且模式匹配，直接复用
  if (coursesAll.length > 0 && coursesReviewOnly === onlyReviewed) return;

  const cacheKey = onlyReviewed ? "courses_all_comment" : "courses_all_v4";
  const cached = getCache(cacheKey);
  if (cached) {
    coursesAll = cached;
    coursesReviewOnly = onlyReviewed;
    fullIndexLoaded = true;
    return;
  }

  const filename = onlyReviewed ? "with_comment_index.json" : "full_index.json";
  try {
    const res = await fetch(RAW_BASE + filename);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const arr = [];
    for (const [key, info] of Object.entries(data.courses || {})) {
      if (!info || typeof info !== "object") continue;
      arr.push({
        kcm: info.kcm || "",
        jsm: info.jsm || "",
        kkdw: info.kkdw || "",
        count: info.count || 0,
        avg: info.avg || 0,
        sqid: info.sqid,
        tid: info.tid,
      });
    }
    coursesAll = arr;
    coursesReviewOnly = onlyReviewed;
    fullIndexLoaded = true;
    setCache(cacheKey, coursesAll);
  } catch (e) {
    console.error("[loadAllCourses] Error loading " + filename + ":", e);
    coursesAll = [];
    coursesReviewOnly = onlyReviewed;
    fullIndexLoaded = true;
  }
}

function getDeptStats() {
  const stats = {};
  for (const c of coursesAll) {
    const d = c.kkdw || "未知院系";
    if (!stats[d]) stats[d] = { count: 0, reviewed: 0 };
    stats[d].count++;
    if (c.count > 0) stats[d].reviewed++;
  }
  return stats;
}

function populateDeptFilter() {
  const container = $("filter-dept");
  if (!container) return;
  const stats = getDeptStats();
  const sorted = Object.entries(stats).sort((a, b) => b[1].count - a[1].count);
  const frag = document.createDocumentFragment();
  sorted.forEach(([dept, info]) => {
    const l = document.createElement("label");
    l.className = "filter-option";
    l.innerHTML = `<input type="checkbox" value="${dept}" class="dept-check"><span class="filter-option-label">${dept}</span><span class="filter-option-count">${info.count}</span>`;
    frag.appendChild(l);
  });
  container.innerHTML = "";
  container.appendChild(frag);
}

function toggleFilterGroup(el) {
  const t = $(el.dataset.target);
  const a = el.querySelector(".arrow");
  if (t) {
    t.classList.toggle("show");
    a.classList.toggle("open");
  }
}

async function initCoursesPage() {
  const onlyReviewed = $("filter-has-reviews")?.checked || false;
  await loadAllCourses(onlyReviewed);
  populateDeptFilter();
  filteredCourses = [...coursesAll];
  renderCourseList();
}

async function applyFilters() {
  const onlyReviewed = $("filter-has-reviews")?.checked || false;

  // 仅有点评开关状态变化 → 清空缓存以切换索引文件
  const modeChanged = onlyReviewed !== coursesReviewOnly;
  if (modeChanged) {
    coursesAll = [];
  }
  await loadAllCourses(onlyReviewed);

  // 模式变化时需重建院系列表，但先保存已选中的院系
  let savedDepts = [];
  if (modeChanged) {
    savedDepts = Array.from(
      document.querySelectorAll(".dept-check:checked"),
    ).map((cb) => cb.value);
    populateDeptFilter();
    // 恢复之前选中的院系
    document.querySelectorAll(".dept-check").forEach((cb) => {
      if (savedDepts.includes(cb.value)) cb.checked = true;
    });
  }

  // 读取当前选中的院系进行筛选
  const checkedDepts = Array.from(
    document.querySelectorAll(".dept-check:checked"),
  ).map((cb) => cb.value);
  let result = [...coursesAll];
  if (checkedDepts.length > 0) {
    const s = new Set(checkedDepts);
    result = result.filter((c) => s.has(c.kkdw));
  }
  filteredCourses = result;
  courseState.page = 1;
  renderCourseList();
}

function renderCourseList() {
  const wrap = $("all-course-list");
  const totalEl = $("all-course-num");
  if (!wrap || !totalEl) return;
  const total = filteredCourses.length;
  totalEl.textContent = total;
  if (!total) {
    wrap.innerHTML = '<div class="empty-tip">暂无匹配课程</div>';
    $("course-pagination").innerHTML = "";
    return;
  }

  const { page, size } = courseState;
  const paged = getPaged(filteredCourses, page, size);
  const frag = document.createDocumentFragment();

  paged.forEach((c) => {
    const count = c.count || 0;
    const div = document.createElement("div");
    div.className = "course-list-item";
    div.innerHTML = `<div class="course-info"><h3><a href="course.html?sqid=${c.sqid}&tid=${c.tid}&name=${encodeURIComponent(c.kcm)}&teacher=${encodeURIComponent(c.jsm)}&dept=${encodeURIComponent(c.kkdw)}">${c.kcm}<span style="font-weight:400;color:#8a4abf;margin-left:4px;">（${c.jsm}）</span></a></h3><div class="course-dept-name">${c.kkdw}</div></div><div class="course-review-status">${count === 0 ? "暂无点评" : count + "条点评"}</div>`;
    frag.appendChild(div);
  });

  wrap.innerHTML = "";
  wrap.appendChild(frag);
  renderPagination({
    containerId: "course-pagination",
    totalItems: total,
    currentPage: page,
    pageSize: size,
    onPageChange: (np, ns) => {
      courseState.page = np;
      courseState.size = ns;
      renderCourseList();
    },
  });
}

// ==================== COURSE DETAIL ====================
// 新架构：通过 sqid 加载 data/courses/{sqid}.json，通过 tid 加载 data/teachers/{tid}.json
let currentCourseDetail = null;

async function initCourseDetail() {
  const params = new URLSearchParams(location.search);
  const sqid = params.get("sqid");
  const tid = params.get("tid");

  if (!sqid) {
    qs(".container").innerHTML = '<div class="empty-tip">缺少课程参数</div>';
    return;
  }

  let courseData = null;
  let teacherData = null;
  let courseName = "",
    teacherName = "",
    deptName = "";

  // 1. 加载课程数据
  try {
    const cacheKey = "course_" + sqid;
    let cached = getCache(cacheKey);
    if (!cached) {
      const res = await fetch(RAW_BASE + "courses/" + sqid + ".json");
      if (!res.ok) throw new Error("not found");
      cached = await res.json();
      setCache(cacheKey, cached);
    }
    courseData = cached;
  } catch (e) {
    console.error(`[initCourseDetail] Error loading course ${sqid}:`, e);
  }

  // 2. 加载教师数据
  if (tid) {
    try {
      const cacheKey = "teacher_" + tid;
      let cached = getCache(cacheKey);
      if (!cached) {
        const res = await fetch(RAW_BASE + "teachers/" + tid + ".json");
        if (res.ok) {
          cached = await res.json();
          setCache(cacheKey, cached);
        }
      }
      teacherData = cached || null;
    } catch (e) {
      console.error(`[initCourseDetail] Error loading teacher ${tid}:`, e);
    }
  }

  // 3. 从课程数据中提取基本信息
  const reviews = courseData && courseData.results ? courseData.results : [];
  const reviewCount =
    courseData && courseData.count ? courseData.count : reviews.length;

  // 优先从 URL 参数获取课程名/教师/院系（由搜索页/课程页/首页传入）
  courseName = params.get("name") || "";
  teacherName = params.get("teacher") || "";
  deptName = params.get("dept") || "";

  // 从教师数据中补充信息
  if (teacherData) {
    if (!teacherName) teacherName = teacherData.name || "";
  }
  // 兜底
  if (!courseName) courseName = "未知课程";
  if (!teacherName) teacherName = "未知教师";

  // 院系回填：URL 无 dept 参数时，从 with_comment_index.json 按 sqid 查找
  if (!deptName) {
    try {
      const res = await fetch(RAW_BASE + "with_comment_index.json");
      if (res.ok) {
        const ciRaw = await res.json();
        if (ciRaw && ciRaw.courses) {
          for (const info of Object.values(ciRaw.courses)) {
            if (info && String(info.sqid) === String(sqid)) {
              deptName = info.kkdw || "";
              break;
            }
          }
        }
      }
    } catch (e) {
      /* 静默失败 */
    }
  }

  // 计算平均分
  let avgRating = 0;
  if (reviews.length > 0) {
    const total = reviews.reduce((sum, r) => sum + (r.rating || 0), 0);
    avgRating = (total / reviews.length).toFixed(1);
  }

  // 构建 currentCourseDetail
  currentCourseDetail = {
    course_name: courseName,
    course_teacher: teacherName,
    course_dept: deptName,
    reviews: reviews,
    review_count: reviewCount,
    avg_rating: avgRating,
    sqid: sqid,
    tid: tid,
    teacher_data: teacherData,
  };

  const dept = deptName,
    teacher = teacherName,
    name = courseName;

  // Page title
  const titleEl = $("detail-page-title");
  if (titleEl) titleEl.textContent = `${name}（${teacher}）`;

  // Info card
  const nameEl = $("cd-name"),
    teacherEl = $("cd-teacher"),
    deptEl = $("cd-dept"),
    ratingEl = $("cd-rating");
  if (nameEl) nameEl.textContent = name;
  if (teacherEl) teacherEl.textContent = teacher;
  // 从教师数据获取院系（通过 tid 对应的 related_courses 或其他字段）
  if (deptEl) {
    if (dept) {
      deptEl.textContent = dept;
    } else if (
      teacherData &&
      teacherData.related_courses &&
      teacherData.related_courses.length > 0
    ) {
      // 无法直接获取院系，从课程名推测为空
      deptEl.textContent = "（未知院系）";
    } else {
      deptEl.textContent = "（未知院系）";
    }
  }
  if (ratingEl) {
    ratingEl.textContent = reviewCount
      ? `${avgRating}（${reviewCount}人评价）`
      : "暂无评价";
  }

  const reviewTitleEl = $("review-count-title");
  if (reviewTitleEl) reviewTitleEl.textContent = `点评（${reviewCount}条）`;

  // Teacher's other courses（从 teacherData 加载）
  const tcs =
    teacherData && teacherData.related_courses
      ? teacherData.related_courses
      : [];
  const tcCard = $("teacher-courses-card"),
    tcList = $("teacher-courses-list"),
    tcTitle = $("teacher-courses-title");
  if (tcCard && tcList && tcTitle) {
    if (tcs.length > 0) {
      tcCard.style.display = "block";
      tcTitle.textContent = `${teacher}的其他课`;
      const frag = document.createDocumentFragment();
      tcs.slice(0, 15).forEach((tc) => {
        const li = document.createElement("li");
        // 使用 sqid 链接到课程详情；tid 使用当前教师的 tid
        const tcTid = tid || "";
        li.innerHTML = `<a href="course.html?sqid=${tc.id}&tid=${tcTid}&name=${encodeURIComponent(tc.name)}&teacher=${encodeURIComponent(teacher)}">${tc.name}</a>${tc.count > 0 ? `<span class="teacher-course-score">（${parseFloat(tc.avg).toFixed(1)}，${tc.count}人）</span>` : ""}`;
        frag.appendChild(li);
      });
      tcList.innerHTML = "";
      tcList.appendChild(frag);
    } else {
      // 无教师文件或无 related_courses
      tcCard.style.display = "block";
      tcTitle.textContent = teacherData
        ? `${teacher}的其他课`
        : `${teacher}的其他课`;
      tcList.innerHTML = '<li style="color:#999;font-size:13px;">暂无点评</li>';
    }
  }

  // Semester select
  const semesters = [
    ...new Set((reviews || []).map((r) => extractSemester(r.comment))),
  ].filter(Boolean);
  const semSel = $("semester-select");
  if (semSel) {
    const cv = semSel.value;
    semSel.innerHTML = '<option value="">全部</option>';
    semesters.sort().forEach((s) => {
      const o = document.createElement("option");
      o.value = s;
      o.textContent = s;
      semSel.appendChild(o);
    });
    if (semesters.includes(cv)) semSel.value = cv;
  }

  // === 动态设置“新点评”按钮跳转链接 ===
  const newReviewBtn = document.getElementById("new-review-btn-detail");
  if (newReviewBtn && currentCourseDetail) {
    const { sqid, course_name, course_teacher } = currentCourseDetail;
    const courseDisplayName = `${course_name}（${course_teacher}）`;
    const url = `new-review.html?courseId=${encodeURIComponent(sqid)}&courseName=${encodeURIComponent(courseDisplayName)}`;
    newReviewBtn.href = url; // ⭐ 关键：替换 href，不再用 #
  }

  renderCourseDetailReviews();
}

function extractSemester(comment) {
  if (!comment) return "";
  const m = comment.match(/上课学期[：:]\s*(.+)/);
  return m ? m[1].trim() : "";
}

function renderCourseDetailReviews() {
  const wrap = $("course-review-list");
  if (!wrap || !currentCourseDetail) return;
  let list = [...(currentCourseDetail.reviews || [])];
  const ratingFilter = $("rating-select")?.value;
  const semesterFilter = $("semester-select")?.value;
  if (ratingFilter)
    list = list.filter((r) => String(r.rating) === ratingFilter);
  if (semesterFilter)
    list = list.filter((r) => extractSemester(r.comment) === semesterFilter);

  const sortVal = $("sort-select")?.value || "newest";
  const dateKey = (r) => r.modified_at || r.created_at || "";
  if (sortVal === "newest")
    list.sort((a, b) => dateKey(b).localeCompare(dateKey(a)));
  else if (sortVal === "oldest")
    list.sort((a, b) => dateKey(a).localeCompare(dateKey(b)));
  else if (sortVal === "rating-high") list.sort((a, b) => b.rating - a.rating);
  else if (sortVal === "rating-low") list.sort((a, b) => a.rating - b.rating);

  const total = list.length;
  if (!total) {
    wrap.innerHTML = '<div class="empty-tip">该筛选条件下暂无点评</div>';
    $("course-detail-pagination").innerHTML = "";
    return;
  }

  const { page, size } = detailState;
  const paged = getPaged(list, page, size);
  const frag = document.createDocumentFragment();

  paged.forEach((item) => {
    const div = document.createElement("div");
    div.className = "review-card";
    div.innerHTML = `<div class="review-rating-text">推荐指数：${item.rating}${item.score ? " 成绩：" + item.score : ""}</div>
            <div class="review-comment" style="white-space:pre-line;">${item.comment || "无点评内容"}</div>
            <div class="review-meta"><span>#${item.id}</span><span>${item.modified_at || item.created_at || ""}</span></div>`;
    frag.appendChild(div);
  });

  wrap.innerHTML = "";
  wrap.appendChild(frag);
  renderPagination({
    containerId: "course-detail-pagination",
    totalItems: total,
    currentPage: page,
    pageSize: size,
    onPageChange: (np, ns) => {
      detailState.page = np;
      detailState.size = ns;
      renderCourseDetailReviews();
    },
  });
}

function toggleTrend() {
  if (!currentCourseDetail) return;
  const modal = document.getElementById("trend-modal");
  const titleEl = document.getElementById("trend-title");
  // 兼容新旧数据格式
  const name =
    currentCourseDetail.course_name ||
    (currentCourseDetail.course && currentCourseDetail.course[2]) ||
    "";
  const teacher =
    currentCourseDetail.course_teacher ||
    (currentCourseDetail.course && currentCourseDetail.course[1]) ||
    "";
  titleEl.textContent = `${name}（${teacher}）的点评趋势`;
  modal.classList.add("show");
  // Delay to ensure DOM is visible before measuring
  requestAnimationFrame(() => {
    renderTrendChart(currentCourseDetail.reviews || []);
  });
}

function closeTrend(e) {
  if (e && e.target !== e.currentTarget) return;
  const modal = document.getElementById("trend-modal");
  if (modal) modal.classList.remove("show");
}

// ========== Trend Chart (Canvas) ==========
function renderTrendChart(reviews) {
  const canvas = document.getElementById("trend-chart-canvas");
  if (!canvas || !reviews.length) return;

  // Aggregate reviews by semester
  const semMap = {};
  reviews.forEach((r) => {
    const sem = extractSemester(r.comment);
    if (!sem) return;
    if (!semMap[sem]) semMap[sem] = { count: 0, total: 0 };
    semMap[sem].count++;
    semMap[sem].total += r.rating;
  });

  const semesters = Object.keys(semMap).sort();
  if (semesters.length === 0) {
    drawEmptyChart(canvas);
    return;
  }

  // Data arrays
  const barData = semesters.map((s) => semMap[s].count);
  const lineData = semesters.map(
    (s) => +(semMap[s].total / semMap[s].count).toFixed(1),
  );
  const maxBar = Math.max(...barData, 1);

  // Canvas sizing (HiDPI)
  const wrap = canvas.parentElement;
  const dpr = window.devicePixelRatio || 1;
  const w = wrap.clientWidth;
  const h = wrap.clientHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = w + "px";
  canvas.style.height = h + "px";

  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  // Chart area
  const padL = 36,
    padR = 16,
    padT = 20,
    padB = 40;
  const chartW = w - padL - padR;
  const chartH = h - padT - padB;

  // Draw Y axis (rating 1-5)
  ctx.font = "12px -apple-system, sans-serif";
  ctx.textAlign = "right";
  ctx.fillStyle = "#999";
  for (let i = 1; i <= 5; i++) {
    const y = padT + chartH - ((i - 1) / 4) * chartH;
    ctx.fillText(String(i), padL - 8, y + 4);
    // Grid line
    ctx.beginPath();
    ctx.strokeStyle = "#f0f0f0";
    ctx.moveTo(padL, y);
    ctx.lineTo(w - padR, y);
    ctx.stroke();
  }

  // Bar params
  const n = semesters.length;
  const barGapRatio = Math.min(0.4, 0.6 / Math.max(n, 2)); // more gap when few items
  const barW = Math.max(12, Math.min(60, (chartW / n) * (1 - barGapRatio)));
  const gap = (chartW - barW * n) / (n + 1);

  // Bars
  for (let i = 0; i < n; i++) {
    const x = padL + gap + i * (barW + gap);
    const barH = Math.max(0.01, (barData[i] / maxBar) * chartH);
    const y = padT + chartH - barH;

    // Draw bar with rounded top
    const radius = Math.min(3, barW / 4);
    ctx.fillStyle = "#91c4f2";
    ctx.beginPath();
    ctx.moveTo(x, y + radius);
    ctx.arcTo(x, y, x + barW, y, radius);
    ctx.arcTo(x + barW, y, x + barW, y + barH, radius);
    ctx.arcTo(x + barW, y + barH, x, y + barH, radius);
    ctx.arcTo(x, y + barH, x, y, radius);
    ctx.closePath();
    ctx.fill();

    // X label
    ctx.save();
    ctx.translate(x + barW / 2, padT + chartH + 10);
    ctx.rotate(-0.35);
    ctx.textAlign = "right";
    ctx.fillStyle = "#999";
    ctx.font = "11px -apple-system, sans-serif";
    const label = semesters[i];
    ctx.fillText(label.length > 14 ? label.slice(0, 13) : label, 0, 0);
    ctx.restore();
  }

  // Line (average rating)
  ctx.beginPath();
  ctx.strokeStyle = "#52c41a";
  ctx.lineWidth = 2;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  for (let i = 0; i < n; i++) {
    const cx = padL + gap + i * (barW + gap) + barW / 2;
    const cy = padT + chartH - ((lineData[i] - 1) / 4) * chartH;
    if (i === 0) ctx.moveTo(cx, cy);
    else ctx.lineTo(cx, cy);
  }
  ctx.stroke();

  // Dots on line
  for (let i = 0; i < n; i++) {
    const cx = padL + gap + i * (barW + gap) + barW / 2;
    const cy = padT + chartH - ((lineData[i] - 1) / 4) * chartH;
    ctx.beginPath();
    ctx.fillStyle = "#fff";
    ctx.arc(cx, cy, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.strokeStyle = "#52c41a";
    ctx.lineWidth = 2;
    ctx.arc(cx, cy, 4, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Tooltip on hover (simple approach)
  canvas._trendData = {
    semesters,
    barData,
    lineData,
    padL,
    padR,
    padT,
    padB,
    chartW,
    chartH,
    barW,
    gap,
    maxBar,
  };

  canvas.onmousemove = function (e) {
    if (!canvas._trendData) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const d = canvas._trendData;
    let hitIdx = -1;
    for (let i = 0; i < d.n; i++) {
      const bx = d.padL + d.gap + i * (d.barW + d.gap);
      if (mx >= bx && mx <= bx + d.barW) {
        hitIdx = i;
        break;
      }
      // Also check line dot proximity
      const cx = bx + d.barW / 2;
      const cy = d.padT + d.chartH - ((d.lineData[i] - 1) / 4) * d.chartH;
      if (Math.abs(mx - cx) < 15 && Math.abs(my - cy) < 15) {
        hitIdx = i;
        break;
      }
    }

    const tip = document.getElementById("trend-tooltip") || createTooltip();
    if (hitIdx >= 0 && hitIdx < d.semesters.length) {
      tip.style.display = "block";
      tip.style.left = rect.left + mx + 12 + "px";
      tip.style.top = rect.top + my - 10 + "px";
      tip.innerHTML = `<strong>${d.semesters[hitIdx]}</strong><br/>点评数：${d.barData[hitIdx]}<br/>平均分：${d.lineData[hitIdx]}`;
    } else {
      tip.style.display = "none";
    }
  };
  canvas.onmouseleave = function () {
    const tip = document.getElementById("trend-tooltip");
    if (tip) tip.style.display = "none";
  };
}

function createTooltip() {
  const el = document.createElement("div");
  el.id = "trend-tooltip";
  el.cssText = "";
  el.style.cssText = `position:fixed;display:none;z-index:10000;padding:6px 10px;background:rgba(0,0,0,0.75);color:#fff;font-size:12px;border-radius:4px;pointer-events:none;white-space:nowrap;line-height:1.7;`;
  document.body.appendChild(el);
  return el;
}

function drawEmptyChart(canvas) {
  const wrap = canvas.parentElement;
  const dpr = window.devicePixelRatio || 1;
  const w = wrap.clientWidth;
  const h = wrap.clientHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = w + "px";
  canvas.style.height = h + "px";
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.font = "14px -apple-system, sans-serif";
  ctx.fillStyle = "#999";
  ctx.textAlign = "center";
  ctx.fillText("暂无足够数据展示趋势", w / 2, h / 2);
}

// ==================== SEARCH PAGE ====================
// 搜索使用 data/with_comment_index.json（勾选仅有点评）或 data/full_index.json（全部课程）
let searchResults = [];

// 加载搜索索引（带缓存）
async function loadSearchIndex(onlyReviewed) {
  const cacheKey = onlyReviewed ? "search_idx_comment" : "search_idx_full";
  const cached = getCache(cacheKey);
  if (cached && cached.courses && Object.keys(cached.courses).length > 0) {
    searchIndexCache = cached;
    return;
  }
  const filename = onlyReviewed ? "with_comment_index.json" : "full_index.json";
  try {
    const res = await fetch(RAW_BASE + filename);
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${filename}`);
    searchIndexCache = await res.json();
    setCache(cacheKey, searchIndexCache);
  } catch (e) {
    console.error(`[loadSearchIndex] Error loading ${filename}:`, e);
    searchIndexCache = { courses: {} };
  }
}

async function initSearchPage() {
  const params = new URLSearchParams(location.search);
  const kw = params.get("keyword") || "";
  $("search-keyword-input").value = kw;
  const onlyReviewed = $("search-only-reviewed")?.checked;
  await loadSearchIndex(onlyReviewed);
  doSearchInternal(kw);
}

function doSearch() {
  doSearchInternal($("search-keyword-input").value.trim());
}

function doSearchFromCheckbox() {
  const onlyReviewed = $("search-only-reviewed")?.checked;
  // 切换索引源：清除缓存以强制重新加载对应索引
  searchIndexCache = null;
  loadSearchIndex(onlyReviewed).then(() => {
    doSearchInternal($("search-keyword-input").value.trim());
  });
}

// 括号标准化：全角（）→ 半角()，确保用户输入与数据格式一致
function normalizeParens(s) {
  return s.replace(/\uff08/g, "(").replace(/\uff09/g, ")");
}

function doSearchInternal(keyword) {
  if (!searchIndexCache || !searchIndexCache.courses) {
    searchResults = [];
    searchState.page = 1;
    renderSearchList();
    return;
  }
  const onlyReviewed = $("search-only-reviewed")?.checked;
  const lower = normalizeParens(keyword || "").toLowerCase();
  const courses = searchIndexCache.courses;
  const results = [];

  for (const [key, info] of Object.entries(courses)) {
    if (!info || typeof info !== "object") continue;

    if (keyword) {
      const normKey = normalizeParens(key).toLowerCase();
      if (!normKey.includes(lower)) {
        continue;
      }
    }
    // onlyReviewed 已由选择的不同索引文件保证，但为防止 full_index 中 count=0 的记录，再过滤一次
    if (onlyReviewed && (info.count || 0) === 0) continue;

    results.push({
      kcm: info.kcm,
      jsm: info.jsm,
      kkdw: info.kkdw,
      count: info.count || 0,
      avg: info.avg || 0,
      sqid: info.sqid, // 课程详情文件 ID（data/courses/{sqid}.json）
      tid: info.tid, // 教师文件 ID（data/teachers/{tid}.json）
    });
  }

  // 按点评数降序排列
  results.sort((a, b) => b.count - a.count);
  searchResults = results;
  searchState.page = 1;
  renderSearchList();
}

function renderSearchList() {
  const wrap = $("search-results"),
    countEl = $("result-count");
  if (!wrap || !countEl) return;
  const total = searchResults.length;
  countEl.textContent = total;
  if (!total) {
    wrap.innerHTML = '<div class="empty-tip">未找到匹配的课程</div>';
    $("search-pagination").innerHTML = "";
    return;
  }

  const { page, size } = searchState;
  const paged = getPaged(searchResults, page, size);
  const frag = document.createDocumentFragment();

  paged.forEach((c) => {
    const avg = c.count > 0 ? parseFloat(c.avg).toFixed(1) : "-";
    const count = c.count || 0;
    const div = document.createElement("div");
    div.className = "search-result-item";
    div.innerHTML = `<div class="search-result-info">
            <h3><a href="course.html?sqid=${c.sqid}&tid=${c.tid}&name=${encodeURIComponent(c.kcm)}&teacher=${encodeURIComponent(c.jsm)}&dept=${encodeURIComponent(c.kkdw)}">${c.kcm}<span style="font-weight:400;color:#8a4abf;margin-left:4px;">（${c.jsm}）</span></a></h3>
            <div class="search-result-dept">${c.kkdw}</div>
        </div>
        <div class="search-result-score">
            <div class="search-score-num">${avg}</div>
            <div class="search-score-count">${count}人评价</div>
        </div>`;
    frag.appendChild(div);
  });

  wrap.innerHTML = "";
  wrap.appendChild(frag);
  renderPagination({
    containerId: "search-pagination",
    totalItems: total,
    currentPage: page,
    pageSize: size,
    onPageChange: (np, ns) => {
      searchState.page = np;
      searchState.size = ns;
      renderSearchList();
    },
  });
}

// ==================== STATISTICS PAGE ====================
async function initStatPage() {
  // 从 full_index.json 统计数据
  if (!fullIndexLoaded) {
    try {
      const res = await fetch(RAW_BASE + "full_index.json");
      if (res.ok) {
        const data = await res.json();
        let totalReview = 0,
          totalCourse = 0,
          reviewedCount = 0;
        for (const info of Object.values(data.courses || {})) {
          if (!info || typeof info !== "object") continue;
          totalCourse++;
          if (info.count > 0) reviewedCount++;
          totalReview += info.count || 0;
        }
        const a = $("stat-review-total"),
          b = $("stat-course-total"),
          c = $("stat-course-reviewed");
        if (a) a.textContent = totalReview;
        if (b) b.textContent = totalCourse;
        if (c) c.textContent = reviewedCount;
        return;
      }
    } catch (e) {
      console.error("[initStatPage] Error:", e);
    }
  }
  // fallback: 用已加载的 coursesAll 统计
  let totalReview = 0,
    totalCourse = coursesAll.length,
    reviewedCount = 0;
  for (const c of coursesAll) {
    if (c.count > 0) reviewedCount++;
    totalReview += c.count || 0;
  }
  const a = $("stat-review-total"),
    b = $("stat-course-total"),
    c = $("stat-course-reviewed");
  if (a) a.textContent = totalReview;
  if (b) b.textContent = totalCourse || (manifest ? manifest.total_courses : 0);
  if (c) c.textContent = reviewedCount;
}

// ==================== 新点评提交 ====================
function getFormattedTime(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0"); // 月份从0开始，需+1并补零
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");

  return `${year}/${month}/${day} ${hours}:${minutes}`;
}

// UTF-8 安全的 Base64 编码（服务端 atob 后直接得合法 JSON，含中文也不乱码）
function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

async function submitReview(courseId, rating, comment, score) {
  try {
    // 提交点评
    content = {
      id: courseId,
      rating: rating,
      comment: comment,
      created_at: getFormattedTime(),
      score: score || null,
    };
    const res = await fetch(`${API_BASE}/comment`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: utf8ToBase64(JSON.stringify(content)),
        encoding: "base64",
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "提交失败");
    return { success: true, data };
  } catch (e) {
    const msg = e.message;
    // 网络错误时给出友好提示
    if (msg === "Failed to fetch") {
      return { success: false, error: "后端服务暂时不可用，请稍后重试" };
    }
    return { success: false, error: msg };
  }
}

// 课程搜索
function searchCoursesFromIndex(query) {
  if (!query || query.length < 1) return [];
  if (!searchIndexCache?.courses) return [];

  const lower = normalizeParens(query).toLowerCase();
  const results = [];
  const courses = searchIndexCache.courses;

  for (const [key, info] of Object.entries(courses)) {
    if (!info || typeof info !== "object") continue;

    // 搜索键 = "课程名（教师）"，与 search.html 一致
    const searchText = normalizeParens(
      `${info.kcm}（${info.jsm}）`,
    ).toLowerCase();
    if (searchText.includes(lower)) {
      results.push({
        sqid: info.sqid,
        name: info.kcm || "",
        teacher: info.jsm || "",
        dept: info.kkdw || "",
      });
    }
    if (results.length >= 20) break;
  }

  // 按点评数降序（与搜索页一致）
  results.sort((a, b) => (b.count || 0) - (a.count || 0));
  return results;
}

// ======================
// new-review.html 专用初始化函数
// ======================
function initNewReviewPage() {
  // 仅在 new-review.html 页面运行
  if (!window.location.pathname.endsWith("new-review.html")) return;

  // --- 工具函数 ---
  function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  function showError(msg) {
    const errEl = document.getElementById("review-form-error");
    if (errEl) {
      errEl.textContent = msg;
      errEl.style.display = "block";
      setTimeout(() => {
        errEl.style.display = "none";
      }, 5000);
    }
  }

  // --- 解析 URL 参数 ---
  const urlParams = new URLSearchParams(window.location.search);
  const courseIdParam = urlParams.get("courseId");
  const courseNameParam = urlParams.get("courseName");

  const courseSelectSection = document.getElementById("course-select-section");
  const reviewCourseId = document.getElementById("review-course-id");
  const reviewFormTitle = document.getElementById("review-form-title");

  // 如果 URL 提供了课程信息，则隐藏搜索框并预填
  if (courseIdParam && courseNameParam) {
    // 安全操作：只有元素存在才修改
    if (courseSelectSection) {
      courseSelectSection.style.display = "none";
    }
    if (reviewCourseId) {
      reviewCourseId.value = courseIdParam;
    }
    if (reviewFormTitle) {
      reviewFormTitle.textContent =
        "新点评 - " + decodeURIComponent(courseNameParam);
    }
  } else {
    // 否则显示搜索框，用户需要选择课程
    if (courseSelectSection) {
      courseSelectSection.style.display = "block";
    }
  }

  // --- 星级评分交互 ---
  const stars = document.querySelectorAll("#rating-stars span");
  const ratingInput = document.getElementById("review-rating-value");
  const ratingLabel = document.getElementById("rating-value-label");

  function updateStars(rating) {
    stars.forEach((star, i) => {
      star.style.color = i < rating ? "#faad14" : "#e8e8e8";
      star.setAttribute("aria-checked", String(i + 1 === rating));
      star.tabIndex = i + 1 === rating ? "0" : "-1";
    });
    ratingInput.value = rating;
    ratingLabel.textContent = rating ? `${rating} 星` : "请选择推荐指数";
  }

  stars.forEach((star) => {
    star.addEventListener("click", () => {
      const rating = parseInt(star.dataset.rating);
      updateStars(rating);
    });
    star.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        const rating = parseInt(star.dataset.rating);
        updateStars(rating);
      }
    });
  });

  // --- 课程搜索（仅当需要选择课程时）---
  if (courseIdParam == null) {
    const searchInput = document.getElementById("review-course-search");
    const dropdown = document.getElementById("review-course-dropdown");
    const selectedDiv = document.getElementById("review-course-selected");

    // 👇 关键：加载搜索索引（仅有点评的课程）
    loadSearchIndex(true).catch((err) => {
      console.error("Failed to load search index:", err);
      showError("课程列表加载失败，请刷新重试");
    });

    let searchTimer = null;
    searchInput.addEventListener("input", () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        const q = searchInput.value.trim();
        if (q.length < 1) {
          dropdown.style.display = "none";
          return;
        }

        // 等待索引加载
        if (!searchIndexCache?.courses) {
          dropdown.innerHTML =
            '<div style="padding:8px 12px;color:#999;font-size:13px;">正在加载...</div>';
          dropdown.style.display = "block";
          return;
        }

        const results = searchCoursesFromIndex(q);
        if (results.length === 0) {
          dropdown.innerHTML =
            '<div style="padding:8px 12px;color:#999;font-size:13px;">未找到匹配课程</div>';
        } else {
          // 使用事件委托渲染（安全且高效）
          const frag = document.createDocumentFragment();
          results.forEach((r) => {
            const div = document.createElement("div");
            div.style.cssText =
              "padding:8px 12px;cursor:pointer;font-size:13px;border-bottom:1px solid #f0f0f0;";
            div.innerHTML = `
            <span style="font-weight:500;">${escapeHtml(r.name)}</span>
            <span style="color:#8a4abf;margin-left:4px;">（${escapeHtml(r.teacher)}）</span>
            <span style="color:#999;margin-left:8px;">${escapeHtml(r.dept)}</span>
          `;
            div.addEventListener("click", () =>
              selectCourse(r.sqid, r.name, r.teacher, r.dept),
            );
            frag.appendChild(div);
          });
          dropdown.innerHTML = "";
          dropdown.appendChild(frag);
        }
        dropdown.style.display = "block";
      }, 200);
    });

    // 全局选择函数
    window.selectCourse = (sqid, name, teacher, dept) => {
      reviewCourseId.value = sqid;
      searchInput.value = `${name}（${teacher}）`;
      selectedDiv.textContent = `${name}（${teacher}）- ${dept}`;
      selectedDiv.style.display = "block";
      dropdown.style.display = "none";
    };

    // 点击外部关闭下拉
    document.addEventListener("click", (e) => {
      if (!searchInput.contains(e.target) && !dropdown.contains(e.target)) {
        dropdown.style.display = "none";
      }
    });

    // 全局选择函数（供 dropdown 调用）
    window.selectCourse = (sqid, name, teacher, dept) => {
      reviewCourseId.value = sqid;
      searchInput.value = `${name}（${teacher}）`;
      selectedDiv.textContent = `${name}（${teacher}）- ${dept}`;
      selectedDiv.style.display = "block";
      dropdown.style.display = "none";
    };

    // 点击外部关闭下拉
    document.addEventListener("click", (e) => {
      if (!searchInput.contains(e.target) && !dropdown.contains(e.target)) {
        dropdown.style.display = "none";
      }
    });
  }

  // --- 表单提交 ---
  document
    .getElementById("review-submit-btn")
    .addEventListener("click", async () => {
      const courseId = parseInt(reviewCourseId.value);
      const rating = parseInt(ratingInput.value);
      const comment = document.getElementById("review-comment").value.trim();
      const score = document.getElementById("review-score").value.trim();

      if (!courseId) {
        showError("请搜索并选择课程");
        return;
      }
      if (!rating || rating < 1 || rating > 5) {
        showError("请选择推荐指数（1-5星）");
        return;
      }
      if (!comment) {
        showError("请输入点评内容");
        return;
      }

      // 调用提交 API（确保 submitReview 在 main.js 中已定义）
      if (typeof submitReview !== "function") {
        alert("提交功能未实现");
        return;
      }

      try {
        const result = await submitReview(courseId, rating, comment, score);
        if (result.success) {
          alert("点评提交成功！");
          window.location.href = "index.html";
        } else {
          showError(result.error || "提交失败，请稍后重试");
        }
      } catch (err) {
        console.error(err);
        showError("网络错误，请检查连接后重试");
      }
    });

  // --- 取消按钮 ---
  document.getElementById("review-cancel-btn").addEventListener("click", () => {
    if (confirm("确定要取消点评吗？")) {
      window.history.back();
    }
  });
}

// 页面加载完成后自动初始化
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initNewReviewPage);
} else {
  initNewReviewPage();
}
