/* ================================================================
 * THU 选课社区 - Pages 静态托管 (重构版)
 *
 * 架构优化:
 *   - 模块化设计
 *   - 统一数据管理
 *   - 删除所有缓存机制
 *   - 减少重复代码
 * ================================================================ */

// 配置常量
const CONFIG = {
  API_BASE: "https://api.yourschool.cc.cd",
  RAW_BASE: "/data/",
  PAGE_SIZES: [10, 20, 50],
};

// 全局状态管理
const State = {
  manifest: null,
  courseIdx: {},
  latestReviews: [],
  coursesAll: [],
  searchIndexCache: null,
  fullIndexLoaded: false,
  coursesReviewOnly: false,

  // 页面状态
  states: {
    index: { page: 1, size: 10 },
    courses: { page: 1, size: 10 },
    search: { page: 1, size: 10 },
    detail: { page: 1, size: 5 },
  },

  filteredCourses: [],
  currentCourseDetail: null,

  // 获取页面状态
  getPageState(pageType) {
    return this.states[pageType] || this.states.index;
  },

  // 设置页面状态
  setPageState(pageType, updates) {
    if (this.states[pageType]) {
      Object.assign(this.states[pageType], updates);
    }
  },
};

// 工具函数库
const Utils = {
  // DOM 查询
  $: (id) => document.getElementById(id),
  qs: (sel) => document.querySelector(sel),

  // 分页工具
  getPaged(list, page, size) {
    return list.slice((page - 1) * size, page * size);
  },

  // 课程名称获取
  getCourseName(cid) {
    const c = State.courseIdx[String(cid)];
    return c ? `${c[2]}（${c[1]}）` : "未知课程";
  },

  // 括号标准化
  normalizeParens(s) {
    return s.replace(/\uff08/g, "(").replace(/\uff09/g, ")");
  },

  // 格式化时间
  getFormattedTime(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    return `${year}/${month}/${day} ${hours}:${minutes}`;
  },

  // UTF-8 安全的 Base64 编码
  utf8ToBase64(str) {
    const bytes = new TextEncoder().encode(str);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  },

  // 提取学期信息
  extractSemester(comment) {
    if (typeof comment !== "string") {
      return "";
    }
    const match = comment.match(/上课学期[：:]\s*(.+)/);
    return match ? match[1].trim() : "";
  },
};

// 数据加载器
const DataLoader = {
  // 加载 Manifest
  async loadManifest() {
    try {
      const res = await fetch(CONFIG.RAW_BASE + "manifest.json", {
        credentials: "omit",
      });
      State.manifest = await res.json();
    } catch (e) {
      console.error("Manifest load error", e);
    }
  },

  // 加载静态文件
  async loadStatic(key, filename, expectedType = null) {
    try {
      const res = await fetch(CONFIG.RAW_BASE + filename, {
        credentials: "omit",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${filename}`);
      const data = await res.json();
      return data;
    } catch (e) {
      console.error(`[loadStatic] Error loading ${filename}:`, e);
      return expectedType === "array" ? [] : null;
    }
  },

  // 加载所有课程
  async loadAllCourses(onlyReviewed) {
    if (State.coursesAll.length > 0 && State.coursesReviewOnly === onlyReviewed)
      return;

    try {
      let arr;

      if (onlyReviewed) {
        // 仅有点评：只需 with_comment_index.json（自带 count/avg）
        const res = await fetch(CONFIG.RAW_BASE + "with_comment_index.json", {
          credentials: "omit",
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        arr = [];
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
      } else {
        // 全部课程：同时加载 full_index（课程列表）和 with_comment_index（评分数据）
        const [fullRes, wcRes] = await Promise.all([
          fetch(CONFIG.RAW_BASE + "full_index.json", { credentials: "omit" }),
          fetch(CONFIG.RAW_BASE + "with_comment_index.json", { credentials: "omit" }),
        ]);
        if (!fullRes.ok) throw new Error(`HTTP ${fullRes.status}`);
        const fullData = await fullRes.json();
        // 构建 with_comment 的 sqid → {count, avg} 映射
        const wcMap = {};
        if (wcRes.ok) {
          const wcData = await wcRes.json();
          for (const info of Object.values(wcData.courses || {})) {
            if (info && info.sqid != null) {
              wcMap[info.sqid] = { count: info.count || 0, avg: info.avg || 0 };
            }
          }
        }
        arr = [];
        for (const [key, info] of Object.entries(fullData.courses || {})) {
          if (!info || typeof info !== "object") continue;
          const wc = wcMap[info.sqid];
          arr.push({
            kcm: info.kcm || "",
            jsm: info.jsm || "",
            kkdw: info.kkdw || "",
            count: wc ? wc.count : 0,
            avg: wc ? wc.avg : 0,
            sqid: info.sqid,
            tid: info.tid,
          });
        }
      }

      State.coursesAll = arr;
      State.coursesReviewOnly = onlyReviewed;
      State.fullIndexLoaded = true;
    } catch (e) {
      console.error("[loadAllCourses] Error:", e);
      State.coursesAll = [];
      State.coursesReviewOnly = onlyReviewed;
      State.fullIndexLoaded = true;
    }
  },

  // 加载搜索索引
  async loadSearchIndex(onlyReviewed) {
    try {
      if (onlyReviewed) {
        // 仅有点评：只需 with_comment_index.json
        const res = await fetch(CONFIG.RAW_BASE + "with_comment_index.json", {
          credentials: "omit",
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        State.searchIndexCache = await res.json();
      } else {
        // 全部课程：同时加载 full 和 with_comment，合并 count/avg 到 full 中
        const [fullRes, wcRes] = await Promise.all([
          fetch(CONFIG.RAW_BASE + "full_index.json", { credentials: "omit" }),
          fetch(CONFIG.RAW_BASE + "with_comment_index.json", { credentials: "omit" }),
        ]);
        if (!fullRes.ok) throw new Error(`HTTP ${fullRes.status}`);
        const fullData = await fullRes.json();
        // 构建 with_comment 的 sqid → {count, avg} 映射
        const wcMap = {};
        if (wcRes.ok) {
          const wcData = await wcRes.json();
          for (const info of Object.values(wcData.courses || {})) {
            if (info && info.sqid != null) {
              wcMap[info.sqid] = { count: info.count || 0, avg: info.avg || 0 };
            }
          }
        }
        // 将 count/avg 合并到 full 的每门课程中
        const mergedCourses = {};
        for (const [key, info] of Object.entries(fullData.courses || {})) {
          if (!info || typeof info !== "object") continue;
          const wc = wcMap[info.sqid];
          mergedCourses[key] = {
            ...info,
            count: wc ? wc.count : 0,
            avg: wc ? wc.avg : 0,
          };
        }
        State.searchIndexCache = { courses: mergedCourses };
      }
    } catch (e) {
      console.error("[loadSearchIndex] Error:", e);
      State.searchIndexCache = { courses: {} };
    }
  },

  // 加载课程详情
  async loadCourseDetail(sqid, tid) {
    let courseData = null;
    let teacherData = null;

    // 加载课程数据
    try {
      const res = await fetch(CONFIG.RAW_BASE + "courses/" + sqid + ".json", {
        credentials: "omit",
      });
      if (!res.ok) throw new Error("not found");
      courseData = await res.json();
    } catch (e) {
      console.error(`[loadCourseDetail] Error loading course ${sqid}:`, e);
    }

    // 加载教师数据
    if (tid) {
      try {
        const res = await fetch(CONFIG.RAW_BASE + "teachers/" + tid + ".json", {
          credentials: "omit",
        });
        if (res.ok) {
          teacherData = await res.json();
        }
      } catch (e) {
        console.error(`[loadCourseDetail] Error loading teacher ${tid}:`, e);
      }
    }

    return { courseData, teacherData };
  },
};

// 渲染引擎
const Renderer = {
  // 分页渲染
  renderPagination({
    containerId,
    totalItems,
    currentPage,
    pageSize,
    onPageChange,
  }) {
    const container = Utils.$(containerId);
    if (!container) return;

    if (totalItems === 0 || Math.ceil(totalItems / pageSize) <= 1) {
      container.innerHTML = "";
      return;
    }

    const totalPages = Math.ceil(totalItems / pageSize);
    const frag = document.createDocumentFragment();

    const mkBtn = (text, cb, disabled) => {
      const b = document.createElement("button");
      b.textContent = text;
      if (disabled) b.disabled = true;
      if (cb) b.onclick = cb;
      return b;
    };

    // 上一页
    frag.appendChild(
      mkBtn(
        "上一页",
        () => currentPage > 1 && onPageChange(currentPage - 1, pageSize),
        currentPage === 1,
      ),
    );

    // 页码
    const pages = [];
    pages.push(1);
    if (currentPage - 2 > 2) pages.push(-1);
    for (
      let i = Math.max(2, currentPage - 2);
      i <= Math.min(totalPages - 1, currentPage + 2);
      i++
    ) {
      pages.push(i);
    }
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

    // 下一页
    frag.appendChild(
      mkBtn(
        "下一页",
        () =>
          currentPage < totalPages && onPageChange(currentPage + 1, pageSize),
        currentPage === totalPages,
      ),
    );

    // 每页数量选择
    const sel = document.createElement("select");
    CONFIG.PAGE_SIZES.forEach((s) => {
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
  },

  // 渲染首页
  renderIndex() {
    const wrap = Utils.$("review-list");
    const totalEl = Utils.$("total-review-num");
    if (!wrap || !totalEl) return;

    // 合并服务端 latest reviews 与本地缓存
    const localReviews = LocalCache.getAllForLatest();
    const localMap = new Map();
    localReviews.forEach((r) => {
      // 用 course.id + rating + comment 前60字 做去重标识
      const key = `${r.course?.id || ""}_${r.rating}_${(r.comment || "").slice(0, 60)}`;
      localMap.set(key, r);
    });

    // 去重：服务端已有的不重复添加
    const serverReviews = State.latestReviews || [];
    const merged = [...localReviews];
    const serverKeys = new Set();
    serverReviews.forEach((r) => {
      const key = `${r.course?.id || ""}_${r.rating}_${(r.comment || "").slice(0, 60)}`;
      serverKeys.add(key);
    });
    // 只保留本地独有的
    const dedupedLocal = localReviews.filter((r) => {
      const key = `${r.course?.id || ""}_${r.rating}_${(r.comment || "").slice(0, 60)}`;
      return !serverKeys.has(key);
    });

    const allReviews = [...dedupedLocal, ...serverReviews];
    // 按时间/ID 排序：本地用 _local_ts，服务端用 id
    allReviews.sort((a, b) => {
      const aTime = a._local_ts || 0;
      const bTime = b._local_ts || 0;
      if (aTime && bTime) return bTime - aTime;
      if (aTime) return -1; // 本地优先
      if (bTime) return 1;
      return (b.id || 0) - (a.id || 0);
    });

    const total = allReviews.length;
    totalEl.textContent = State.manifest
      ? (State.manifest.total_reviews || 0) + dedupedLocal.length
      : total;

    if (!total) {
      wrap.innerHTML = '<div class="empty-tip">暂无点评内容</div>';
      Utils.$("review-pagination").innerHTML = "";
      return;
    }

    const { page, size } = State.getPageState("index");
    const paged = Utils.getPaged(allReviews, page, size);
    const frag = document.createDocumentFragment();

    paged.forEach((item) => {
      const name = item._course_name || `课程 #${(item.course || {}).id}`;
      const teacher = item._course_teacher || "";
      const courseName = teacher ? `${name}（${teacher}）` : name;
      const isLocal = !!item._local_id;
      const card = document.createElement("div");
      card.className = "review-card";
      const timeStr = item.modified_at || item.created_at || "";
      card.innerHTML = `
        <a href="/thucourse/course.html?sqid=${(item.course || {}).id}&name=${encodeURIComponent(name)}&teacher=${encodeURIComponent(teacher)}" class="review-course-link">${courseName}</a>
        <div class="review-rating-text">推荐指数：${item.rating}</div>
        <div class="review-comment">${item.comment || "无点评内容"}</div>
        <div class="review-meta"><span>${isLocal ? "本地" : "#" + item.id}</span><span>${timeStr}</span></div>
      `;
      frag.appendChild(card);
    });

    wrap.innerHTML = "";
    wrap.appendChild(frag);

    this.renderPagination({
      containerId: "review-pagination",
      totalItems: total,
      currentPage: page,
      pageSize: size,
      onPageChange: (np, ns) => {
        State.setPageState("index", { page: np, size: ns });
        this.renderIndex();
      },
    });
  },

  // 渲染课程列表
  renderCourseList() {
    const wrap = Utils.$("all-course-list");
    const totalEl = Utils.$("all-course-num");
    if (!wrap || !totalEl) return;

    const total = State.filteredCourses.length;
    totalEl.textContent = total;

    if (!total) {
      wrap.innerHTML = '<div class="empty-tip">暂无匹配课程</div>';
      Utils.$("course-pagination").innerHTML = "";
      return;
    }

    const { page, size } = State.getPageState("courses");
    const paged = Utils.getPaged(State.filteredCourses, page, size);
    const frag = document.createDocumentFragment();

    paged.forEach((c) => {
      const count = c.count || 0;
      const avg = count > 0 ? parseFloat(c.avg).toFixed(1) : "-";
      const div = document.createElement("div");
      div.className = "course-list-item";
      div.innerHTML = `
        <div class="course-info">
          <h3>
            <a href="/thucourse/course.html?sqid=${c.sqid}&tid=${c.tid}&name=${encodeURIComponent(c.kcm)}&teacher=${encodeURIComponent(c.jsm)}&dept=${encodeURIComponent(c.kkdw)}">
              ${c.kcm}<span style="font-weight:400;color:#8a4abf;margin-left:4px;">（${c.jsm}）</span>
            </a>
          </h3>
          <div class="course-dept-name">${c.kkdw}</div>
        </div>
        <div class="course-review-status">
          <div class="course-score-num">${avg}</div>
          <div class="course-score-count">${count}人评价</div>
        </div>
      `;
      frag.appendChild(div);
    });

    wrap.innerHTML = "";
    wrap.appendChild(frag);

    this.renderPagination({
      containerId: "course-pagination",
      totalItems: total,
      currentPage: page,
      pageSize: size,
      onPageChange: (np, ns) => {
        State.setPageState("courses", { page: np, size: ns });
        this.renderCourseList();
      },
    });
  },

  // 渲染课程详情
  renderCourseDetailReviews() {
    const wrap = Utils.$("course-review-list");
    if (!wrap || !State.currentCourseDetail) return;

    // 合并服务端 reviews 与本地缓存
    const sqid = State.currentCourseDetail.sqid;
    const localReviews = LocalCache.getReviewsForCourse(sqid);
    const serverReviews = State.currentCourseDetail.reviews || [];

    // 去重
    const serverKeys = new Set();
    serverReviews.forEach((r) => {
      const key = `${r.rating}_${(r.comment || "").slice(0, 60)}`;
      serverKeys.add(key);
    });
    const dedupedLocal = localReviews.filter((r) => {
      const key = `${r.rating}_${(r.comment || "").slice(0, 60)}`;
      return !serverKeys.has(key);
    });

    let list = [...dedupedLocal, ...serverReviews];

    const ratingFilter = Utils.$("rating-select")?.value;
    const semesterFilter = Utils.$("semester-select")?.value;

    if (ratingFilter) {
      list = list.filter((r) => String(r.rating) === ratingFilter);
    }
    if (semesterFilter) {
      list = list.filter(
        (r) => Utils.extractSemester(r.comment) === semesterFilter,
      );
    }

    const sortVal = Utils.$("sort-select")?.value || "newest";
    const dateKey = (r) => r.modified_at || r.created_at || "";

    if (sortVal === "newest") {
      list.sort((a, b) => {
        const aTime = a._local_ts || 0;
        const bTime = b._local_ts || 0;
        if (aTime && bTime) return bTime - aTime;
        if (aTime) return -1;
        if (bTime) return 1;
        return dateKey(b).localeCompare(dateKey(a));
      });
    } else if (sortVal === "oldest") {
      list.sort((a, b) => {
        const aTime = a._local_ts || 0;
        const bTime = b._local_ts || 0;
        if (aTime && bTime) return aTime - bTime;
        if (aTime) return -1;
        if (bTime) return 1;
        return dateKey(a).localeCompare(dateKey(b));
      });
    } else if (sortVal === "rating-high") {
      list.sort((a, b) => b.rating - a.rating);
    } else if (sortVal === "rating-low") {
      list.sort((a, b) => a.rating - b.rating);
    }

    // 更新总点评数（含本地缓存）
    const totalLocal = dedupedLocal.length;
    const reviewCountEl = Utils.$("review-count-title");
    if (reviewCountEl) {
      const svCount =
        State.currentCourseDetail.review_count || serverReviews.length;
      reviewCountEl.textContent = `点评（${svCount + totalLocal}条）`;
    }

    const total = list.length;
    if (!total) {
      wrap.innerHTML = '<div class="empty-tip">该筛选条件下暂无点评</div>';
      Utils.$("course-detail-pagination").innerHTML = "";
      return;
    }

    const { page, size } = State.getPageState("detail");
    const paged = Utils.getPaged(list, page, size);
    const frag = document.createDocumentFragment();

    paged.forEach((item) => {
      const isLocal = !!item._local_id;
      const div = document.createElement("div");
      div.className = "review-card";
      const timeStr = item.modified_at || item.created_at || "";
      div.innerHTML = `
        <div class="review-rating-text">推荐指数：${item.rating}${item.score ? " 成绩：" + item.score : ""}</div>
        <div class="review-comment" style="white-space:pre-line;">${item.comment || "无点评内容"}</div>
        <div class="review-meta"><span>${isLocal ? "本地" : "#" + item.id}</span><span>${timeStr}</span></div>
      `;
      frag.appendChild(div);
    });

    wrap.innerHTML = "";
    wrap.appendChild(frag);

    this.renderPagination({
      containerId: "course-detail-pagination",
      totalItems: total,
      currentPage: page,
      pageSize: size,
      onPageChange: (np, ns) => {
        State.setPageState("detail", { page: np, size: ns });
        this.renderCourseDetailReviews();
      },
    });
  },

  // 渲染搜索结果
  renderSearchList() {
    const wrap = Utils.$("search-results");
    const countEl = Utils.$("result-count");
    if (!wrap || !countEl) return;

    const total = State.searchResults?.length || 0;
    countEl.textContent = total;

    if (!total) {
      wrap.innerHTML = '<div class="empty-tip">未找到匹配的课程</div>';
      Utils.$("search-pagination").innerHTML = "";
      return;
    }

    const { page, size } = State.getPageState("search");
    const paged = Utils.getPaged(State.searchResults, page, size);
    const frag = document.createDocumentFragment();

    paged.forEach((c) => {
      const avg = c.count > 0 ? parseFloat(c.avg).toFixed(1) : "-";
      const count = c.count || 0;
      const div = document.createElement("div");
      div.className = "search-result-item";
      div.innerHTML = `
        <div class="search-result-info">
          <h3>
            <a href="/thucourse/course.html?sqid=${c.sqid}&tid=${c.tid}&name=${encodeURIComponent(c.kcm)}&teacher=${encodeURIComponent(c.jsm)}&dept=${encodeURIComponent(c.kkdw)}">
              ${c.kcm}<span style="font-weight:400;color:#8a4abf;margin-left:4px;">（${c.jsm}）</span>
            </a>
          </h3>
          <div class="search-result-dept">${c.kkdw}</div>
        </div>
        <div class="search-result-score">
          <div class="search-score-num">${avg}</div>
          <div class="search-score-count">${count}人评价</div>
        </div>
      `;
      frag.appendChild(div);
    });

    wrap.innerHTML = "";
    wrap.appendChild(frag);

    this.renderPagination({
      containerId: "search-pagination",
      totalItems: total,
      currentPage: page,
      pageSize: size,
      onPageChange: (np, ns) => {
        State.setPageState("search", { page: np, size: ns });
        this.renderSearchList();
      },
    });
  },
};

// 业务逻辑控制器
const Controller = {
  // 路由处理
  async routePage() {
    const path = location.pathname;
    const routeMap = {
      "/thucourse": "index",
      "/thucourse/index.html": "index",
      "/thucourse/index": "index",
      "/thucourse/courses.html": "courses",
      "/thucourse/courses": "courses",
      "/thucourse/statistics.html": "statistics",
      "/thucourse/statistics": "statistics",
      "/thucourse/course.html": "course",
      "/thucourse/course": "course",
      "/thucourse/search.html": "search",
      "/thucourse/search": "search",
    };

    const pageType = Object.entries(routeMap).find(
      ([pattern]) =>
        path.endsWith(pattern) ||
        (pattern === "/thucourse" && (path === "/thucourse" || path.endsWith("/thucourse"))),
    )?.[1];

    if (pageType) {
      await this.initPage(pageType);
    }
  },

  // 初始化页面
  async initPage(pageType) {
    switch (pageType) {
      case "index":
        await this.initIndexPage();
        break;
      case "courses":
        await this.initCoursesPage();
        break;
      case "statistics":
        await this.initStatPage();
        break;
      case "course":
        await this.initCourseDetail();
        break;
      case "search":
        await this.initSearchPage();
        break;
    }
  },

  // 初始化首页
  async initIndexPage() {
    State.latestReviews = await DataLoader.loadStatic(
      "latest_reviews",
      "reviews_latest.json",
      "array",
    );
    Renderer.renderIndex();
  },

  // 初始化课程列表页
  async initCoursesPage() {
    const onlyReviewed = Utils.$("filter-has-reviews")?.checked || false;
    await DataLoader.loadAllCourses(onlyReviewed);
    this.populateDeptFilter();
    State.filteredCourses = [...State.coursesAll];
    Renderer.renderCourseList();
  },

  // 初始化统计页（始终直接请求 with_comment_index.json）
  async initStatPage() {
    try {
      const res = await fetch(CONFIG.RAW_BASE + "with_comment_index.json", {
        credentials: "omit",
      });
      if (res.ok) {
        const data = await res.json();

        const totalReview = State.manifest?.total_reviews ?? 0;
        const totalCourse = State.manifest?.total_courses ?? 0;
        const reviewedCount = data.courses
          ? Object.values(data.courses).length
          : 0;

        this.updateStatElements(totalReview, totalCourse, reviewedCount);
        return;
      }
    } catch (e) {
      console.error("[initStatPage] Error:", e);
    }
  },

  // 更新统计元素
  updateStatElements(totalReview, totalCourse, reviewedCount) {
    const elements = [
      { id: "stat-review-total", value: totalReview },
      { id: "stat-course-total", value: totalCourse },
      { id: "stat-course-reviewed", value: reviewedCount },
    ];

    elements.forEach(({ id, value }) => {
      const el = Utils.$(id);
      if (el) el.textContent = value;
    });
  },

  // 初始化课程详情
  async initCourseDetail() {
    const params = new URLSearchParams(location.search);
    const sqid = params.get("sqid");
    let tid = params.get("tid") || null;
    let deptName = params.get("dept") || "";

    if (!sqid) {
      Utils.qs(".container").innerHTML =
        '<div class="empty-tip">缺少课程参数</div>';
      return;
    }

    // 如果 URL 缺少 tid 或 dept，从索引中查找补全
    if (!tid || !deptName) {
      const idxInfo = await this.lookupFromIndex(sqid);
      if (idxInfo) {
        if (!tid) tid = idxInfo.tid;
        if (!deptName) deptName = idxInfo.kkdw || "";
      }
    }

    const { courseData, teacherData } = await DataLoader.loadCourseDetail(
      sqid,
      tid,
    );

    // 处理课程数据
    const reviews = courseData?.results || [];
    const reviewCount = courseData?.count || reviews.length;

    // 获取基本信息
    let courseName = params.get("name") || "";
    let teacherName = params.get("teacher") || "";

    if (teacherData && !teacherName) {
      teacherName = teacherData.name || "";
    }
    if (!courseName) courseName = "未知课程";
    if (!teacherName) teacherName = "未知教师";

    // 计算平均分
    let avgRating = 0;
    if (reviews.length > 0) {
      const total = reviews.reduce((sum, r) => sum + (r.rating || 0), 0);
      avgRating = (total / reviews.length).toFixed(1);
    }

    // 构建课程详情对象
    State.currentCourseDetail = {
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

    // 渲染页面
    this.renderCourseDetailPage(
      courseName,
      teacherName,
      deptName,
      reviewCount,
      avgRating,
      teacherData,
      tid,
    );
    Renderer.renderCourseDetailReviews();
  },

  // 从 with_comment_index 查找课程的 tid 和院系
  async lookupFromIndex(sqid) {
    try {
      const res = await fetch(CONFIG.RAW_BASE + "with_comment_index.json", {
        credentials: "omit",
      });
      if (res.ok) {
        const ciRaw = await res.json();
        if (ciRaw?.courses) {
          for (const info of Object.values(ciRaw.courses)) {
            if (info && String(info.sqid) === String(sqid)) {
              return { tid: info.tid, kkdw: info.kkdw || "" };
            }
          }
        }
      }
    } catch (e) {
      /* 静默失败 */
    }
    return null;
  },

  // 渲染课程详情页面
  renderCourseDetailPage(
    courseName,
    teacherName,
    deptName,
    reviewCount,
    avgRating,
    teacherData,
    tid,
  ) {
    const dept = deptName,
      teacher = teacherName,
      name = courseName;

    // Page title
    const titleEl = Utils.$("detail-page-title");
    if (titleEl) titleEl.textContent = `${name}（${teacher}）`;

    // Info card
    const elements = [
      { id: "cd-name", value: name },
      { id: "cd-teacher", value: teacher },
      { id: "cd-dept", value: this.getDeptDisplay(dept, teacherData) },
      {
        id: "cd-rating",
        value: reviewCount
          ? `${avgRating}（${reviewCount}人评价）`
          : "暂无评价",
      },
    ];

    elements.forEach(({ id, value }) => {
      const el = Utils.$(id);
      if (el) el.textContent = value;
    });

    // Review title
    const reviewTitleEl = Utils.$("review-count-title");
    if (reviewTitleEl) reviewTitleEl.textContent = `点评（${reviewCount}条）`;

    // Teacher's other courses
    this.renderTeacherCourses(teacherData, teacher, tid);

    // Semester select
    this.renderSemesterSelect();

    // 新点评按钮
    this.setupNewReviewButton(
      courseName,
      teacherName,
      State.currentCourseDetail.sqid,
    );
  },

  // 获取院系显示文本
  getDeptDisplay(dept, teacherData) {
    if (dept) return dept;
    if (teacherData?.related_courses?.length > 0) return "（未知院系）";
    return "（未知院系）";
  },

  // 渲染教师其他课程
  renderTeacherCourses(teacherData, teacher, tid) {
    const tcs = teacherData?.related_courses || [];
    const tcCard = Utils.$("teacher-courses-card");
    const tcList = Utils.$("teacher-courses-list");
    const tcTitle = Utils.$("teacher-courses-title");

    if (tcCard && tcList && tcTitle) {
      if (tcs.length > 0) {
        tcCard.style.display = "block";
        tcTitle.textContent = `${teacher}的其他课`;
        const frag = document.createDocumentFragment();
        tcs.slice(0, 15).forEach((tc) => {
          const li = document.createElement("li");
          const tcTid = tid || "";
          li.innerHTML = `
            <a href="course.html?sqid=${tc.id}&tid=${tcTid}&name=${encodeURIComponent(tc.name)}&teacher=${encodeURIComponent(teacher)}">
              ${tc.name}
            </a>
            ${tc.count > 0 ? `<span class="teacher-course-score">（${parseFloat(tc.avg).toFixed(1)}，${tc.count}人）</span>` : ""}
          `;
          frag.appendChild(li);
        });
        tcList.innerHTML = "";
        tcList.appendChild(frag);
      } else {
        tcCard.style.display = "block";
        tcTitle.textContent = `${teacher}的其他课`;
        tcList.innerHTML =
          '<li style="color:#999;font-size:13px;">暂无点评</li>';
      }
    }
  },

  // 渲染学期选择
  renderSemesterSelect() {
    const reviews = State.currentCourseDetail?.reviews || [];
    const semesters = [...new Set(reviews.map(Utils.extractSemester))].filter(
      Boolean,
    );
    const semSel = Utils.$("semester-select");

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
  },

  // 设置新点评按钮
  setupNewReviewButton(courseName, teacherName, sqid) {
    const newReviewBtn = Utils.$("new-review-btn-detail");
    if (newReviewBtn && State.currentCourseDetail) {
      const courseDisplayName = `${courseName}（${teacherName}）`;
      const url = `/thucourse/new-review.html?courseId=${encodeURIComponent(sqid)}&courseName=${encodeURIComponent(courseDisplayName)}`;
      newReviewBtn.href = url;
    }
  },

  // 初始化搜索页
  async initSearchPage() {
    const params = new URLSearchParams(location.search);
    const kw = params.get("keyword") || "";
    Utils.$("search-keyword-input").value = kw;
    const onlyReviewed = Utils.$("search-only-reviewed")?.checked;
    await DataLoader.loadSearchIndex(onlyReviewed);
    this.doSearchInternal(kw);
  },

  // 执行搜索
  doSearchInternal(keyword) {
    if (!State.searchIndexCache?.courses) {
      State.searchResults = [];
      State.setPageState("search", { page: 1 });
      Renderer.renderSearchList();
      return;
    }

    const onlyReviewed = Utils.$("search-only-reviewed")?.checked;
    const lower = Utils.normalizeParens(keyword || "").toLowerCase();
    const courses = State.searchIndexCache.courses;
    const results = [];

    for (const [key, info] of Object.entries(courses)) {
      if (!info || typeof info !== "object") continue;

      if (keyword) {
        const normKey = Utils.normalizeParens(key).toLowerCase();
        if (!normKey.includes(lower)) continue;
      }

      if (onlyReviewed && (info.count || 0) === 0) continue;

      results.push({
        kcm: info.kcm,
        jsm: info.jsm,
        kkdw: info.kkdw,
        count: info.count || 0,
        avg: info.avg || 0,
        sqid: info.sqid,
        tid: info.tid,
      });
    }

    results.sort((a, b) => b.count - a.count);
    State.searchResults = results;
    State.setPageState("search", { page: 1 });
    Renderer.renderSearchList();
  },

  // 应用过滤器
  async applyFilters() {
    const onlyReviewed = Utils.$("filter-has-reviews")?.checked || false;
    const modeChanged = onlyReviewed !== State.coursesReviewOnly;

    if (modeChanged) {
      State.coursesAll = [];
    }

    await DataLoader.loadAllCourses(onlyReviewed);

    // 保存并恢复院系选择
    let savedDepts = [];
    if (modeChanged) {
      savedDepts = Array.from(
        document.querySelectorAll(".dept-check:checked"),
      ).map((cb) => cb.value);
      this.populateDeptFilter();
      document.querySelectorAll(".dept-check").forEach((cb) => {
        if (savedDepts.includes(cb.value)) cb.checked = true;
      });
    }

    // 应用院系过滤
    const checkedDepts = Array.from(
      document.querySelectorAll(".dept-check:checked"),
    ).map((cb) => cb.value);
    let result = [...State.coursesAll];
    if (checkedDepts.length > 0) {
      const s = new Set(checkedDepts);
      result = result.filter((c) => s.has(c.kkdw));
    }

    State.filteredCourses = result;
    State.setPageState("courses", { page: 1 });
    Renderer.renderCourseList();
  },

  // 填充院系过滤器
  populateDeptFilter() {
    const container = Utils.$("filter-dept");
    if (!container) return;

    const stats = this.getDeptStats();
    const sorted = Object.entries(stats).sort(
      (a, b) => b[1].count - a[1].count,
    );
    const frag = document.createDocumentFragment();

    sorted.forEach(([dept, info]) => {
      const l = document.createElement("label");
      l.className = "filter-option";
      l.innerHTML = `
        <input type="checkbox" value="${dept}" class="dept-check">
        <span class="filter-option-label">${dept}</span>
        <span class="filter-option-count">${info.count}</span>
      `;
      frag.appendChild(l);
    });

    container.innerHTML = "";
    container.appendChild(frag);
  },

  // 获取院系统计
  getDeptStats() {
    const stats = {};
    for (const c of State.coursesAll) {
      const d = c.kkdw || "未知院系";
      if (!stats[d]) stats[d] = { count: 0, reviewed: 0 };
      stats[d].count++;
      if (c.count > 0) stats[d].reviewed++;
    }
    return stats;
  },

  // 切换过滤器组
  toggleFilterGroup(el) {
    const target = Utils.$(el.dataset.target);
    const arrow = el.querySelector(".arrow");
    if (target) {
      target.classList.toggle("show");
      arrow.classList.toggle("open");
    }
  },

  // 搜索课程（用于新点评页面，搜索字段与 doSearchInternal 一致，保留下拉交互限制）
  searchCoursesFromIndex(query) {
    if (!query || query.length < 1) return [];
    if (!State.searchIndexCache?.courses) return [];

    const lower = Utils.normalizeParens(query).toLowerCase();
    const results = [];
    const courses = State.searchIndexCache.courses;

    for (const [key, info] of Object.entries(courses)) {
      if (!info || typeof info !== "object") continue;

      // 搜索字段与搜索页一致：匹配索引 key
      const normKey = Utils.normalizeParens(key).toLowerCase();
      if (!normKey.includes(lower)) continue;

      results.push({
        sqid: info.sqid,
        name: info.kcm || "",
        teacher: info.jsm || "",
        dept: info.kkdw || "",
        count: info.count || 0,
      });

      if (results.length >= 20) break;
    }

    results.sort((a, b) => (b.count || 0) - (a.count || 0));
    return results;
  },
};

// Loading 弹窗模块
const LoadingModal = {
  show() {
    const modal = Utils.$("submit-loading-modal");
    if (modal) modal.style.display = "flex";
  },
  hide() {
    const modal = Utils.$("submit-loading-modal");
    if (modal) modal.style.display = "none";
  },
  showResult(success, message) {
    this.hide();
    const modal = Utils.$("submit-result-modal");
    const icon = Utils.$("submit-result-icon");
    const title = Utils.$("submit-result-title");
    const msg = Utils.$("submit-result-msg");
    const btn = Utils.$("submit-result-close-btn");

    if (!modal) return;

    if (success) {
      icon.textContent = "✅";
      title.textContent = "提交成功";
      msg.textContent = message || "点评已成功提交！";
    } else {
      icon.textContent = "❌";
      title.textContent = "提交失败";
      msg.textContent = message || "提交失败，请稍后重试";
    }

    modal.style.display = "flex";

    // 绑定关闭按钮
    btn.onclick = () => {
      modal.style.display = "none";
      if (success) {
        window.location.href = "/thucourse/index.html";
      }
    };

    // 点击背景关闭
    modal.onclick = (e) => {
      if (e.target === modal) {
        modal.style.display = "none";
        if (success) {
          window.location.href = "/thucourse/index.html";
        }
      }
    };
  },
};

// 本地缓存模块 — 将提交的点评存入 localStorage，在页面渲染时整合显示
const LocalCache = {
  STORAGE_KEY: "local_reviews",
  _counter: null,

  _load() {
    try {
      const raw = localStorage.getItem(this.STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      return [];
    }
  },

  _save(reviews) {
    try {
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(reviews));
    } catch (e) {
      console.error("[LocalCache] Failed to save:", e);
    }
  },

  _nextLocalId() {
    const reviews = this._load();
    return reviews.length > 0
      ? Math.max(...reviews.map((r) => r._local_id || 0)) + 1
      : 1;
  },

  /** 添加一条新点评到本地缓存 */
  addReview(courseId, rating, comment, score, courseName, courseTeacher) {
    const review = {
      _local_id: this._nextLocalId(),
      course: { id: courseId },
      rating: rating,
      comment: comment,
      created_at: Utils.getFormattedTime(),
      score: score || null,
      _course_name: courseName || "未知课程",
      _course_teacher: courseTeacher || "未知教师",
      _local_ts: Date.now(),
    };

    const reviews = this._load();
    reviews.unshift(review); // 最新在前

    // 最多保留 200 条本地缓存
    if (reviews.length > 200) reviews.length = 200;

    this._save(reviews);
    return review;
  },

  /** 获取全部本地缓存的点评（用于首页最新列表） */
  getAllForLatest() {
    return this._load();
  },

  /** 获取某门课程的本地点评 */
  getReviewsForCourse(sqid) {
    return this._load().filter((r) => String(r.course.id) === String(sqid));
  },

  /** 获取某门课程的本地点评数量 */
  getCountForCourse(sqid) {
    return this.getReviewsForCourse(sqid).length;
  },
};

// 点评提交功能
const ReviewSubmitter = {
  async submitReview(courseId, rating, comment, score) {
    try {
      const content = {
        id: courseId,
        rating: rating,
        comment: comment,
        created_at: Utils.getFormattedTime(),
        score: score || null,
      };

      const res = await fetch(`${CONFIG.API_BASE}/comment`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: Utils.utf8ToBase64(JSON.stringify(content)),
          encoding: "base64",
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "提交失败");
      return { success: true, data };
    } catch (e) {
      const msg = e.message;
      if (msg === "Failed to fetch") {
        return { success: false, error: "后端服务暂时不可用，请稍后重试" };
      }
      return { success: false, error: msg };
    }
  },
};

// 趋势图功能
const TrendChart = {
  toggleTrend() {
    if (!State.currentCourseDetail) return;
    const modal = Utils.$("trend-modal");
    const titleEl = Utils.$("trend-title");

    const name = State.currentCourseDetail.course_name || "";
    const teacher = State.currentCourseDetail.course_teacher || "";
    titleEl.textContent = `${name}（${teacher}）的点评趋势`;
    modal.classList.add("show");

    requestAnimationFrame(() => {
      this.renderTrendChart(State.currentCourseDetail.reviews || []);
    });
  },

  closeTrend(e) {
    if (e && e.target !== e.currentTarget) return;
    const modal = Utils.$("trend-modal");
    if (modal) modal.classList.remove("show");
  },

  renderTrendChart(reviews) {
    const canvas = Utils.$("trend-chart-canvas");
    if (!canvas || !reviews.length) return;

    // 聚合数据
    const semMap = {};
    reviews.forEach((r) => {
      const sem = Utils.extractSemester(r.comment);
      if (!sem) return;
      if (!semMap[sem]) semMap[sem] = { count: 0, total: 0 };
      semMap[sem].count++;
      semMap[sem].total += r.rating;
    });

    const semesters = Object.keys(semMap).sort();
    if (semesters.length === 0) {
      this.drawEmptyChart(canvas);
      return;
    }

    // 准备数据
    const barData = semesters.map((s) => semMap[s].count);
    const lineData = semesters.map(
      (s) => +(semMap[s].total / semMap[s].count).toFixed(1),
    );
    const maxBar = Math.max(...barData, 1);

    // 设置画布
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

    // 绘制图表
    this.drawChart(ctx, w, h, semesters, barData, lineData, maxBar);

    // 设置悬停提示
    this.setupTooltip(canvas, semesters, barData, lineData, w, h, maxBar);
  },

  drawChart(ctx, w, h, semesters, barData, lineData, maxBar) {
    const padL = 36,
      padR = 16,
      padT = 20,
      padB = 40;
    const chartW = w - padL - padR;
    const chartH = h - padT - padB;

    // Y轴 (评分 1-5)
    ctx.font = "12px -apple-system, sans-serif";
    ctx.textAlign = "right";
    ctx.fillStyle = "#999";
    for (let i = 1; i <= 5; i++) {
      const y = padT + chartH - ((i - 1) / 4) * chartH;
      ctx.fillText(String(i), padL - 8, y + 4);
      ctx.beginPath();
      ctx.strokeStyle = "#f0f0f0";
      ctx.moveTo(padL, y);
      ctx.lineTo(w - padR, y);
      ctx.stroke();
    }

    // 柱状图
    const n = semesters.length;
    const barGapRatio = Math.min(0.4, 0.6 / Math.max(n, 2));
    const barW = Math.max(12, Math.min(60, (chartW / n) * (1 - barGapRatio)));
    const gap = (chartW - barW * n) / (n + 1);

    for (let i = 0; i < n; i++) {
      const x = padL + gap + i * (barW + gap);
      const barH = Math.max(0.01, (barData[i] / maxBar) * chartH);
      const y = padT + chartH - barH;

      // 圆角柱状图
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

      // X轴标签
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

    // 折线图 (平均评分)
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

    // 折线图点
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
  },

  setupTooltip(canvas, semesters, barData, lineData, w, h, maxBar) {
    const padL = 36,
      padR = 16,
      padT = 20,
      padB = 40;
    const chartW = w - padL - padR;
    const n = semesters.length;
    const barGapRatio = Math.min(0.4, 0.6 / Math.max(n, 2));
    const barW = Math.max(12, Math.min(60, (chartW / n) * (1 - barGapRatio)));
    const gap = (chartW - barW * n) / (n + 1);

    canvas._trendData = {
      semesters,
      barData,
      lineData,
      padL,
      padR,
      padT,
      padB,
      chartW,
      h,
      barW,
      gap,
      maxBar,
      n,
    };

    canvas.onmousemove = (e) => {
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
        const cx = bx + d.barW / 2;
        const cy = d.padT + d.chartH - ((d.lineData[i] - 1) / 4) * d.chartH;
        if (Math.abs(mx - cx) < 15 && Math.abs(my - cy) < 15) {
          hitIdx = i;
          break;
        }
      }

      const tip = this.getOrCreateTooltip();
      if (hitIdx >= 0 && hitIdx < d.semesters.length) {
        tip.style.display = "block";
        tip.style.left = rect.left + mx + 12 + "px";
        tip.style.top = rect.top + my - 10 + "px";
        tip.innerHTML = `<strong>${d.semesters[hitIdx]}</strong><br/>点评数：${d.barData[hitIdx]}<br/>平均分：${d.lineData[hitIdx]}`;
      } else {
        tip.style.display = "none";
      }
    };

    canvas.onmouseleave = () => {
      const tip = this.getOrCreateTooltip();
      tip.style.display = "none";
    };
  },

  getOrCreateTooltip() {
    let tip = Utils.$("trend-tooltip");
    if (!tip) {
      tip = document.createElement("div");
      tip.id = "trend-tooltip";
      tip.style.cssText = `position:fixed;display:none;z-index:10000;padding:6px 10px;background:rgba(0,0,0,0.75);color:#fff;font-size:12px;border-radius:4px;pointer-events:none;white-space:nowrap;line-height:1.7;`;
      document.body.appendChild(tip);
    }
    return tip;
  },

  drawEmptyChart(canvas) {
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
  },
};

// 新点评页面初始化
function initNewReviewPage() {
  const path = window.location.pathname;
  if (!path.endsWith("new-review.html") && !path.endsWith("new-review")) return;

  // 工具函数
  function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  function showError(msg) {
    const errEl = Utils.$("review-form-error");
    if (errEl) {
      errEl.textContent = msg;
      errEl.style.display = "block";
      setTimeout(() => (errEl.style.display = "none"), 5000);
    }
  }

  // 解析URL参数
  const urlParams = new URLSearchParams(window.location.search);
  const courseIdParam = urlParams.get("courseId");
  const courseNameParam = urlParams.get("courseName");

  const courseSelectSection = Utils.$("course-select-section");
  const reviewCourseId = Utils.$("review-course-id");
  const reviewFormTitle = Utils.$("review-form-title");

  if (courseIdParam && courseNameParam) {
    if (courseSelectSection) courseSelectSection.style.display = "none";
    if (reviewCourseId) reviewCourseId.value = courseIdParam;
    if (reviewFormTitle) {
      reviewFormTitle.textContent =
        "新点评 - " + decodeURIComponent(courseNameParam);
    }
  } else if (courseSelectSection) {
    courseSelectSection.style.display = "block";
  }

  // 星级评分交互
  const stars = document.querySelectorAll("#rating-stars span");
  const ratingInput = Utils.$("review-rating-value");
  const ratingLabel = Utils.$("rating-value-label");

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

  // 课程搜索
  if (courseIdParam == null) {
    const searchInput = Utils.$("review-course-search");
    const dropdown = Utils.$("review-course-dropdown");
    const selectedDiv = Utils.$("review-course-selected");

    // 加载搜索索引（与搜索页一致，默认加载全量课程索引）
    DataLoader.loadSearchIndex(false).catch((err) => {
      console.error("Failed to load search index:", err);
      showError("课程列表加载失败，请刷新重试");
    });

    let searchTimer = null;
    searchInput.addEventListener("input", () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(async () => {
        const q = searchInput.value.trim();
        if (q.length < 1) {
          dropdown.style.display = "none";
          return;
        }

        if (!State.searchIndexCache?.courses) {
          dropdown.innerHTML =
            '<div style="padding:8px 12px;color:#999;font-size:13px;">正在加载...</div>';
          dropdown.style.display = "block";
          return;
        }

        const results = Controller.searchCoursesFromIndex(q);
        if (results.length === 0) {
          dropdown.innerHTML =
            '<div style="padding:8px 12px;color:#999;font-size:13px;">未找到匹配课程</div>';
        } else {
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

    // 选择课程
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

  // 表单提交
  Utils.$("review-submit-btn").addEventListener("click", async () => {
    const courseId = parseInt(reviewCourseId.value);
    const rating = parseInt(ratingInput.value);
    const comment = Utils.$("review-comment").value.trim();
    const score = Utils.$("review-score").value.trim();

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

    // 显示 loading 弹窗
    LoadingModal.show();

    try {
      const result = await ReviewSubmitter.submitReview(
        courseId,
        rating,
        comment,
        score,
      );
      if (result.success) {
        // 提取课程名称和教师（供本地缓存使用）
        let courseName = "";
        let courseTeacher = "";
        const selectedDiv = Utils.$("review-course-selected");
        if (selectedDiv && selectedDiv.style.display !== "none") {
          const text = selectedDiv.textContent || "";
          const match = text.match(/^(.+?)（(.+?)）/);
          if (match) {
            courseName = match[1];
            courseTeacher = match[2];
          }
        }
        if (!courseName && courseNameParam) {
          const decoded = decodeURIComponent(courseNameParam);
          const m = decoded.match(/^(.+?)（(.+?)）$/);
          if (m) {
            courseName = m[1];
            courseTeacher = m[2];
          } else {
            courseName = decoded;
          }
        }

        // 存入本地缓存
        LocalCache.addReview(
          courseId,
          rating,
          comment,
          score,
          courseName,
          courseTeacher,
        );

        LoadingModal.showResult(true, "点评已成功提交！稍后将跳转到首页。");
      } else {
        LoadingModal.showResult(false, result.error || "提交失败，请稍后重试");
      }
    } catch (err) {
      console.error(err);
      LoadingModal.showResult(false, "网络错误，请检查连接后重试");
    }
  });

  // 取消按钮
  Utils.$("review-cancel-btn").addEventListener("click", () => {
    if (confirm("确定要取消点评吗？")) {
      window.history.back();
    }
  });
}

// 页面初始化
document.addEventListener("DOMContentLoaded", async () => {
  await DataLoader.loadManifest();
  await Controller.routePage();
  initNewReviewPage();
});

// 全局事件绑定
document.addEventListener("click", (e) => {
  // 过滤器组切换 — 匹配 data-target 属性（HTML 中使用的属性名）
  const filterTitle = e.target.closest("[data-target]");
  if (filterTitle) {
    Controller.toggleFilterGroup(filterTitle);
  }

  // 趋势图相关
  if (e.target.id === "show-trend-btn") {
    TrendChart.toggleTrend();
  }
  if (e.target.id === "trend-modal") {
    TrendChart.closeTrend(e);
  }
});

// 搜索相关事件
document.addEventListener("DOMContentLoaded", () => {
  // 课程列表页过滤器 — "仅显示有点评的课程"
  const filterHasReviews = Utils.$("filter-has-reviews");
  if (filterHasReviews) {
    filterHasReviews.addEventListener("change", () =>
      Controller.applyFilters(),
    );
  }

  // 搜索页 — "仅显示有点评的课程" 复选框
  const searchOnlyReviewed = Utils.$("search-only-reviewed");
  const searchKeywordInput = Utils.$("search-keyword-input");
  if (searchOnlyReviewed) {
    searchOnlyReviewed.addEventListener("change", () => {
      State.searchIndexCache = null;
      DataLoader.loadSearchIndex(searchOnlyReviewed.checked).then(() => {
        Controller.doSearchInternal(searchKeywordInput?.value?.trim() || "");
      });
    });
  }

  // 课程详情页筛选
  const ratingSelect = Utils.$("rating-select");
  const semesterSelect = Utils.$("semester-select");
  const sortSelect = Utils.$("sort-select");

  if (ratingSelect || semesterSelect || sortSelect) {
    [ratingSelect, semesterSelect, sortSelect].forEach((select) => {
      if (select) {
        select.addEventListener("change", () =>
          Renderer.renderCourseDetailReviews(),
        );
      }
    });
  }
});

/* ================================================================
 * 全局函数暴露 — 供 HTML inline 事件处理器调用
 * HTML 中的 onclick/onsubmit 等需要全局作用域的函数
 * ================================================================ */

// 搜索页 — 表单提交 / 搜索按钮
window.doSearch = function () {
  const kw = Utils.$("search-keyword-input")?.value?.trim() || "";
  Controller.doSearchInternal(kw);
};

// 课程列表页 — 筛选确认按钮
window.applyFilters = function () {
  Controller.applyFilters();
};

// 课程列表页 — 筛选组折叠/展开
window.toggleFilterGroup = function (el) {
  Controller.toggleFilterGroup(el);
};
