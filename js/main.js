/* ================================================================
 * THU 选课社区 - Worker API + Pages 静态托管
 *
 * 架构:
 *   Cloudflare Pages 托管 HTML/CSS/JS + JSON 数据
 *   Cloudflare Worker 处理 API (/api/*) + 数据 (/api/data/*)
 *
 * 加载策略:
 *   首页:      manifest + views_summary + reviews_latest  (~365 KB)
 *   课程详情:  manifest + 1 detail_chunk                   (~250 KB)
 *   课程列表:  manifest + views_summary + course_index + 5 course chunks (~5.6 MB)
 *   搜索:      同课程列表
 *   统计:      manifest + views_summary                   (~43 KB)
 * ================================================================ */

// Worker API 地址（部署后替换为实际地址）
const WORKER_HOST = '';
const API_BASE = `${WORKER_HOST}/api`;
const DATA_BASE = `${API_BASE}/data`;

// Pages 本地 JSON 路径
const STATIC_BASE = 'data/optimized/';

const CACHE_PREFIX = 'thu_v3_';
const CACHE_TTL = 30 * 60 * 1000;

// ========== Global State ==========
let manifest = null;
let courseIdx = {};        // {cid: [dept, teacher, name]}  (lazy, only for courses/search)
let viewsSummary = {};     // {cid: {c, a, r}}
let latestReviews = [];    // 首页用
let coursesAll = [];       // 所有课程 (lazy, for courses/search page)
let courseIdxLoaded = false;

// Page state
let indexState = { page: 1, size: 10 };
let courseState = { page: 1, size: 10 };
let searchState = { page: 1, size: 10 };
let detailState = { page: 1, size: 5 };
let filteredCourses = [];
let currentRaf = null;

// ========== Utils ==========
function $(id) { return document.getElementById(id); }
function qs(sel) { return document.querySelector(sel); }

function getCache(key) {
    try {
        const raw = localStorage.getItem(CACHE_PREFIX + key);
        if (!raw) return null;
        const { data, ts } = JSON.parse(raw);
        if (Date.now() - ts > CACHE_TTL) { localStorage.removeItem(CACHE_PREFIX + key); return null; }
        return data;
    } catch { return null; }
}
function setCache(key, data) {
    try { localStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ data, ts: Date.now() })); } catch {}
}

function getPaged(list, page, size) {
    return list.slice((page - 1) * size, page * size);
}

function getCourseName(cid) {
    const c = courseIdx[String(cid)];
    return c ? `${c[2]}（${c[1]}）` : '未知课程';
}

// ========== Init ==========
document.addEventListener('DOMContentLoaded', async () => {
    await loadManifest();
    await routePage();
});

async function loadManifest() {
    const cached = getCache('manifest');
    // 校验缓存版本：v3 必须有 detail_chunks 字段
    if (cached && cached.v === 3 && cached.detail_chunks) {
        manifest = cached;
        return;
    }
    // 缓存过期或版本不匹配 → 清除并重新加载
    try {
        const res = await fetch(STATIC_BASE + 'manifest.json');
        manifest = await res.json();
        setCache('manifest', manifest);
    } catch (e) { console.error('Manifest load error', e); }
}

// 加载静态文件
async function loadStatic(key, filename, expectedType = null) {
    const cached = getCache(key);
    if (cached !== null && cached !== undefined && !(Array.isArray(cached) && cached.length === 0)) {
        // 缓存存在且非空数组 → 使用缓存
        if (expectedType === 'array' && !Array.isArray(cached)) {
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
        return expectedType === 'array' ? [] : null;
    }
}

// ========== Routing ==========
async function routePage() {
    const path = location.pathname;
    if (path.endsWith('index.html') || path === '/' || path.endsWith('/'))
        await initIndexPage();
    else if (path.endsWith('courses.html'))
        await initCoursesPage();
    else if (path.endsWith('statistics.html'))
        await initStatPage();
    else if (path.endsWith('course.html'))
        await initCourseDetail();
    else if (path.endsWith('search.html'))
        await initSearchPage();
}

// ========== Pagination ==========
function renderPagination({ containerId, totalItems, currentPage, pageSize, onPageChange }) {
    const container = $(containerId);
    if (!container) return;
    if (totalItems === 0) { container.innerHTML = ''; return; }
    const totalPages = Math.ceil(totalItems / pageSize);
    if (totalPages <= 1) { container.innerHTML = ''; return; }

    const frag = document.createDocumentFragment();
    const mkBtn = (text, cb, disabled) => {
        const b = document.createElement('button');
        b.textContent = text;
        if (disabled) b.disabled = true;
        if (cb) b.onclick = cb;
        return b;
    };

    frag.appendChild(mkBtn('上一页', () => currentPage > 1 && onPageChange(currentPage - 1, pageSize), currentPage === 1));

    const pages = [];
    pages.push(1);
    if (currentPage - 2 > 2) pages.push(-1);
    for (let i = Math.max(2, currentPage - 2); i <= Math.min(totalPages - 1, currentPage + 2); i++) pages.push(i);
    if (currentPage + 2 < totalPages - 1) pages.push(-1);
    if (totalPages > 1) pages.push(totalPages);

    pages.forEach(p => {
        if (p === -1) { const s = document.createElement('span'); s.className = 'ellipsis'; s.textContent = '...'; frag.appendChild(s); }
        else { const b = mkBtn(String(p), () => onPageChange(p, pageSize)); if (p === currentPage) b.className = 'active'; frag.appendChild(b); }
    });

    frag.appendChild(mkBtn('下一页', () => currentPage < totalPages && onPageChange(currentPage + 1, pageSize), currentPage === totalPages));

    const sel = document.createElement('select');
    [10, 20, 50].forEach(s => { const o = document.createElement('option'); o.value = s; o.textContent = s + '条/页'; if (s === pageSize) o.selected = true; sel.appendChild(o); });
    sel.onchange = e => onPageChange(1, +e.target.value);
    frag.appendChild(sel);

    container.innerHTML = '';
    container.appendChild(frag);
}

// ==================== INDEX PAGE ====================
async function initIndexPage() {
    // v3: reviews_latest has embedded _course_name / _course_teacher
    // No need to load 2.2MB course_index for the homepage!
    const [vsRaw, rlRaw] = await Promise.all([
        loadStatic('views_summary', 'views_summary.json', 'object'),
        loadStatic('reviews_latest', 'reviews_latest.json', 'array'),
    ]);
    viewsSummary = vsRaw || {};
    latestReviews = Array.isArray(rlRaw) ? rlRaw : [];
    renderIndex();
}

function renderIndex() {
    const wrap = $('review-list');
    const totalEl = $('total-review-num');
    if (!wrap || !totalEl) return;

    // 使用实际加载的点评数量，而非全量总数（首页仅加载最新500条）
    const total = latestReviews.length;
    totalEl.textContent = manifest ? manifest.total_reviews : total;
    if (!total) { wrap.innerHTML = '<div class="empty-tip">暂无点评内容</div>'; $('review-pagination').innerHTML = ''; return; }

    const { page, size } = indexState;
    const paged = getPaged(latestReviews, page, size);
    const frag = document.createDocumentFragment();

    paged.forEach(item => {
        const name = item._course_name || `课程 #${item.course.id}`;
        const teacher = item._course_teacher || '';
        const courseName = teacher ? `${name}（${teacher}）` : name;
        const card = document.createElement('div');
        card.className = 'review-card';
        card.innerHTML = `<a href="course.html?id=${item.course.id}" class="review-course-link">${courseName}</a>
            <div class="review-rating-text">推荐指数：${item.rating}</div>
            <div class="review-comment">${item.comment || '无点评内容'}</div>
            <div class="review-meta"><span>#${item.id}</span><span>${item.modified_at || ''}</span></div>`;
        frag.appendChild(card);
    });

    wrap.innerHTML = '';
    wrap.appendChild(frag);
    renderPagination({ containerId: 'review-pagination', totalItems: total, currentPage: page, pageSize: size,
        onPageChange: (np, ns) => { indexState.page = np; indexState.size = ns; renderIndex(); } });
}

// ==================== COURSES PAGE ====================
async function loadCourseIndex() {
    if (courseIdxLoaded) return;
    const ciRaw = await loadStatic('course_index', 'course_index.json');
    courseIdx = ciRaw || {};
    courseIdxLoaded = true;
}

async function loadAllCourses() {
    if (coursesAll.length > 0) return;
    const cached = getCache('courses_all');
    if (cached) { coursesAll = cached; return; }
    await loadCourseIndex();
    const proms = manifest.chunks.map(fn => fetch(STATIC_BASE + fn).then(r => r.json()));
    const chunks = await Promise.all(proms);
    coursesAll = chunks.flat();
    setCache('courses_all', coursesAll);
}

function getDeptStats() {
    const stats = {};
    Object.entries(courseIdx).forEach(([cid, c]) => {
        const d = c[0];
        if (!stats[d]) stats[d] = { count: 0, reviewed: 0 };
        stats[d].count++;
    });
    Object.keys(viewsSummary).forEach(cid => {
        const c = courseIdx[cid];
        if (c && stats[c[0]]) stats[c[0]].reviewed++;
    });
    return stats;
}

function populateDeptFilter() {
    const container = $('filter-dept');
    if (!container) return;
    const stats = getDeptStats();
    const sorted = Object.entries(stats).sort((a, b) => b[1].count - a[1].count);
    const frag = document.createDocumentFragment();
    sorted.forEach(([dept, info]) => {
        const l = document.createElement('label');
        l.className = 'filter-option';
        l.innerHTML = `<input type="checkbox" value="${dept}" class="dept-check"><span class="filter-option-label">${dept}</span><span class="filter-option-count">${info.count}</span>`;
        frag.appendChild(l);
    });
    container.innerHTML = '';
    container.appendChild(frag);
}

function toggleFilterGroup(el) {
    const t = $(el.dataset.target);
    const a = el.querySelector('.arrow');
    if (t) { t.classList.toggle('show'); a.classList.toggle('open'); }
}

async function initCoursesPage() {
    await loadAllCourses();
    // views_summary needed for review counts
    if (!Object.keys(viewsSummary).length) {
        viewsSummary = await loadStatic('views_summary', 'views_summary.json');
    }
    populateDeptFilter();
    filteredCourses = [...coursesAll];
    renderCourseList();
}

async function applyFilters() {
    await loadAllCourses();
    if (!Object.keys(viewsSummary).length) {
        viewsSummary = await loadStatic('views_summary', 'views_summary.json');
    }
    let result = [...coursesAll];
    const onlyReviewed = $('filter-has-reviews')?.checked;
    if (onlyReviewed) {
        const revIds = new Set(Object.keys(viewsSummary));
        result = result.filter(c => revIds.has(String(c.id)));
    }
    const checkedDepts = Array.from(document.querySelectorAll('.dept-check:checked')).map(cb => cb.value);
    if (checkedDepts.length > 0) {
        const s = new Set(checkedDepts);
        result = result.filter(c => s.has(c.department));
    }
    filteredCourses = result;
    courseState.page = 1;
    renderCourseList();
}

function renderCourseList() {
    const wrap = $('all-course-list');
    const totalEl = $('all-course-num');
    if (!wrap || !totalEl) return;
    const total = filteredCourses.length;
    totalEl.textContent = total;
    if (!total) { wrap.innerHTML = '<div class="empty-tip">暂无匹配课程</div>'; $('course-pagination').innerHTML = ''; return; }

    const { page, size } = courseState;
    const paged = getPaged(filteredCourses, page, size);
    const frag = document.createDocumentFragment();

    paged.forEach(c => {
        const vs = viewsSummary[String(c.id)];
        const count = vs ? vs.c : 0;
        const div = document.createElement('div');
        div.className = 'course-list-item';
        div.innerHTML = `<div class="course-info"><h3><a href="course.html?id=${c.id}">${c.name}<span style="font-weight:400;color:#8a4abf;margin-left:4px;">（${c.teacher}）</span></a></h3><div class="course-dept-name">${c.department}</div></div><div class="course-review-status">${count === 0 ? '暂无点评' : count + '条点评'}</div>`;
        frag.appendChild(div);
    });

    wrap.innerHTML = '';
    wrap.appendChild(frag);
    renderPagination({ containerId: 'course-pagination', totalItems: total, currentPage: page, pageSize: size,
        onPageChange: (np, ns) => { courseState.page = np; courseState.size = ns; renderCourseList(); } });
}

// ==================== COURSE DETAIL ====================
// v3: course details in 10 merged chunks (1 HTTP request per page, ~250KB)
let currentCourseDetail = null;

async function initCourseDetail() {
    const params = new URLSearchParams(location.search);
    const cid = params.get('id');
    if (!cid) { qs('.container').innerHTML = '<div class="empty-tip">缺少课程ID参数</div>'; return; }

    const detailMod = manifest.detail_mod || 10;
    const chunkIdx = parseInt(cid) % detailMod;
    const chunkFile = (manifest.detail_chunks && manifest.detail_chunks[chunkIdx]) || `detail_chunks_${chunkIdx}.json`;

    const cacheKey = 'detail_chunk_' + chunkIdx;
    let chunk = getCache(cacheKey);
    if (!chunk || typeof chunk !== 'object' || Array.isArray(chunk)) {
        try {
            const res = await fetch(STATIC_BASE + chunkFile);
            if (!res.ok) throw new Error('not found');
            chunk = await res.json();
            setCache(cacheKey, chunk);
        } catch (e) {
            console.error(`[loadStatic] Error loading detail chunk ${chunkFile}:`, e);
            chunk = {};
        }
    }

    let detail = chunk[cid];
    if (!detail) {
        // Fallback: 课程无点评 → 从 course_index 构建基本信息
        if (!courseIdxLoaded) {
            const ciRaw = await loadStatic('course_index', 'course_index.json');
            courseIdx = ciRaw || {};
            courseIdxLoaded = true;
        }
        const courseEntry = courseIdx[cid];
        if (!courseEntry) {
            qs('.container').innerHTML = '<div class="empty-tip">未找到该课程</div>';
            return;
        }
        detail = {
            course: courseEntry,
            reviews: [],
            teacher_courses: [],
            review_count: 0,
            avg_rating: 0,
        };
    }

    currentCourseDetail = detail;
    const c = detail.course;
    const dept = c[0], teacher = c[1], name = c[2];

    // Page title
    const titleEl = $('detail-page-title');
    if (titleEl) titleEl.textContent = `${name}（${teacher}）`;

    // Info card
    const nameEl = $('cd-name'), teacherEl = $('cd-teacher'), deptEl = $('cd-dept'), ratingEl = $('cd-rating');
    if (nameEl) nameEl.textContent = name;
    if (teacherEl) teacherEl.textContent = teacher;
    if (deptEl) deptEl.textContent = dept;
    if (ratingEl) {
        const rc = detail.review_count;
        ratingEl.textContent = rc ? `${detail.avg_rating}（${rc}人评价）` : '暂无评价';
    }

    const reviewTitleEl = $('review-count-title');
    if (reviewTitleEl) reviewTitleEl.textContent = `点评（${detail.review_count}条）`;

    // Teacher's other courses (already included in detail file!)
    const tcs = detail.teacher_courses || [];
    const tcCard = $('teacher-courses-card'), tcList = $('teacher-courses-list'), tcTitle = $('teacher-courses-title');
    if (tcCard && tcList && tcTitle) {
        if (tcs.length > 0) {
            tcCard.style.display = 'block';
            tcTitle.textContent = `${teacher}的其他课`;
            const frag = document.createDocumentFragment();
            tcs.slice(0, 15).forEach(tc => {
                const li = document.createElement('li');
                li.innerHTML = `<a href="course.html?id=${tc.id}">${tc.name}</a>${tc.c > 0 ? `<span class="teacher-course-score">（${tc.a}，${tc.c}人）</span>` : ''}`;
                frag.appendChild(li);
            });
            tcList.innerHTML = ''; tcList.appendChild(frag);
        } else { tcCard.style.display = 'none'; }
    }

    // Semester select
    const semesters = [...new Set((detail.reviews || []).map(r => extractSemester(r.comment)))].filter(Boolean);
    const semSel = $('semester-select');
    if (semSel) {
        const cv = semSel.value;
        semSel.innerHTML = '<option value="">全部</option>';
        semesters.sort().forEach(s => { const o = document.createElement('option'); o.value = s; o.textContent = s; semSel.appendChild(o); });
        if (semesters.includes(cv)) semSel.value = cv;
    }

    renderCourseDetailReviews();
}

function extractSemester(comment) {
    if (!comment) return '';
    const m = comment.match(/上课学期[：:]\s*(.+)/);
    return m ? m[1].trim() : '';
}

function renderCourseDetailReviews() {
    const wrap = $('course-review-list');
    if (!wrap || !currentCourseDetail) return;
    let list = [...(currentCourseDetail.reviews || [])];
    const ratingFilter = $('rating-select')?.value;
    const semesterFilter = $('semester-select')?.value;
    if (ratingFilter) list = list.filter(r => String(r.rating) === ratingFilter);
    if (semesterFilter) list = list.filter(r => extractSemester(r.comment) === semesterFilter);

    const sortVal = $('sort-select')?.value || 'newest';
    const dateKey = r => r.modified_at || r.created_at || '';
    if (sortVal === 'newest') list.sort((a, b) => dateKey(b).localeCompare(dateKey(a)));
    else if (sortVal === 'oldest') list.sort((a, b) => dateKey(a).localeCompare(dateKey(b)));
    else if (sortVal === 'rating-high') list.sort((a, b) => b.rating - a.rating);
    else if (sortVal === 'rating-low') list.sort((a, b) => a.rating - b.rating);

    const total = list.length;
    if (!total) { wrap.innerHTML = '<div class="empty-tip">该筛选条件下暂无点评</div>'; $('course-detail-pagination').innerHTML = ''; return; }

    const { page, size } = detailState;
    const paged = getPaged(list, page, size);
    const frag = document.createDocumentFragment();

    paged.forEach(item => {
        const div = document.createElement('div');
        div.className = 'review-card';
        div.innerHTML = `<div class="review-rating-text">推荐指数：${item.rating}${item.score ? ' 成绩：'+item.score : ''}</div>
            <div class="review-comment" style="white-space:pre-line;">${item.comment || '无点评内容'}</div>
            <div class="review-meta"><span>#${item.id}</span><span>${item.modified_at || item.created_at || ''}</span></div>`;
        frag.appendChild(div);
    });

    wrap.innerHTML = '';
    wrap.appendChild(frag);
    renderPagination({ containerId: 'course-detail-pagination', totalItems: total, currentPage: page, pageSize: size,
        onPageChange: (np, ns) => { detailState.page = np; detailState.size = ns; renderCourseDetailReviews(); } });
}

function toggleTrend() {
    if (!currentCourseDetail) return;
    const modal = document.getElementById('trend-modal');
    const titleEl = document.getElementById('trend-title');
    const c = currentCourseDetail.course;
    titleEl.textContent = `${c[2]}（${c[1]}）的点评趋势`;
    modal.classList.add('show');
    // Delay to ensure DOM is visible before measuring
    requestAnimationFrame(() => {
        renderTrendChart(currentCourseDetail.reviews || []);
    });
}

function closeTrend(e) {
    if (e && e.target !== e.currentTarget) return;
    const modal = document.getElementById('trend-modal');
    if (modal) modal.classList.remove('show');
}

// ========== Trend Chart (Canvas) ==========
function renderTrendChart(reviews) {
    const canvas = document.getElementById('trend-chart-canvas');
    if (!canvas || !reviews.length) return;
    
    // Aggregate reviews by semester
    const semMap = {};
    reviews.forEach(r => {
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
    const barData = semesters.map(s => semMap[s].count);
    const lineData = semesters.map(s => +(semMap[s].total / semMap[s].count).toFixed(1));
    const maxBar = Math.max(...barData, 1);

    // Canvas sizing (HiDPI)
    const wrap = canvas.parentElement;
    const dpr = window.devicePixelRatio || 1;
    const w = wrap.clientWidth;
    const h = wrap.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';

    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    // Chart area
    const padL = 36, padR = 16, padT = 20, padB = 40;
    const chartW = w - padL - padR;
    const chartH = h - padT - padB;

    // Draw Y axis (rating 1-5)
    ctx.font = '12px -apple-system, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillStyle = '#999';
    for (let i = 1; i <= 5; i++) {
        const y = padT + chartH - ((i - 1) / 4) * chartH;
        ctx.fillText(String(i), padL - 8, y + 4);
        // Grid line
        ctx.beginPath();
        ctx.strokeStyle = '#f0f0f0';
        ctx.moveTo(padL, y);
        ctx.lineTo(w - padR, y);
        ctx.stroke();
    }

    // Bar params
    const n = semesters.length;
    const barGapRatio = Math.min(0.4, 0.6 / Math.max(n, 2)); // more gap when few items
    const barW = Math.max(12, Math.min(60, chartW / n * (1 - barGapRatio)));
    const gap = (chartW - barW * n) / (n + 1);

    // Bars
    for (let i = 0; i < n; i++) {
        const x = padL + gap + i * (barW + gap);
        const barH = Math.max(0.01, (barData[i] / maxBar) * chartH);
        const y = padT + chartH - barH;

        // Draw bar with rounded top
        const radius = Math.min(3, barW / 4);
        ctx.fillStyle = '#91c4f2';
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
        ctx.textAlign = 'right';
        ctx.fillStyle = '#999';
        ctx.font = '11px -apple-system, sans-serif';
        const label = semesters[i];
        ctx.fillText(label.length > 14 ? label.slice(0, 13) : label, 0, 0);
        ctx.restore();
    }

    // Line (average rating)
    ctx.beginPath();
    ctx.strokeStyle = '#52c41a';
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
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
        ctx.fillStyle = '#fff';
        ctx.arc(cx, cy, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.strokeStyle = '#52c41a';
        ctx.lineWidth = 2;
        ctx.arc(cx, cy, 4, 0, Math.PI * 2);
        ctx.stroke();
    }

    // Tooltip on hover (simple approach)
    canvas._trendData = { semesters, barData, lineData, padL, padR, padT, padB, chartW, chartH, barW, gap, maxBar };

    canvas.onmousemove = function(e) {
        if (!canvas._trendData) return;
        const rect = canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const d = canvas._trendData;
        let hitIdx = -1;
        for (let i = 0; i < d.n; i++) {
            const bx = d.padL + d.gap + i * (d.barW + d.gap);
            if (mx >= bx && mx <= bx + d.barW) { hitIdx = i; break; }
            // Also check line dot proximity
            const cx = bx + d.barW / 2;
            const cy = d.padT + d.chartH - ((d.lineData[i] - 1) / 4) * d.chartH;
            if (Math.abs(mx - cx) < 15 && Math.abs(my - cy) < 15) { hitIdx = i; break; }
        }
        
        const tip = document.getElementById('trend-tooltip') || createTooltip();
        if (hitIdx >= 0 && hitIdx < d.semesters.length) {
            tip.style.display = 'block';
            tip.style.left = (rect.left + mx + 12) + 'px';
            tip.style.top = (rect.top + my - 10) + 'px';
            tip.innerHTML = `<strong>${d.semesters[hitIdx]}</strong><br/>点评数：${d.barData[hitIdx]}<br/>平均分：${d.lineData[hitIdx]}`;
        } else {
            tip.style.display = 'none';
        }
    };
    canvas.onmouseleave = function() {
        const tip = document.getElementById('trend-tooltip');
        if (tip) tip.style.display = 'none';
    };
}

function createTooltip() {
    const el = document.createElement('div');
    el.id = 'trend-tooltip';
    el.cssText = '';
    el.style.cssText = `position:fixed;display:none;z-index:10000;padding:6px 10px;background:rgba(0,0,0,0.75);color:#fff;font-size:12px;border-radius:4px;pointer-events:none;white-space:nowrap;line-height:1.7;`;
    document.body.appendChild(el);
    return el;
}

function drawEmptyChart(canvas) {
    const wrap = canvas.parentElement;
    const dpr = window.devicePixelRatio || 1;
    const w = wrap.clientWidth;
    const h = wrap.clientHeight;
    canvas.width = w * dpr; canvas.height = h * dpr;
    canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.font = '14px -apple-system, sans-serif';
    ctx.fillStyle = '#999';
    ctx.textAlign = 'center';
    ctx.fillText('暂无足够数据展示趋势', w / 2, h / 2);
}

// ==================== SEARCH PAGE ====================
let searchResults = [];

async function initSearchPage() {
    const params = new URLSearchParams(location.search);
    const kw = params.get('keyword') || '';
    $('search-keyword-input').value = kw;
    await loadAllCourses();
    if (!Object.keys(viewsSummary).length) {
        viewsSummary = await loadStatic('views_summary', 'views_summary.json');
    }
    doSearchInternal(kw);
}

function doSearch() { doSearchInternal($('search-keyword-input').value.trim()); }

function doSearchFromCheckbox() {
    doSearchInternal($('search-keyword-input').value.trim());
}

function doSearchInternal(keyword) {
    const onlyReviewed = $('search-only-reviewed')?.checked;
    const revIds = new Set(Object.keys(viewsSummary));

    let results;
    if (!keyword && !onlyReviewed) {
        results = [...coursesAll];
    } else {
        const lower = (keyword || '').toLowerCase();
        results = coursesAll.filter(c => {
            if (keyword && !(c.name?.toLowerCase().includes(lower) || c.teacher?.toLowerCase().includes(lower) || c.department?.toLowerCase().includes(lower))) return false;
            if (onlyReviewed && !revIds.has(String(c.id))) return false;
            return true;
        });
    }

    results.sort((a, b) => (viewsSummary[String(b.id)]?.c || 0) - (viewsSummary[String(a.id)]?.c || 0));
    searchResults = results;
    searchState.page = 1;
    renderSearchList();
}

function renderSearchList() {
    const wrap = $('search-results'), countEl = $('result-count');
    if (!wrap || !countEl) return;
    const total = searchResults.length;
    countEl.textContent = total;
    if (!total) { wrap.innerHTML = '<div class="empty-tip">未找到匹配的课程</div>'; $('search-pagination').innerHTML = ''; return; }

    const { page, size } = searchState;
    const paged = getPaged(searchResults, page, size);
    const frag = document.createDocumentFragment();

    paged.forEach(c => {
        const vs = viewsSummary[String(c.id)];
        const avg = vs ? vs.a : '-';
        const count = vs ? vs.c : 0;
        const div = document.createElement('div');
        div.className = 'search-result-item';
        div.innerHTML = `<div class="search-result-info"><h3><a href="course.html?id=${c.id}">${c.name}<span style="font-weight:400;color:#8a4abf;margin-left:4px;">（${c.teacher}）</span></a></h3><div class="search-result-dept">${c.department}</div></div><div class="search-result-score"><div class="search-score-num">${avg}</div><div class="search-score-count">${count}人评价</div></div>`;
        frag.appendChild(div);
    });

    wrap.innerHTML = '';
    wrap.appendChild(frag);
    renderPagination({ containerId: 'search-pagination', totalItems: total, currentPage: page, pageSize: size,
        onPageChange: (np, ns) => { searchState.page = np; searchState.size = ns; renderSearchList(); } });
}

// ==================== STATISTICS PAGE ====================
async function initStatPage() {
    if (!Object.keys(viewsSummary).length) {
        viewsSummary = await loadStatic('views_summary', 'views_summary.json');
    }
    const totalReview = manifest ? manifest.total_reviews : 0;
    const totalCourse = manifest ? manifest.total_courses : 0;
    const reviewedCount = Object.keys(viewsSummary).length;

    const a = $('stat-review-total'), b = $('stat-course-total'), c = $('stat-course-reviewed');
    if (a) a.textContent = totalReview;
    if (b) b.textContent = totalCourse;
    if (c) c.textContent = reviewedCount;
}

// ==================== 新点评提交 ====================

async function submitReview(courseId, rating, comment, score) {
    const payload = {
        id: courseId,
        rating: rating,
        comment: comment,
        created_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
        score: score,
    };
    const encoded = btoa(JSON.stringify(payload));
    const res = await fetch('https://api.yourschool.cc.cd/comment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            content: encoded,
            encoding: 'base64',
            message: 'Add file via curl',
        }),
    });
    return res.json();
}

// 课程搜索（从 course_index 中搜索）
function searchCoursesFromIndex(query) {
    if (!query || query.length < 1) return [];
    const lower = query.toLowerCase();
    const results = [];
    for (const [cid, c] of Object.entries(courseIdx)) {
        if (c[2].toLowerCase().includes(lower) || c[1].toLowerCase().includes(lower)) {
            results.push({ id: parseInt(cid), dept: c[0], teacher: c[1], name: c[2] });
        }
        if (results.length >= 20) break;
    }
    return results;
}

function showReviewForm(courseId, courseName) {
    // 移除已有的表单
    const existing = document.getElementById('review-form-overlay');
    if (existing) existing.remove();

    const needsCourseSelect = !courseId;

    const overlay = document.createElement('div');
    overlay.id = 'review-form-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9998;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.45);';
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

    const form = document.createElement('div');
    form.className = 'review-form-modal';
    form.style.cssText = 'position:relative;background:#fff;border-radius:10px;box-shadow:0 8px 40px rgba(0,0,0,0.15);width:min(720px,calc(100vw-32px));max-height:calc(100vh-48px);display:flex;flex-direction:column;';
    form.onclick = (e) => e.stopPropagation();

    const titleHtml = needsCourseSelect
        ? `<span style="font-size:16px;font-weight:600;">新点评</span>`
        : `<span style="font-size:16px;font-weight:600;">新点评 - ${courseName}</span>`;

    const courseSearchHtml = needsCourseSelect ? `
        <div style="margin-bottom:16px;">
            <label style="display:block;margin-bottom:6px;font-weight:500;">选择课程 <span style="color:#ff4d4f;">*</span></label>
            <div style="position:relative;">
                <input id="review-course-search" type="text" placeholder="输入课程名或教师名搜索..." style="width:100%;padding:6px 12px;border:1px solid #d9d9d9;border-radius:6px;font-size:14px;font-family:inherit;box-sizing:border-box;">
                <div id="review-course-dropdown" style="position:absolute;top:100%;left:0;right:0;z-index:10;background:#fff;border:1px solid #d9d9d9;border-radius:0 0 6px 6px;max-height:200px;overflow:auto;display:none;box-shadow:0 4px 12px rgba(0,0,0,0.1);"></div>
            </div>
            <input type="hidden" id="review-course-id" value="">
            <div id="review-course-selected" style="display:none;margin-top:6px;padding:4px 10px;background:#f0f5ff;border-radius:4px;font-size:13px;color:#1d39c4;"></div>
        </div>
    ` : '';

    form.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:space-between;padding:20px 28px 0;flex-shrink:0;">
            ${titleHtml}
            <button onclick="this.closest('#review-form-overlay').remove()" style="width:32px;height:32px;border:none;background:none;cursor:pointer;font-size:18px;color:#999;border-radius:50%;line-height:1;">&times;</button>
        </div>
        <div class="review-form-body" style="padding:20px 28px 28px;overflow:auto;flex:1;">
            ${courseSearchHtml}
            <div style="margin-bottom:16px;">
                <label style="display:block;margin-bottom:6px;font-weight:500;">详细点评 <span style="color:#ff4d4f;">*</span></label>
                <textarea id="review-comment" placeholder="请分享你对这门课的评价..." style="width:100%;min-height:160px;padding:10px 14px;border:1px solid #d9d9d9;border-radius:6px;font-size:14px;resize:vertical;line-height:1.7;font-family:inherit;box-sizing:border-box;">
考核方式：

授课质量与给分：

点评人：

上课学期：
                </textarea>
                <div style="margin-top:4px;color:#999;font-size:12px;line-height:1.6;">
                    理想的点评应当富有事实且对课程有全面的描述。比如课讲得好但是考核很严格，或者作业多但给分很高。<br>
                    二者都说出来更有利于同学们做出全面的选择和判断。<br>
                    避免滥用缩写、梗、隐晦等让其他读者难以理解的表达方式和内容。避免使用情绪化用语和冒犯性言论。
                </div>
            </div>
            <div style="display:flex;gap:16px;margin-bottom:16px;">
                <div style="flex:1;">
                    <label style="display:block;margin-bottom:6px;font-weight:500;">成绩（可选）</label>
                    <input id="review-score" placeholder="分数或等级，中期退课填W" style="width:100%;padding:8px 12px;border:1px solid #d9d9d9;border-radius:6px;font-size:14px;font-family:inherit;box-sizing:border-box;">
                </div>
            </div>
            <div style="display:flex;gap:12px;justify-content:flex-end;margin-top:8px;">
                <button onclick="this.closest('#review-form-overlay').remove()" style="padding:7px 20px;border:1px solid #d9d9d9;border-radius:6px;background:#fff;cursor:pointer;font-size:14px;">取消</button>
                <button id="submit-review-btn" style="padding:7px 24px;border:none;border-radius:6px;background:var(--primary-color);color:#fff;cursor:pointer;font-size:14px;font-weight:500;">提交</button>
            </div>
            <div id="review-form-error" style="margin-top:10px;color:#ff4d4f;font-size:13px;display:none;text-align:center;"></div>
            <div style="margin-top:12px;color:#999;font-size:12px;text-align:center;">提交点评表示您同意授权本网站使用点评的内容，并且了解本站的相关立场。</div>
        </div>
    `;

    overlay.appendChild(form);
    document.body.appendChild(overlay);

    // ---- Course search (if needed) ----
    if (needsCourseSelect) {
        const searchInput = form.querySelector('#review-course-search');
        const dropdown = form.querySelector('#review-course-dropdown');
        const hiddenId = form.querySelector('#review-course-id');
        const selectedDiv = form.querySelector('#review-course-selected');

        let searchTimer = null;
        searchInput.oninput = () => {
            clearTimeout(searchTimer);
            searchTimer = setTimeout(() => {
                const q = searchInput.value.trim();
                if (q.length < 1) { dropdown.style.display = 'none'; return; }
                const results = searchCoursesFromIndex(q);
                if (results.length === 0) {
                    dropdown.innerHTML = '<div style="padding:8px 12px;color:#999;font-size:13px;">未找到匹配课程</div>';
                } else {
                    const frag = document.createDocumentFragment();
                    results.forEach(r => {
                        const div = document.createElement('div');
                        div.style.cssText = 'padding:8px 12px;cursor:pointer;font-size:13px;border-bottom:1px solid #f0f0f0;';
                        div.innerHTML = `<span style="font-weight:500;">${r.name}</span><span style="color:#8a4abf;margin-left:4px;">（${r.teacher}）</span><span style="color:#999;margin-left:8px;">${r.dept}</span>`;
                        div.onmousedown = (e) => {
                            e.preventDefault();
                            hiddenId.value = r.id;
                            searchInput.value = `${r.name}（${r.teacher}）`;
                            selectedDiv.textContent = `${r.name}（${r.teacher}）- ${r.dept}`;
                            selectedDiv.style.display = 'block';
                            dropdown.style.display = 'none';
                        };
                        frag.appendChild(div);
                    });
                    dropdown.innerHTML = '';
                    dropdown.appendChild(frag);
                }
                dropdown.style.display = 'block';
            }, 200);
        };
        // Hide dropdown when clicking outside
        document.addEventListener('click', function hideDropdown(e) {
            if (!searchInput.contains(e.target) && !dropdown.contains(e.target)) {
                dropdown.style.display = 'none';
            }
        }, { once: false });
    }

    // ---- Star rating ----
    const stars = form.querySelectorAll('#rating-stars span');
    const ratingInput = form.querySelector('#review-rating-value');
    stars.forEach(star => {
        star.onmouseenter = () => {
            const v = parseInt(star.dataset.rating);
            stars.forEach((s, i) => s.style.color = i < v ? '#faad14' : '#e8e8e8');
        };
        star.onclick = () => {
            const v = parseInt(star.dataset.rating);
            ratingInput.value = v;
            stars.forEach((s, i) => s.style.color = i < v ? '#faad14' : '#e8e8e8');
        };
    });
    form.querySelector('#rating-stars').onmouseleave = () => {
        const v = parseInt(ratingInput.value) || 0;
        stars.forEach((s, i) => s.style.color = i < v ? '#faad14' : '#e8e8e8');
    };

    // ---- Submit ----
    form.querySelector('#submit-review-btn').onclick = async function() {
        const errEl = form.querySelector('#review-form-error');
        const finalCourseId = courseId || parseInt(form.querySelector('#review-course-id')?.value || '0');
        const rating = parseInt(ratingInput.value);
        const comment = form.querySelector('#review-comment').value.trim();
        const score = form.querySelector('#review-score').value.trim();

        if (!finalCourseId) {
            errEl.textContent = '请搜索并选择课程';
            errEl.style.display = 'block';
            return;
        }
        if (!rating || rating < 1 || rating > 5) {
            errEl.textContent = '请选择推荐指数（1-5星）';
            errEl.style.display = 'block';
            return;
        }
        if (!comment) {
            errEl.textContent = '请输入点评内容';
            errEl.style.display = 'block';
            return;
        }

        this.textContent = '提交中...';
        this.disabled = true;

        const result = await submitReview(finalCourseId, rating, comment, score);
        if (result.success) {
            overlay.remove();
            alert('点评提交成功！');
            location.reload();
        } else {
            errEl.textContent = result.error || '提交失败，请稍后重试';
            errEl.style.display = 'block';
            this.textContent = '提交点评';
            this.disabled = false;
        }
    };
}

// Bind click handlers to "新点评" buttons
function bindReviewButtons() {
    const btn1 = document.getElementById('new-review-btn');
    const btn2 = document.getElementById('new-review-btn-detail');

    if (btn1) {
        btn1.href = 'javascript:void(0)';
        btn1.onclick = async (e) => {
            e.preventDefault();
            // 首页：需要先加载 course_index
            if (!courseIdxLoaded) {
                const ciRaw = await loadStatic('course_index', 'course_index.json');
                courseIdx = ciRaw || {};
                courseIdxLoaded = true;
            }
            showReviewForm(null, '');
        };
    }
    if (btn2 && currentCourseDetail) {
        btn2.href = 'javascript:void(0)';
        btn2.onclick = (e) => {
            e.preventDefault();
            const c = currentCourseDetail.course;
            const cid = new URLSearchParams(location.search).get('id');
            showReviewForm(parseInt(cid), `${c[2]}（${c[1]}）`);
        };
    }
}

// Bind after page init
const origRoutePage = routePage;
routePage = async function() {
    await origRoutePage();
    bindReviewButtons();
};
