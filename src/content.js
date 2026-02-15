const DISPUTE_KEYWORDS = [
  "pov",
  "neutral",
  "bias",
  "biais",
  "propaganda",
  "vandalisme",
  "controvers",
  "undid",
  "revert",
  "annulation"
];

const REVERT_KEYWORDS = ["revert", "undid", "rv", "rollback", "annulation"];

const MAX_META_REVISIONS = 300;
const WAR_WINDOW_DAYS = 90;
const CACHE_TTL_MS = 10 * 60 * 1000;
const API_MAX_RETRIES = 3;

let bannerEl;
const requestCache = new Map();

function t(key, substitutions) {
  const msg = chrome.i18n.getMessage(key, substitutions);
  return msg || key;
}

init().catch(() => {
  // Fail silently on unsupported pages.
});

async function init() {
  if (!isSupportedArticlePage()) return;

  const articleRoot = getArticleRoot();
  if (!articleRoot) return;

  injectBanner(articleRoot);
  await renderPageScore(articleRoot);
}

function isSupportedArticlePage() {
  if (!location.hostname.endsWith("wikipedia.org")) return false;
  if (!location.pathname.startsWith("/wiki/")) return false;

  const rawTitle = location.pathname.slice("/wiki/".length);
  if (!rawTitle) return false;

  const decodedTitle = decodeURIComponent(rawTitle);
  if (decodedTitle.includes(":")) return false;
  if (decodedTitle.includes("/")) return false;
  return true;
}

function getArticleRoot() {
  return document.querySelector("#mw-content-text .mw-parser-output") || null;
}

function injectBanner(articleRoot) {
  bannerEl = document.createElement("div");
  bannerEl.id = "wiki-transparency-banner";
  bannerEl.innerHTML = `<div class="wt-row"><span>${escapeHtml(t("bannerTitle"))}</span><span class="wt-meta">${escapeHtml(t("statusAnalyzing"))}</span></div>`;
  articleRoot.prepend(bannerEl);
}

async function renderPageScore(articleRoot) {
  try {
    const title = decodeURIComponent(location.pathname.replace("/wiki/", "")).replace(/_/g, " ");
    const [revisions, firstRevision, latestRevisions, totalEditsInfo, totalEditorsInfo, categories] = await Promise.all([
      fetchRevisionMeta(title, MAX_META_REVISIONS),
      fetchFirstRevision(title),
      fetchLatestRevisions(title, 3),
      fetchTotalEditCount(title),
      fetchTotalEditorCount(title),
      fetchPageCategories(title)
    ]);

    if (!revisions.length) {
      bannerEl.innerHTML = `<div class="wt-row"><span class="wt-meta">${escapeHtml(t("errorUnableScore"))}</span></div>`;
      return;
    }

    const analysis = analyzeRevisions(revisions, firstRevision, totalEditsInfo, totalEditorsInfo);
    const wordCount = getArticleWordCount(articleRoot);
    const qualityLabel = detectQualityLabel(categories);
    const riskLabel = analysis.risk === "low" ? t("riskLow") : analysis.risk === "medium" ? t("riskMedium") : t("riskHigh");
    const why = analysis.whyReason ? t("whyPrefix", [analysis.whyReason]) : "";

    bannerEl.innerHTML = [
      '<div class="wt-row">',
      `<span class="wt-score">${escapeHtml(t("labelConfidence", [String(analysis.score)]))}</span>`,
      `<span class="wt-risk ${analysis.risk}">${escapeHtml(riskLabel)}</span>`,
      `<span class="wt-meta">${analysis.summary}</span>`,
      "</div>",
      '<div class="wt-row">',
      `<span class="wt-meta">${escapeHtml(t("labelWords", [String(wordCount)]))}</span>`,
      `<span class="wt-meta">${escapeHtml(t("labelQuality", [qualityLabel]))}</span>`,
      "</div>",
      why ? '<div class="wt-row">' : "",
      why ? `<span class="wt-why">${escapeHtml(why)}</span>` : "",
      why ? "</div>" : "",
      '<div class="wt-row">',
      `<span class="wt-meta">${escapeHtml(t("labelRecentContributors"))}</span>`,
      renderRecentContributors(latestRevisions),
      "</div>",
      '<div class="wt-row">',
      `<span class="wt-meta">${escapeHtml(t("labelTopContributors"))}</span>`,
      renderTopAuthors(analysis.topAuthors),
      "</div>",
      '<div class="wt-row">',
      `<span class="wt-note">${escapeHtml(t("noteBaseScore", [String(analysis.baseRevisionCount)]))}</span>`,
      "</div>"
    ].join("");
  } catch {
    bannerEl.innerHTML = `<div class="wt-row"><span class="wt-meta">${escapeHtml(t("errorAnalysisUnavailable"))}</span></div>`;
  }
}

function renderTopAuthors(topAuthors) {
  if (!topAuthors.length) {
    return `<span class="wt-meta">${escapeHtml(t("noContributorData"))}</span>`;
  }

  return topAuthors
    .map((author) => {
      const profileUrl = getAuthorProfileUrl(author.user);
      return `<span class="wt-meta"><a href="${profileUrl}" target="_blank" rel="noopener noreferrer">${escapeHtml(author.user)}</a> (${author.addedWords} ${escapeHtml(t("wordsAddedUnit"))}, ${author.sharePct}%)</span>`;
    })
    .join(" ");
}

function renderRecentContributors(revisions) {
  if (!revisions || !revisions.length) {
    return `<span class="wt-meta">${escapeHtml(t("noContributorData"))}</span>`;
  }

  return revisions
    .map((rev) => {
      const user = rev?.user ? rev.user.trim() : t("unknownUser");
      const profileUrl = getAuthorProfileUrl(user);
      const diffUrl = getDiffUrl(rev);
      return `<span class="wt-meta"><a href="${profileUrl}" target="_blank" rel="noopener noreferrer">${escapeHtml(user)}</a> <a href="${diffUrl}" target="_blank" rel="noopener noreferrer">[${escapeHtml(t("diffLinkText"))}]</a></span>`;
    })
    .join(" ");
}

async function fetchRevisionMeta(title, maxRevisions) {
  return fetchRevisions(title, maxRevisions, {
    rvprop: "timestamp|user|comment|size|tags|userid"
  });
}

async function fetchFirstRevision(title) {
  const revisions = await fetchRevisions(title, 1, {
    rvprop: "timestamp|user|ids",
    rvdir: "newer"
  });
  return revisions[0] || null;
}

async function fetchLatestRevisions(title, count = 3) {
  const revisions = await fetchRevisions(title, count, {
    rvprop: "timestamp|user|ids",
    rvdir: "older"
  });
  return revisions;
}

async function fetchRevisions(title, maxRevisions, revisionParams) {
  const cacheKey = JSON.stringify({ title, maxRevisions, revisionParams });
  const cached = requestCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.data;
  }

  const collected = [];
  let rvcontinue;

  while (collected.length < maxRevisions) {
    const params = new URLSearchParams({
      action: "query",
      format: "json",
      formatversion: "2",
      prop: "revisions",
      rvlimit: "max",
      titles: title,
      origin: "*",
      maxlag: "5",
      ...revisionParams
    });

    if (rvcontinue) params.set("rvcontinue", rvcontinue);

    const data = await fetchApiWithRetry(params.toString());
    const page = data?.query?.pages?.[0];
    if (!page || page.missing) throw new Error(t("errorPageMissing"));

    const revisions = page.revisions || [];
    collected.push(...revisions);

    rvcontinue = data?.continue?.rvcontinue;
    if (!rvcontinue || !revisions.length) break;
  }

  const result = collected.slice(0, maxRevisions);
  requestCache.set(cacheKey, { ts: Date.now(), data: result });
  return result;
}

async function fetchPageCategories(title) {
  const cacheKey = `categories:${title}`;
  const cached = requestCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.data;
  }

  const categories = [];
  let clcontinue;

  do {
    const params = new URLSearchParams({
      action: "query",
      format: "json",
      formatversion: "2",
      prop: "categories",
      cllimit: "max",
      titles: title,
      origin: "*",
      maxlag: "5"
    });
    if (clcontinue) params.set("clcontinue", clcontinue);

    const data = await fetchApiWithRetry(params.toString());
    const page = data?.query?.pages?.[0];
    const batch = (page?.categories || []).map((cat) => String(cat.title || ""));
    categories.push(...batch);
    clcontinue = data?.continue?.clcontinue;
  } while (clcontinue);

  requestCache.set(cacheKey, { ts: Date.now(), data: categories });
  return categories;
}

async function fetchTotalEditCount(title) {
  const normalizedTitle = title.replace(/ /g, "_");
  const cacheKey = `totaledits:${normalizedTitle}`;
  const cached = requestCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.data;
  }

  const result = await fetchRestCountWithRetry(
    `${location.origin}/w/rest.php/v1/page/${encodeURIComponent(normalizedTitle)}/history/counts/edits`,
    30000
  );
  requestCache.set(cacheKey, { ts: Date.now(), data: result });
  return result;
}

async function fetchTotalEditorCount(title) {
  const normalizedTitle = title.replace(/ /g, "_");
  const cacheKey = `totaleditors:${normalizedTitle}`;
  const cached = requestCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.data;
  }

  const result = await fetchRestCountWithRetry(
    `${location.origin}/w/rest.php/v1/page/${encodeURIComponent(normalizedTitle)}/history/counts/editors`,
    25000
  );
  requestCache.set(cacheKey, { ts: Date.now(), data: result });
  return result;
}

async function fetchRestCountWithRetry(url, cap) {
  let attempt = 0;
  let delayMs = 350;

  while (attempt < API_MAX_RETRIES) {
    const response = await fetch(url);
    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }

    const retriable = response.status === 429 || response.status === 503;
    if (response.ok && typeof data?.count === "number") {
      return { count: data.count, capped: data.count >= cap };
    }

    if (!retriable || attempt === API_MAX_RETRIES - 1) {
      return { count: null, capped: false };
    }

    await sleep(delayMs);
    delayMs *= 2;
    attempt += 1;
  }

  return { count: null, capped: false };
}


async function fetchApiWithRetry(queryString) {
  let attempt = 0;
  let delayMs = 350;

  while (attempt < API_MAX_RETRIES) {
    const response = await fetch(`${location.origin}/w/api.php?${queryString}`);

    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }

    const errorCode = data?.error?.code || "";
    const retriable =
      response.status === 429 ||
      response.status === 503 ||
      errorCode === "maxlag" ||
      errorCode === "ratelimited";

    if (response.ok && !errorCode) {
      return data;
    }

    if (!retriable || attempt === API_MAX_RETRIES - 1) {
      throw new Error(`${t("errorApiPrefix")} ${response.status}${errorCode ? ` (${errorCode})` : ""}`);
    }

    await sleep(delayMs);
    delayMs *= 2;
    attempt += 1;
  }

  throw new Error(t("errorApiRetryExhausted"));
}

function analyzeRevisions(revisions, firstRevision, totalEditsInfo, totalEditorsInfo) {
  const total = revisions.length;
  const editorCounts = new Map();
  const addedCharsByEditor = new Map();
  const now = Date.now();
  const last30DaysMs = 30 * 24 * 60 * 60 * 1000;
  const last90DaysMs = WAR_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const last180DaysMs = last90DaysMs * 2;

  let anonymousEdits = 0;
  let revertEdits = 0;
  let disputeEdits = 0;
  let recentEdits = 0;
  let edits90Days = 0;
  let editsPrev90Days = 0;
  let revertEdits90Days = 0;
  const whySignals = [];

  for (const rev of revisions) {
    const user = (rev.user || t("maskedUser")).trim();
    const comment = (rev.comment || "").toLowerCase();

    editorCounts.set(user, (editorCounts.get(user) || 0) + 1);

    if (isAnonymousUser(user, rev.userid)) anonymousEdits += 1;
    if (containsKeyword(comment, REVERT_KEYWORDS)) revertEdits += 1;
    if (containsKeyword(comment, DISPUTE_KEYWORDS)) disputeEdits += 1;

    const timestampMs = Date.parse(rev.timestamp || "");
    if (!Number.isNaN(timestampMs)) {
      const ageMs = now - timestampMs;
      if (ageMs <= last30DaysMs) recentEdits += 1;
      if (ageMs <= last90DaysMs) {
        edits90Days += 1;
        if (containsKeyword(comment, REVERT_KEYWORDS)) revertEdits90Days += 1;
      } else if (ageMs <= last180DaysMs) {
        editsPrev90Days += 1;
      }
    }

  }

  // Estimate written volume by contributor: keep only positive size deltas (added content).
  const chronological = [...revisions].sort((a, b) => {
    const ta = Date.parse(a.timestamp || "");
    const tb = Date.parse(b.timestamp || "");
    return ta - tb;
  });
  let previousSize = null;
  for (const rev of chronological) {
    const user = (rev.user || t("maskedUser")).trim();
    const currentSize = typeof rev.size === "number" ? rev.size : null;
    if (currentSize === null) continue;

    if (previousSize !== null) {
      const delta = currentSize - previousSize;
      if (delta > 0) {
        addedCharsByEditor.set(user, (addedCharsByEditor.get(user) || 0) + delta);
      }
    }
    previousSize = currentSize;
  }

  const uniqueEditors = editorCounts.size;
  const topEditorEdits = Math.max(1, ...editorCounts.values());

  const anonRatio = ratio(anonymousEdits, total);
  const revertRatio = ratio(revertEdits, total);
  const disputeRatio = ratio(disputeEdits, total);
  const recentRatio = ratio(recentEdits, total);
  const topEditorShare = ratio(topEditorEdits, total);
  const edits90Ratio = ratio(edits90Days, total);
  const revert90Ratio = ratio(revertEdits90Days, Math.max(1, edits90Days));
  const pageCreatedTs = Date.parse(firstRevision?.timestamp || "");
  const pageAgeDays = Number.isNaN(pageCreatedTs) ? null : Math.floor((now - pageCreatedTs) / (24 * 60 * 60 * 1000));
  const isNewPage = pageAgeDays !== null && pageAgeDays <= 120;

  let score = 80;
  if (uniqueEditors >= 40) score += 8;
  if (uniqueEditors >= 100) score += 4;
  if (topEditorShare > 0.22) score -= 14;
  if (topEditorShare > 0.35) score -= 8;
  if (anonRatio > 0.3) score -= 8;
  if (revertRatio > 0.18) score -= 14;
  if (revertRatio > 0.3) score -= 8;
  if (disputeRatio > 0.1) score -= 8;
  if (recentRatio > 0.55) score -= 10;
  if (total >= 200 && uniqueEditors >= 80 && topEditorShare < 0.12) score += 8;

  if (isNewPage) {
    if (total < 20 && pageAgeDays <= 30) {
      score -= 40;
      whySignals.push(t("reasonVeryRecentLowHistory"));
    } else if (total < 60 && pageAgeDays <= 90) {
      score -= 28;
      whySignals.push(t("reasonRecentLimitedHistory"));
    } else if (total < 90) {
      score -= 16;
      whySignals.push(t("reasonYoungPartialHistory"));
    }
  } else {
    if (edits90Days >= 80 && edits90Ratio > 0.55) {
      score -= 24;
      whySignals.push(t("reasonHighActivity3Months"));
    }
    if (edits90Days >= 45 && editsPrev90Days > 0 && edits90Days / editsPrev90Days >= 1.8) {
      score -= 14;
      whySignals.push(t("reasonSuddenAcceleration3Months"));
    }
    if (edits90Days >= 25 && revert90Ratio >= 0.22) {
      score -= 14;
      whySignals.push(t("reasonEditWar3Months"));
    }
  }

  score = Math.max(0, Math.min(100, Math.round(score)));

  let risk = "low";
  if (score < 70) risk = "medium";
  if (score < 50) risk = "high";

  const summaryParts = [
    t("summaryRevisions", [formatCount(totalEditsInfo, total)]),
    t("summaryContributors", [formatCount(totalEditorsInfo, uniqueEditors)]),
    t("summaryReverts", [String(Math.round(revertRatio * 100))]),
    t("summaryEdits90Days", [String(edits90Days)])
  ];

  if (isNewPage) summaryParts.push(t("summaryPageAgeDays", [String(pageAgeDays)]));

  const totalAddedChars = Array.from(addedCharsByEditor.values()).reduce((sum, value) => sum + value, 0);
  const topAuthors = Array.from(addedCharsByEditor.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([user, addedChars]) => ({
      user,
      addedWords: estimateWordsFromChars(addedChars),
      sharePct: totalAddedChars > 0 ? Math.round((addedChars / totalAddedChars) * 100) : 0
    }));

  return {
    score,
    risk,
    baseRevisionCount: total,
    summary: summaryParts.join(" | "),
    whyReason: whySignals.length ? whySignals.slice(0, 2).join(" ; ") : "",
    topAuthors
  };
}

function getAuthorProfileUrl(author) {
  return `${location.origin}/wiki/Special:Contributions/${encodeURIComponent(author)}`;
}

function getDiffUrl(revision) {
  const revid = revision?.revid;
  const parentid = revision?.parentid;
  if (typeof revid === "number" && typeof parentid === "number" && parentid > 0) {
    return `${location.origin}/w/index.php?diff=${revid}&oldid=${parentid}`;
  }
  if (typeof revid === "number") {
    return `${location.origin}/w/index.php?oldid=${revid}`;
  }
  return `${location.origin}${location.pathname}`;
}

function getArticleWordCount(articleRoot) {
  const text = (articleRoot.textContent || "").replace(/\s+/g, " ").trim();
  if (!text) return 0;
  return text.split(" ").filter(Boolean).length;
}

function escapeHtml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function containsKeyword(text, keywords) {
  return keywords.some((word) => text.includes(word));
}

function isAnonymousUser(user, userId) {
  if (typeof userId !== "number") return true;
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(user);
}

function ratio(value, total) {
  return total ? value / total : 0;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatCount(countInfo, fallback) {
  if (!countInfo || typeof countInfo.count !== "number") return String(fallback);
  if (countInfo.capped) return `${countInfo.count}+`;
  return String(countInfo.count);
}

function estimateWordsFromChars(chars) {
  if (!chars || chars <= 0) return 0;
  return Math.round(chars / 5.5);
}

function detectQualityLabel(categories) {
  const normalized = (categories || []).map((cat) => cat.toLowerCase());
  const hasAdq = normalized.some(
    (cat) =>
      cat.includes("article de qualite") ||
      cat.includes("article_de_qualite") ||
      cat.includes("featured article") ||
      cat.includes("featured articles")
  );
  if (hasAdq) return t("qualityAdq");

  const hasBa = normalized.some(
    (cat) =>
      cat.includes("bon article") ||
      cat.includes("bon_article") ||
      cat.includes("good article") ||
      cat.includes("good articles")
  );
  if (hasBa) return t("qualityBa");

  return t("qualityNone");
}
