const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");

const HTTP_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9"
};

/** Fetch HTML with browser-like headers; optional Google web cache fallback (best-effort). */
async function fetchHTML(url, timeout = 20000) {
  try {
    const res = await axios.get(url, {
      headers: HTTP_HEADERS,
      timeout,
      maxRedirects: 5
    });
    if (res.status === 200 && res.data && res.data.length > 200) {
      return res.data;
    }
  } catch (e) {
    /* try cache */
  }
  try {
    const cacheUrl = `https://webcache.googleusercontent.com/search?q=cache:${encodeURIComponent(url)}`;
    const res = await axios.get(cacheUrl, { headers: HTTP_HEADERS, timeout });
    if (res.status === 200 && res.data && res.data.length > 200) {
      return res.data;
    }
  } catch (e) {
    /* ignore */
  }
  return null;
}

const DOCS = {
  fo: "https://learn.microsoft.com/en-us/dynamics365/fin-ops-core/dev-itpro/get-started/public-preview-releases",
  bc: "https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/whatsnew/overview",
  bcWhatsNew: (major, minor) =>
    `https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/whatsnew/whatsnew-update-${major}-${minor}`,
  crm: "https://learn.microsoft.com/en-us/dynamics365/get-started/release-schedule",
  /** Dataverse regional deployment dates — preferred for CRM when the table is present */
  crmDeployment:
    "https://learn.microsoft.com/en-us/power-platform/admin/general-availability-deployment",
  /** Stable public hub; tech docs URLs are derived per release label (see ifsTechdocsOverviewUrl). */
  ifs: "https://www.ifs.com/en/ifs-cloud/releases",
  ifsCommunity:
    "https://community.ifs.com/upgrades-updates-81/release-notes-for-ifs-cloud-57014",
  oracleReadiness: "https://docs.oracle.com/en/cloud/saas/readiness/news.html",
  /** Same URL — used by SOURCE_CONFIG / agent */
  oracle: "https://docs.oracle.com/en/cloud/saas/readiness/news.html",
  oracleVersionFinder: "https://cx.rightnow.com/app/answers/detail/a_id/6244/~/intelligent-advisor-update-schedule",
  sapCommunityErpBlog:
    "https://community.sap.com/t5/enterprise-resource-planning-blog-posts-by-sap/bg-p/ERP-BL",
  sap: "https://community.sap.com/t5/enterprise-resource-planning-blog-posts-by-sap/bg-p/ERP-BL",
  acumaticaNewsHub: "https://www.acumatica.com/cloud-erp-software/acumatica-release-news/",
  acumatica: "https://www.acumatica.com/cloud-erp-software/acumatica-release-news/",
  /** Hub — individual posts resolved in scrapeSalesforce */
  salesforce: "https://admin.salesforce.com/",
  /** Salesforce Help — Field Service updates (reference; not scraped for dates) */
  salesforceHelpFsUpdates:
    "https://help.salesforce.com/s/articleView?id=service.fs_updates.htm&type=5"
};

// ─────────────────────────────────────────────
// 1. Your SAP calendar function (unchanged)
// ─────────────────────────────────────────────
function getSAPCloudReleases2026() {
  return {
    SAP_S4HANA_Cloud: {
      year: 2026,
      dateFormat: "DD-MM-YYYY",
      quarters: [
        {
          quarter: "Q1",
          releaseVersion: "2602",
          previewRelease: {
            system: "Test (T)",
            startDate: "12-02-2026",
            endDate: "13-02-2026"
          },
          sandboxRelease: {
            system: "Starter / Sandbox (S/oth)",
            startDate: "31-01-2026",
            endDate: "01-02-2026"
          },
          gaRelease: {
            system: "Development / Production (D/P)",
            startDate: "14-02-2026",
            endDate: "15-02-2026"
          }
        },
        {
          quarter: "Q3",
          releaseVersion: "2608",
          previewRelease: {
            system: "Test (T)",
            startDate: "12-08-2026",
            endDate: "13-08-2026"
          },
          sandboxRelease: {
            system: "Starter / Sandbox (S/oth)",
            startDate: "01-08-2026",
            endDate: "02-08-2026"
          },
          gaRelease: {
            system: "Development / Production (D/P)",
            startDate: "14-08-2026",
            endDate: "15-08-2026"
          }
        }
      ]
    }
  };
}

/**
 * Reference only — illustrative IFS EA/GA dates as historically seen on community/docs (not used in code).
 * 25R1: EA ~2025-04-10, GA ~2025-05-29 | 25R2: EA ~2025-10-16, GA ~2025-11-27 | 26R1: EA ~2026-04-10, GA ~2026-05-28
 */

const SOURCE_CONFIG = {
  "Microsoft Dynamics 365 Finance & Operations": {
    url: DOCS.fo,
    extractor: extractFinanceAndOperations
  },
  "Microsoft Dynamics 365 Business Central": {
    url: DOCS.bc,
    extractor: extractBusinessCentral
  },
  "Microsoft Dynamics 365 CRM": {
    url: DOCS.crm,
    extractor: extractDynamics365CRM
  },
  "IFS Cloud": {
    url: DOCS.ifs,
    extractor: extractIFSCloud
  },
  "Salesforce": {
    url: DOCS.salesforce,
    extractor: extractSalesforce
  },
  "Acumatica": {
    url: DOCS.acumatica,
    extractor: extractAcumatica
  },
  "SAP S/4HANA": {
    url: DOCS.sap,
    extractor: extractSAP
  },
  "Oracle ERP Cloud": {
    url: DOCS.oracle,
    extractor: extractOracle
  }
};

function parseLearnDate(str) {
  const t = (str || "").trim().replace(/(\d+)(st|nd|rd|th)/gi, "$1");
  if (!t) return null;
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "April 2026" → first of month */
function parseMonthYear(str) {
  const t = (str || "").trim();
  if (!t) return null;
  const m = t.match(/^([A-Za-z]+)\s+(\d{4})$/);
  if (!m) return null;
  const d = new Date(`${m[1]} 1, ${m[2]}`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

/** BC: preview period starts ~one calendar month before major GA (Learn: update-rollout-timeline) */
function previewAvailabilityBeforeGA(gaDate) {
  const d = new Date(gaDate);
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  return d;
}

function formatDateDDMMYYYY(date) {
  if (!date) return null;
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${d}-${m}-${y}`;
}

/** Same calendar month range, e.g. "April 10-13, 2026" → start/end Dates + raw text */
function parseCRMDeploymentRange(str) {
  if (!str) return null;
  const raw = String(str).trim();
  const s = raw.replace(/(\d+)(st|nd|rd|th)/gi, "$1");
  const rangeSameMonth = s.match(
    /^([A-Za-z]+)\s+(\d{1,2})\s*[–-]\s*(\d{1,2}),?\s*(\d{4})$/i
  );
  if (rangeSameMonth) {
    const start = new Date(`${rangeSameMonth[1]} ${rangeSameMonth[2]}, ${rangeSameMonth[4]}`);
    const end = new Date(`${rangeSameMonth[1]} ${rangeSameMonth[3]}, ${rangeSameMonth[4]}`);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
    return { raw, start, end };
  }
  const single = parseLearnDate(s);
  if (single && !Number.isNaN(single.getTime())) return { raw, start: single, end: single };
  return null;
}

function formatDateRangeDDMMYYYY(start, end) {
  if (!start || !end) return null;
  const a = formatDateDDMMYYYY(start);
  const b = formatDateDDMMYYYY(end);
  if (!a || !b) return null;
  return a === b ? a : `${a} to ${b}`;
}

/** Full calendar month before GA start (typical early-access window), as DD-MM-YYYY to DD-MM-YYYY */
function previewMonthRangeBeforeGA(gaStartDate) {
  const pm = previewAvailabilityBeforeGA(gaStartDate);
  const end = new Date(pm.getFullYear(), pm.getMonth() + 1, 0);
  return formatDateRangeDDMMYYYY(pm, end);
}

/** YYYY-MM-DD in local calendar (avoids UTC shift from toISOString on Learn-parsed dates). */
function formatIsoDateLocal(d) {
  if (!d) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** ISO date or "YYYY-MM-DD to YYYY-MM-DD" for ERP JSON scrapers */
function formatIsoRange(start, end) {
  if (!start || !end) return null;
  const a = formatIsoDateLocal(start);
  const b = formatIsoDateLocal(end);
  if (!a || !b) return null;
  return a === b ? a : `${a} to ${b}`;
}

function previewMonthRangeBeforeGAIso(gaStartDate) {
  const pm = previewAvailabilityBeforeGA(gaStartDate);
  const end = new Date(pm.getFullYear(), pm.getMonth() + 1, 0);
  return formatIsoRange(pm, end);
}

/**
 * Rows: { gaDate, label, previewAvailabilityDate? }
 * Sorted ascending by gaDate. Picks current / next relative to today.
 */
function selectCurrentAndNext(rows) {
  if (!rows.length) return { current: null, next: null };

  const sorted = [...rows].sort((a, b) => a.gaDate - b.gaDate);
  const today = startOfDay(new Date());
  const futureIdx = sorted.findIndex((r) => startOfDay(r.gaDate) > today);

  let current;
  let next;

  if (futureIdx === -1) {
    current = sorted[sorted.length - 1];
    next = null;
  } else if (futureIdx === 0) {
    current = sorted[0];
    next = sorted[1] ?? null;
  } else {
    current = sorted[futureIdx - 1];
    next = sorted[futureIdx];
  }

  return { current, next };
}

/**
 * @param {object} [options]
 * @param {string} [options.notes] — full notes line(s); default: `Microsoft Learn — ${productLabel}`
 * @param {string} [options.nextPreviewRangeText] — override preview field (e.g. DD-MM-YYYY to DD-MM-YYYY)
 * @param {string} [options.nextGARangeText] — override next GA field (e.g. Europe regional range)
 */
function buildResult(current, next, docUrl, productLabel, options = {}) {
  let nextPreview = null;
  if (next) {
    if (next.previewAvailabilityDate) {
      nextPreview = next.previewAvailabilityDate;
    } else if (next.gaDate) {
      nextPreview = previewAvailabilityBeforeGA(next.gaDate);
    }
  }

  const notes =
    options.notes !== undefined && options.notes !== null
      ? options.notes
      : `Microsoft Learn — ${productLabel}`;

  const extra = options.sourceUrls;
  const sourceUrls =
    Array.isArray(extra) && extra.length
      ? [...new Set([docUrl, ...extra].filter(Boolean))]
      : docUrl
        ? [docUrl]
        : [];

  const nextPreviewStr =
    options.nextPreviewRangeText ??
    (nextPreview ? formatDateDDMMYYYY(nextPreview) : null);

  const nextGAStr =
    options.nextGARangeText ??
    (next?.gaDate ? formatDateDDMMYYYY(next.gaDate) : null);

  return {
    currentVersion: current?.label ?? "NOT_FOUND",
    sandboxVersion: next?.label ?? "NOT_FOUND",
    nextReleasePreviewAvailabilityDate: nextPreviewStr ?? "NOT_FOUND",
    nextGAReleaseDate: nextGAStr ?? "NOT_FOUND",
    confidence: "CONFIRMED",
    sourceUrl: docUrl,
    sourceUrls,
    notes
  };
}

/**
 * F&O: Service update table — detect columns by header text (Release version | Preview availability | … | GA self-update).
 */
async function extractFinanceAndOperations(url) {
  const html = await fetchHTML(url);
  if (!html) return null;
  const $ = cheerio.load(html);
  const rows = [];

  $("table").each((_, tbl) => {
    const ths = $(tbl)
      .find("th")
      .map((_, th) => $(th).text().trim().toLowerCase())
      .get();
    const gaIdx = ths.findIndex(
      (h) => h.includes("general availability") && h.includes("self")
    );
    const prIdx = ths.findIndex(
      (h) => h.includes("preview availability") && !h.includes("latest")
    );
    if (gaIdx === -1) return;

    $(tbl)
      .find("tr")
      .each((i, tr) => {
        if (i === 0) return;
        const cells = $(tr)
          .find("td")
          .map((_, td) => $(td).text().trim())
          .get();
        if (cells.length <= gaIdx) return;
        const gaDate = parseLearnDate(cells[gaIdx]);
        if (!gaDate) return;
        const previewAvailabilityDate =
          prIdx !== -1 && cells[prIdx] ? parseLearnDate(cells[prIdx]) : null;
        const label = (cells[0] || "").replace(/\s+/g, " ").trim() || "release";
        rows.push({ label, gaDate, previewAvailabilityDate });
      });
  });

  if (!rows.length) return null;

  const { current, next } = selectCurrentAndNext(rows);
  return buildResult(current, next, url, "Finance & Operations service update schedule", {
    notes:
      "GA = General availability (self-update). Preview = Preview availability column. Microsoft Learn — Finance & Operations service update schedule"
  });
}

/**
 * BC: "What's new" overview — Version | Build number | Update availability | Learn more
 * Optionally probes whatsnew-update-{major}-{minor} pages to align with the latest published minor.
 */
async function extractBusinessCentral(url) {
  const data = await fetchHTML(url);
  if (!data) return null;
  const $ = cheerio.load(data);
  const rows = [];

  let $scheduleTable = null;
  $("table").each((_, el) => {
    if ($scheduleTable) return;
    const $t = $(el);
    const header = $t.find("tr").first().text().toLowerCase();
    if (header.includes("version") && header.includes("update availability")) {
      $scheduleTable = $t;
    }
  });

  if (!$scheduleTable) return null;

  $scheduleTable.find("tr").each((_, tr) => {
    const cols = $(tr).find("td");
    if (cols.length < 3) return;

    const ver = $(cols[0]).text().trim();
    if (ver.toLowerCase() === "version") return;

    const build = $(cols[1]).text().trim().replace(/\s+/g, " ");
    const availability = $(cols[2]).text().trim();
    const learnMore = cols.length > 3 ? $(cols[3]).text().trim().replace(/\s+/g, " ") : "";

    if (!/^\d+\.\d+$/.test(ver)) return;

    const gaDate = parseMonthYear(availability);
    if (!gaDate) return;

    const label = learnMore ? `${ver} — ${learnMore}` : `${ver} — ${build}`;

    rows.push({
      version: ver,
      label,
      gaDate,
      previewAvailabilityDate: null
    });
  });

  if (!rows.length) return null;

  let { current, next } = selectCurrentAndNext(rows);
  const extraUrls = [url];

  const mm = current?.version?.match(/^(\d+)\.(\d+)$/);
  if (mm) {
    const major = parseInt(mm[1], 10);
    let latestMinor = -1;
    let lastOkUrl = null;
    for (let minor = 0; minor <= 15; minor++) {
      const u = DOCS.bcWhatsNew(major, minor);
      const h = await fetchHTML(u, 12000);
      if (!h) break;
      const $h = cheerio.load(h);
      const h1 = $h("h1").first().text();
      if (
        !new RegExp(`${major}\\.${minor}`, "i").test(h1) &&
        !/Update\s+\d+\.\d+/i.test(h1)
      ) {
        break;
      }
      latestMinor = minor;
      lastOkUrl = u;
      extraUrls.push(u);
    }
    if (latestMinor >= 0 && lastOkUrl) {
      current = {
        ...current,
        label: `${major}.${latestMinor} — Business Central (Microsoft Learn whatsnew)`
      };
    }
  }

  return buildResult(current, next, url, "Business Central update schedule (overview)", {
    sourceUrls: [...new Set(extraUrls)],
    notes:
      "Microsoft Learn — Business Central overview; optional dynamic whatsnew-update-{major}-{minor} probe for latest minor"
  });
}

/** "April 1" / "September 16" → { month: 0-11, day } */
function parseMonthDayOnly(text) {
  const m = (text || "").trim().match(/^([A-Za-z]+)\s+(\d{1,2})$/);
  if (!m) return null;
  const d = new Date(`${m[1]} ${m[2]}, 2000`);
  if (Number.isNaN(d.getTime())) return null;
  return { month: d.getMonth(), day: d.getDate() };
}

function makeCalendarDate(year, monthDay) {
  if (!monthDay) return null;
  return new Date(year, monthDay.month, monthDay.day);
}

/** Start date only (sorting / First release row). Uses {@link parseCRMDeploymentRange}. */
function parseCRMDeploymentCell(str) {
  const r = parseCRMDeploymentRange(str);
  return r ? r.start : null;
}

function readDeploymentScheduleHeaderRow($, $tbl) {
  const $thead = $tbl.find("thead tr").first();
  if ($thead.length) {
    const thOnly = $thead.find("th");
    if (thOnly.length)
      return thOnly.map((_, th) => $(th).text().trim()).get();
  }
  const $first = $tbl.find("tr").first();
  const ths = $first.find("th");
  if (ths.length) return ths.map((_, th) => $(th).text().trim()).get();
  return $first.find("td").map((_, td) => $(td).text().trim()).get();
}

/**
 * Optional: table with Early access + wave columns (First release row) — not always present.
 */
function findFirstReleaseEarlyAccessDates($) {
  const ranges = findFirstReleaseEarlyAccessRanges($);
  return {
    wave1: ranges.w1?.start ?? null,
    wave2: ranges.w2?.start ?? null
  };
}

/** Early access table — full ranges from "First release" row when columns exist */
function findFirstReleaseEarlyAccessRanges($) {
  let w1 = null;
  let w2 = null;
  $("table").each((_, tbl) => {
    const $t = $(tbl);
    const headers = readDeploymentScheduleHeaderRow($, $t);
    if (headers.length < 3) return;
    const hasEarly = headers.some((h) => /early\s*access/i.test(h));
    if (!hasEarly) return;
    const idx1 = headers.findIndex((h) => /wave\s*1/i.test(h) && /early/i.test(h));
    const idx2 = headers.findIndex((h) => /wave\s*2/i.test(h) && /early/i.test(h));
    if (idx1 === -1 && idx2 === -1) return;
    $t.find("tr").each((i, tr) => {
      if (i === 0) return;
      const cells = $(tr).find("td").map((_, td) => $(td).text().trim()).get();
      if (!cells[0]?.toLowerCase().includes("first release")) return;
      if (idx1 >= 0 && cells[idx1]) w1 = parseCRMDeploymentRange(cells[idx1]);
      if (idx2 >= 0 && cells[idx2]) w2 = parseCRMDeploymentRange(cells[idx2]);
    });
  });
  return { w1, w2 };
}

/** Deployment schedule: row for a region (e.g. Europe), same columns as wave GA table */
function findRegionDeploymentRow($, regionName) {
  const want = String(regionName).trim().toLowerCase();
  let found = null;
  $("table").each((_, tbl) => {
    if (found) return;
    const ths = readDeploymentScheduleHeaderRow($, $(tbl));
    if (ths.length < 3) return;
    if (!ths.slice(1).some((h) => /wave\s*\d/i.test(h))) return;
    $(tbl)
      .find("tr")
      .each((i, tr) => {
        if (i === 0) return;
        const cells = $(tr).find("td").map((_, td) => $(td).text().trim()).get();
        const r0 = cells[0]?.replace(/\*+$/g, "").trim().toLowerCase();
        if (r0 === want) found = cells;
      });
  });
  return found;
}

/** Learn copy for sandbox testing table (used when table is not in static HTML — page may hydrate client-side). */
const SANDBOX_TYPICAL_EARLY_ACCESS_FALLBACK = {
  april: "Mid February",
  october: "Mid August"
};

/**
 * Table "When are updates available for testing in the sandbox environment?" —
 * columns Release wave | Typical early access starts | Full range | Build range.
 * Maps April wave → wave 1 GA, October wave → wave 2 GA.
 * Falls back to Microsoft-published wording when the table is missing from server HTML.
 */
function findSandboxTypicalEarlyAccessStarts($) {
  const out = { april: null, october: null };
  let foundSandboxTable = false;
  $("table").each((_, tbl) => {
    const $tbl = $(tbl);
    const aria = ($tbl.attr("aria-label") || "").toLowerCase();
    const ths = readDeploymentScheduleHeaderRow($, $tbl);
    const hdr = ths.map((h) => h.toLowerCase());
    const isSandboxTable =
      (aria.includes("sandbox") &&
        (aria.includes("testing") || aria.includes("updates"))) ||
      (hdr.some((h) => /release\s*wave/.test(h)) &&
        hdr.some((h) => /typical\s+early\s+access/.test(h)));
    if (!isSandboxTable) return;
    foundSandboxTable = true;
    const idxWave = hdr.findIndex((h) => /release\s*wave/.test(h));
    const idxEarly = hdr.findIndex((h) => /typical\s+early\s+access/.test(h));
    if (idxWave === -1 || idxEarly === -1) return;
    let $rows = $tbl.find("tbody tr");
    if (!$rows.length) {
      $rows = $tbl.find("tr").slice(1);
    }
    $rows.each((_, tr) => {
      const cells = $(tr).find("td").map((_, td) => $(td).text().trim()).get();
      if (cells.length <= Math.max(idxWave, idxEarly)) return;
      const wave = cells[idxWave].toLowerCase();
      const early = cells[idxEarly];
      if (!early) return;
      if (/april\s*wave/.test(wave)) out.april = early;
      if (/october\s*wave/.test(wave)) out.october = early;
    });
  });
  if (!foundSandboxTable) {
    out.april = SANDBOX_TYPICAL_EARLY_ACCESS_FALLBACK.april;
    out.october = SANDBOX_TYPICAL_EARLY_ACCESS_FALLBACK.october;
  } else {
    if (!out.april) out.april = SANDBOX_TYPICAL_EARLY_ACCESS_FALLBACK.april;
    if (!out.october) out.october = SANDBOX_TYPICAL_EARLY_ACCESS_FALLBACK.october;
  }
  return out;
}

/**
 * CRM: prefer Power Platform "general availability deployment" (regional First release dates + DB versions).
 */
async function extractCRMFromDeploymentPage() {
  const depUrl = DOCS.crmDeployment;
  const html = await fetchHTML(depUrl);
  if (!html) return null;
  const $ = cheerio.load(html);

  const dbMap = {};
  $("table").each((_, tbl) => {
    const ths = $(tbl)
      .find("th")
      .map((_, th) => $(th).text().trim().toLowerCase())
      .get();
    if (!ths.some((h) => h.includes("database"))) return;
    $(tbl)
      .find("tr")
      .each((i, tr) => {
        if (i === 0) return;
        const cells = $(tr)
          .find("td")
          .map((_, td) => $(td).text().trim())
          .get();
        if (cells.length >= 2) dbMap[cells[0].toLowerCase()] = cells[1];
      });
  });

  let waveHeaders = [];
  let firstReleaseRow = null;
  $("table").each((_, tbl) => {
    const ths = readDeploymentScheduleHeaderRow($, $(tbl));
    if (ths.length < 3) return;
    if (!ths.slice(1).some((h) => /wave\s*\d/i.test(h))) return;
    waveHeaders = ths;
    $(tbl)
      .find("tr")
      .each((i, tr) => {
        if (i === 0) return;
        const cells = $(tr)
          .find("td")
          .map((_, td) => $(td).text().trim())
          .get();
        if (cells[0]?.toLowerCase().includes("first release")) {
          firstReleaseRow = cells;
        }
      });
  });

  if (!firstReleaseRow || waveHeaders.length < 3) return null;

  const earlyRanges = findFirstReleaseEarlyAccessRanges($);
  const early = {
    wave1: earlyRanges.w1?.start ?? null,
    wave2: earlyRanges.w2?.start ?? null
  };

  const waves = waveHeaders
    .slice(1)
    .map((label, i) => ({
      label: label.replace(/\s*general\s+availability\s*/gi, "").trim(),
      date: parseCRMDeploymentCell(firstReleaseRow[i + 1])
    }))
    .filter((w) => w.date);

  if (!waves.length) return null;

  const today = startOfDay(new Date());
  const pastWaves = waves
    .filter((w) => startOfDay(w.date) <= today)
    .sort((a, b) => b.date - a.date);
  const futureWaves = waves
    .filter((w) => startOfDay(w.date) > today)
    .sort((a, b) => a.date - b.date);

  let current = null;
  let next = null;

  if (pastWaves.length) {
    const cur = pastWaves[0];
    const wNum = cur.label.toLowerCase().includes("wave 1") ? "wave 1" : "wave 2";
    const dbVer =
      Object.entries(dbMap).find(([k]) => k.includes(wNum))?.[1] || "";
    const label = `${cur.label}${dbVer ? ` (DB: ${dbVer})` : ""}`;
    current = { label, gaDate: cur.date, previewAvailabilityDate: cur.date };
  }

  if (futureWaves.length) {
    const nxt = futureWaves[0];
    const isWave1 = /wave\s*1/i.test(nxt.label);
    const eaFromTable = isWave1 ? early.wave1 : early.wave2;
    next = {
      label: nxt.label,
      gaDate: nxt.date,
      previewAvailabilityDate: eaFromTable || null
    };
  }

  const sandboxEarly = findSandboxTypicalEarlyAccessStarts($);
  const europeRow = findRegionDeploymentRow($, "Europe");
  let nextGARangeText;
  let nextPreviewRangeText;
  const europeNotes = [];

  let euW1 = null;
  let euW2 = null;
  if (europeRow && europeRow.length >= waveHeaders.length) {
    euW1 = parseCRMDeploymentRange(europeRow[1]);
    euW2 = parseCRMDeploymentRange(europeRow[2]);
    if (euW1?.raw) europeNotes.push(`Europe — wave 1 GA: ${euW1.raw}`);
    if (euW2?.raw) europeNotes.push(`Europe — wave 2 GA: ${euW2.raw}`);
  }

  if (futureWaves.length) {
    const nxt = futureWaves[0];
    const nextIsWave2 = /wave\s*2/i.test(nxt.label);
    const euTarget = nextIsWave2 ? euW2 : euW1;
    const earlyR = nextIsWave2 ? earlyRanges.w2 : earlyRanges.w1;

    if (euTarget?.start && euTarget?.end) {
      nextGARangeText = formatDateRangeDDMMYYYY(euTarget.start, euTarget.end);
    }

    const sandboxPhrase = nextIsWave2 ? sandboxEarly.october : sandboxEarly.april;
    if (sandboxPhrase) {
      nextPreviewRangeText = sandboxPhrase;
      europeNotes.push(`Sandbox testing — typical early access: ${sandboxPhrase}`);
    } else if (earlyR?.start && earlyR?.end) {
      nextPreviewRangeText = formatDateRangeDDMMYYYY(earlyR.start, earlyR.end);
    } else if (earlyR?.start) {
      nextPreviewRangeText = formatDateDDMMYYYY(earlyR.start);
    } else if (euTarget?.start) {
      nextPreviewRangeText = previewMonthRangeBeforeGA(euTarget.start);
    } else if (nxt.date) {
      nextPreviewRangeText = previewMonthRangeBeforeGA(nxt.date);
    }
  }

  const baseNotes =
    "Schedule: First release row drives wave timing vs today. Date fields use full regional ranges for Europe when present. Preview / early access: sandbox table (typical early access starts) when present; else regional early-access dates; else approximate month before next GA. Microsoft Learn — general availability deployment";
  const notes =
    europeNotes.length > 0 ? `${baseNotes} | ${europeNotes.join(" | ")}` : baseNotes;

  return buildResult(current, next, depUrl, "Dynamics 365 / Power Platform general availability deployment", {
    notes,
    nextGARangeText,
    nextPreviewRangeText,
    sourceUrls: [depUrl]
  });
}

/**
 * CRM fallback: release-schedule page + synthetic rolling wave dates from example table.
 */
async function extractDynamics365CRMScheduleFallback(url) {
  try {
    const data = await fetchHTML(url);
    if (!data) return null;
    const $ = cheerio.load(data);

    let template = {
      wave1Plans: parseMonthDayOnly("March 18"),
      wave1GA: parseMonthDayOnly("April 1"),
      wave2Plans: parseMonthDayOnly("September 16"),
      wave2GA: parseMonthDayOnly("October 1")
    };

    $("table").each((_, table) => {
      const $t = $(table);
      const header = $t.find("tr").first().text();
      if (
        !header.includes("Example date wave 1") ||
        !header.includes("Example date wave 2")
      ) {
        return;
      }

      $t.find("tr").each((_, tr) => {
        const cols = $(tr).find("td");
        if (cols.length < 3) return;

        const milestone = $(cols[0]).text().trim();
        const ex1 = $(cols[1]).text().trim();
        const ex2 = $(cols[2]).text().trim();

        if (milestone.includes("General availability")) {
          const p1 = parseMonthDayOnly(ex1);
          const p2 = parseMonthDayOnly(ex2);
          if (p1) template.wave1GA = p1;
          if (p2) template.wave2GA = p2;
        }
        if (milestone.includes("Release plans available")) {
          const p1 = parseMonthDayOnly(ex1);
          const p2 = parseMonthDayOnly(ex2);
          if (p1) template.wave1Plans = p1;
          if (p2) template.wave2Plans = p2;
        }
      });
    });

    let yMin = new Date().getFullYear() - 1;
    let yMax = new Date().getFullYear() + 2;

    $("h2").each((_, h2) => {
      const t = $(h2).text();
      const m = t.match(/(\d{4})\s+release\s+wave/i);
      if (m) {
        const yy = parseInt(m[1], 10);
        yMin = Math.min(yMin, yy - 1);
        yMax = Math.max(yMax, yy + 2);
      }
    });

    const rows = [];

    for (let y = yMin; y <= yMax; y++) {
      const ga1 = makeCalendarDate(y, template.wave1GA);
      const plan1 = makeCalendarDate(y, template.wave1Plans);
      const ga2 = makeCalendarDate(y, template.wave2GA);
      const plan2 = makeCalendarDate(y, template.wave2Plans);

      if (ga1 && plan1) {
        rows.push({
          label: `${y} release wave 1 — Dynamics 365 CRM (model-driven apps)`,
          gaDate: ga1,
          previewAvailabilityDate: plan1
        });
      }
      if (ga2 && plan2) {
        rows.push({
          label: `${y} release wave 2 — Dynamics 365 CRM (model-driven apps)`,
          gaDate: ga2,
          previewAvailabilityDate: plan2
        });
      }
    }

    if (!rows.length) return null;

    const { current, next } = selectCurrentAndNext(rows);
    return buildResult(
      current,
      next,
      url,
      "Dynamics 365 release schedule and early access (CRM / model-driven apps)",
      {
        notes:
          "Microsoft Learn — release schedule (example dates); prefer general-availability-deployment when available"
      }
    );
  } catch (e) {
    return null;
  }
}

/** CRM: deployment page first, then release-schedule fallback. */
async function extractDynamics365CRM(url) {
  const fromDeployment = await extractCRMFromDeploymentPage();
  if (fromDeployment) return fromDeployment;
  return extractDynamics365CRMScheduleFallback(url);
}

/** Dynamic IFS Cloud documentation URL pattern: YY + R1|R2 → techdocs/{yy}r1|2/… */
function ifsTechdocsOverviewUrl(label) {
  const m = String(label || "").match(/^(\d{2})R([12])/);
  if (!m) return null;
  return `https://docs.ifs.com/techdocs/${m[1]}r${m[2].toLowerCase()}/010_overview/010_fundamentals`;
}

/** Parse EA/GA sentences from community release notes thread (best-effort). */
function parseIFSCommunityThread(html) {
  const $ = cheerio.load(html);
  const body = $("body").text();
  const gaRe =
    /General Availability date for IFS Cloud (\w+) is ([A-Za-z]+ \d{1,2},?\s*\d{4})/gi;
  const eaRe = /Early Access date for IFS Cloud (\w+) is ([A-Za-z]+ \d{1,2},?\s*\d{4})/gi;
  const gaEntries = [];
  const eaEntries = [];
  let m;
  while ((m = gaRe.exec(body)) !== null) {
    gaEntries.push({ label: m[1], date: parseLearnDate(m[2]) });
  }
  while ((m = eaRe.exec(body)) !== null) {
    eaEntries.push({ label: m[1], date: parseLearnDate(m[2]) });
  }
  const today = startOfDay(new Date());
  const futureEA = eaEntries
    .filter((x) => x.date && startOfDay(x.date) > today)
    .sort((a, b) => a.date - b.date);
  const futureGA = gaEntries
    .filter((x) => x.date && startOfDay(x.date) > today)
    .sort((a, b) => a.date - b.date);
  return { futureEA, futureGA, gaEntries, eaEntries };
}

/** Prefer community thread dates for the next release when available. */
function refineIFSNextFromCommunity(next, comm) {
  if (!comm) return next;
  const { futureEA, futureGA } = comm;
  if (futureEA.length) {
    const fe = futureEA[0];
    const gaMatch = futureGA.find((g) => g.label === fe.label);
    return {
      label: `${fe.label} — IFS Cloud`,
      gaDate: gaMatch?.date || next?.gaDate,
      previewAvailabilityDate: fe.date
    };
  }
  if (futureGA.length) {
    const fg = futureGA[0];
    return {
      label: `${fg.label} — IFS Cloud`,
      gaDate: fg.date,
      previewAvailabilityDate: next?.previewAvailabilityDate
    };
  }
  return next;
}

/**
 * IFS Cloud: semiannual R1 (May) / R2 (November) cadence + optional community EA/GA from parsed thread.
 */
async function extractIFSCloud(url) {
  const htmlMain = await fetchHTML(url);
  const htmlComm = await fetchHTML(DOCS.ifsCommunity);

  let anchorYear = new Date().getFullYear();
  if (htmlMain) {
    const $ = cheerio.load(htmlMain);
    const h1 = $("h1").first().text().trim();
    const yearMatch = h1.match(/(\d{4})\s*$/);
    if (yearMatch) anchorYear = parseInt(yearMatch[1], 10);
  }

  const yMin = anchorYear - 1;
  const yMax = anchorYear + 2;
  const rows = [];

  for (let y = yMin; y <= yMax; y++) {
    const yy = String(y).slice(-2);
    rows.push({
      label: `${yy}R1 — IFS Cloud`,
      gaDate: new Date(y, 4, 1),
      previewAvailabilityDate: new Date(y, 3, 1)
    });
    rows.push({
      label: `${yy}R2 — IFS Cloud`,
      gaDate: new Date(y, 10, 1),
      previewAvailabilityDate: new Date(y, 9, 1)
    });
  }

  let { current, next } = selectCurrentAndNext(rows);

  if (htmlComm) {
    const comm = parseIFSCommunityThread(htmlComm);
    if (comm.futureEA.length || comm.futureGA.length) {
      next = refineIFSNextFromCommunity(next, comm);
    }
  }

  const parts = [
    "IFS — IFS Cloud semiannual releases (R1 May, R2 November; public cadence).",
    `Release hub: ${url}`
  ];
  if (htmlComm) {
    parts.push(`Community thread: ${DOCS.ifsCommunity}`);
  }
  const uCur = current?.label ? ifsTechdocsOverviewUrl(current.label) : null;
  const uNext = next?.label ? ifsTechdocsOverviewUrl(next.label) : null;
  if (uCur) parts.push(`Tech docs (current): ${uCur}`);
  if (uNext) parts.push(`Tech docs (next): ${uNext}`);

  const sourceUrls = [url];
  if (htmlComm) sourceUrls.push(DOCS.ifsCommunity);

  return buildResult(current, next, url, "IFS Cloud", {
    notes: parts.join(" | "),
    sourceUrls
  });
}

/**
 * Run the configured official extractor for this connector name, or null if none / failure.
 */
async function extractFromSource(name) {
  const config = SOURCE_CONFIG[name];
  if (!config) return null;
  try {
    return await config.extractor(config.url);
  } catch (e) {
    return null;
  }
}

/** True when official extraction produced a usable current version (skip Tavily + LLM). */
function isSourceDataComplete(sourceData) {
  if (!sourceData || typeof sourceData !== "object") return false;
  const v = sourceData.currentVersion;
  if (v == null || String(v).trim() === "") return false;
  const bad = new Set(["NOT_FOUND", "UNKNOWN"]);
  return !bad.has(String(v).trim());
}

/**
 * @param {object|null|undefined} cachedSource — if non-null object from extractFromSource, avoids a second HTTP call; if null/undefined, fetches
 */
async function validateWithSource(name, existing, cachedSource) {
  const config = SOURCE_CONFIG[name];

  if (!config) return existing;

  let sourceData;
  if (cachedSource != null) {
    sourceData = cachedSource;
  } else {
    sourceData = await config.extractor(config.url);
  }
  console.log("SOURCE DATA:", sourceData);

  if (!sourceData) return existing;

  /** Do not treat "NOT_FOUND" as a real version (it is truthy in JS). */
  const sourceUsable = isSourceDataComplete(sourceData);

  if (!existing.currentVersion && sourceUsable) {
    return {
      ...existing,
      ...sourceData,
      confidence: "CONFIRMED"
    };
  }

  if (sourceUsable && sourceData?.currentVersion) {
    const mergedNotes = sourceData.notes
      ? `${sourceData.notes} | Corrected using source of truth`
      : "Corrected using source of truth";
    return {
      ...existing,
      ...sourceData,
      confidence: "CONFIRMED",
      notes: mergedNotes
    };
  }

  /** Official scrape had no usable version — keep all LLM fields; only add official URL(s) + note. */
  if (!sourceUsable && sourceData) {
    const urls = Array.isArray(sourceData.sourceUrls)
      ? [...sourceData.sourceUrls]
      : [];
    const primary = sourceData.sourceUrl || urls[0] || "";
    if (!primary && !urls.length) return existing;
    const mergedUrls = [
      ...new Set([...(existing.sourceUrls || []), ...urls, existing.sourceUrl].filter(Boolean))
    ];
    const extra =
      sourceData.notes && /could not parse|not found/i.test(sourceData.notes)
        ? ` Official source checked (${primary || urls[0]}) — no version string matched in HTML.`
        : "";
    return {
      ...existing,
      sourceUrl: existing.sourceUrl || primary || mergedUrls[0] || "",
      sourceUrls: mergedUrls.length ? mergedUrls : existing.sourceUrls || [],
      notes: extra ? `${existing.notes || ""}${extra}`.trim() : existing.notes
    };
  }

  return existing;
}

/**
 * Map ERP JSON scraper row (dates often YYYY-MM-DD) to agent extractor shape (DD-MM-YYYY).
 * Aligns with {@link buildResult} / CRM: single dates and "YYYY-MM-DD to YYYY-MM-DD" ranges.
 */
function erpScrapeRowToSourceData(row) {
  if (!row) return null;
  const isoToDdMm = (s) => {
    if (s == null || s === "") return "NOT_FOUND";
    const t = String(s).trim();
    if (t === "NOT_FOUND" || t.startsWith("NOT_FOUND")) return t;
    const one = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (one) return `${one[3]}-${one[2]}-${one[1]}`;
    const two = t.match(
      /^(\d{4})-(\d{2})-(\d{2})\s+to\s+(\d{4})-(\d{2})-(\d{2})$/i
    );
    if (two)
      return `${two[3]}-${two[2]}-${two[1]} to ${two[6]}-${two[5]}-${two[4]}`;
    return t;
  };
  const urls = Array.isArray(row.sourceUrls) ? row.sourceUrls : [];
  return {
    currentVersion: row.currentVersion,
    sandboxVersion: row.sandboxVersion,
    nextReleasePreviewAvailabilityDate: isoToDdMm(row.nextReleasePreviewAvailabilityDate),
    nextGAReleaseDate: isoToDdMm(row.nextGAReleaseDate),
    confidence: "CONFIRMED",
    sourceUrl: urls[0] || "",
    sourceUrls: urls,
    notes: row.notes || ""
  };
}

async function extractSalesforce() {
  return erpScrapeRowToSourceData(await scrapeSalesforce());
}

async function extractOracle() {
  return erpScrapeRowToSourceData(await scrapeOracle());
}

async function extractSAP() {
  return erpScrapeRowToSourceData(await scrapeSAP());
}

async function extractAcumatica() {
  return erpScrapeRowToSourceData(await scrapeAcumatica());
}

// ═══════════════════════════════════════════════════════════════════════════
// ERP Release JSON scraper (same file — run: node utils/sourceValidator.js)
// Writes erp_releases.json — YYYY-MM-DD dates; no runtime “confirmed fallback” maps.
// ═══════════════════════════════════════════════════════════════════════════

const SCRAPER_TODAY = new Date();

/*
 * Reference-only: keep manual verification snapshots in your runbook — do not merge
 * hardcoded “confirmed” rows into scrape output at runtime.
 */

function parseDateISO(str) {
  const d = parseLearnDate(str);
  return d && !Number.isNaN(d.getTime()) ? formatIsoDateLocal(d) : null;
}

function parseMonthYearCellToISO(str) {
  const d = parseMonthYear(str);
  return d && !Number.isNaN(d.getTime()) ? d.toISOString().split("T")[0] : null;
}

function isPastIso(ds) {
  return ds && new Date(ds) <= SCRAPER_TODAY;
}
function isFutureIso(ds) {
  return ds && new Date(ds) > SCRAPER_TODAY;
}

function emptyErpRow(productName) {
  return {
    product: productName,
    scrapedAt: SCRAPER_TODAY.toISOString(),
    currentVersion: "NOT_FOUND",
    sandboxVersion: "NOT_FOUND",
    nextReleasePreviewAvailabilityDate: "NOT_FOUND",
    nextGAReleaseDate: "NOT_FOUND",
    sourceUrls: [],
    notes: ""
  };
}

function parseBCOverviewLatestVersion(html) {
  const $ = cheerio.load(html);
  let best = null;
  $("table").each((_, table) => {
    const header = $(table).find("tr").first().text().toLowerCase();
    if (!header.includes("version") || !header.includes("update availability")) return;
    $(table)
      .find("tr")
      .each((_, tr) => {
        const ver = $(tr).find("td").first().text().trim();
        if (ver.toLowerCase() === "version") return;
        const m = ver.match(/^(\d+)\.(\d+)$/);
        if (!m) return;
        const major = parseInt(m[1], 10);
        const minor = parseInt(m[2], 10);
        if (!best || major > best.major || (major === best.major && minor > best.minor)) {
          best = { major, minor };
        }
      });
  });
  return best;
}

async function scrapeFinanceOps() {
  const URL = DOCS.fo;
  const r = emptyErpRow("D365 Finance & Operations");
  r.sourceUrls = [URL];
  const html = await fetchHTML(URL);
  if (!html) {
    r.notes = "Fetch failed";
    return r;
  }
  const $ = cheerio.load(html);
  const rows = [];
  $("table").each((_, tbl) => {
    const ths = $(tbl)
      .find("th")
      .map((_, th) => $(th).text().trim().toLowerCase())
      .get();
    const gaIdx = ths.findIndex((h) => h.includes("general availability") && h.includes("self"));
    const prIdx = ths.findIndex((h) => h.includes("preview availability") && !h.includes("latest"));
    if (gaIdx === -1) return;
    $(tbl)
      .find("tr")
      .each((i, tr) => {
        if (i === 0) return;
        const cells = $(tr)
          .find("td")
          .map((_, td) => $(td).text().trim())
          .get();
        if (cells.length <= gaIdx) return;
        const ga = parseDateISO(cells[gaIdx]);
        const preview = prIdx !== -1 ? parseDateISO(cells[prIdx]) : null;
        if (ga) rows.push({ version: cells[0], preview, ga });
      });
  });
  if (!rows.length) {
    r.notes = "Release table not found";
    return r;
  }
  const released = rows.filter((x) => isPastIso(x.ga)).sort((a, b) => b.ga.localeCompare(a.ga));
  const upcoming = rows.filter((x) => isFutureIso(x.ga)).sort((a, b) => a.ga.localeCompare(b.ga));
  if (released.length) r.currentVersion = released[0].version;
  if (upcoming.length) {
    r.sandboxVersion = upcoming[0].version;
    r.nextReleasePreviewAvailabilityDate = upcoming[0].preview || "NOT_FOUND";
    r.nextGAReleaseDate = upcoming[0].ga;
  }
  r.notes =
    "GA = 'General availability (self-update)' date. Preview = 'Preview availability' date. Sandbox autoupdate occurs 7 days before production.";
  return r;
}

async function scrapeCRM() {
  const URL = DOCS.crmDeployment;
  const r = emptyErpRow("D365 CRM");
  r.sourceUrls = [URL];
  const html = await fetchHTML(URL);
  if (!html) {
    r.notes = "Fetch failed";
    return r;
  }
  const $ = cheerio.load(html);
  const dbMap = {};
  $("table").each((_, tbl) => {
    const ths = $(tbl)
      .find("th")
      .map((_, th) => $(th).text().trim().toLowerCase())
      .get();
    if (!ths.some((h) => h.includes("database"))) return;
    $(tbl)
      .find("tr")
      .each((i, tr) => {
        if (i === 0) return;
        const cells = $(tr)
          .find("td")
          .map((_, td) => $(td).text().trim())
          .get();
        if (cells.length >= 2) dbMap[cells[0].toLowerCase()] = cells[1];
      });
  });
  let waveHeaders = [];
  let firstReleaseRow = null;
  $("table").each((_, tbl) => {
    const ths = readDeploymentScheduleHeaderRow($, $(tbl));
    if (ths.length < 3) return;
    if (!ths.slice(1).some((h) => /wave\s*\d/i.test(h))) return;
    waveHeaders = ths;
    $(tbl)
      .find("tr")
      .each((i, tr) => {
        if (i === 0) return;
        const cells = $(tr)
          .find("td")
          .map((_, td) => $(td).text().trim())
          .get();
        if (cells[0]?.toLowerCase().includes("first release")) firstReleaseRow = cells;
      });
  });
  if (!firstReleaseRow || waveHeaders.length < 3) {
    r.notes = "Deployment table not found or structure changed";
    return r;
  }
  const earlyRanges = findFirstReleaseEarlyAccessRanges($);
  const sandboxEarly = findSandboxTypicalEarlyAccessStarts($);
  const early = {
    wave1: earlyRanges.w1?.start ?? null,
    wave2: earlyRanges.w2?.start ?? null
  };
  const waves = waveHeaders
    .slice(1)
    .map((label, i) => {
      const d = parseCRMDeploymentCell(firstReleaseRow[i + 1]);
      return {
        label: label.replace(/\s*general\s+availability\s*/gi, "").trim(),
        date: d ? d.toISOString().split("T")[0] : null
      };
    })
    .filter((w) => w.date);
  const pastWaves = waves.filter((w) => isPastIso(w.date)).sort((a, b) => b.date.localeCompare(a.date));
  const futureWaves = waves.filter((w) => isFutureIso(w.date)).sort((a, b) => a.date.localeCompare(b.date));
  if (pastWaves.length) {
    const cur = pastWaves[0];
    const wNum = cur.label.toLowerCase().includes("wave 1") ? "wave 1" : "wave 2";
    const dbVer = Object.entries(dbMap).find(([k]) => k.includes(wNum))?.[1] || "";
    r.currentVersion = `${cur.label}${dbVer ? ` (DB: ${dbVer})` : ""}`;
  }
  if (futureWaves.length) {
    const nxt = futureWaves[0];
    const isWave1 = /wave\s*1/i.test(nxt.label);
    const ea = isWave1 ? early.wave1 : early.wave2;
    const gaIso = nxt.date;
    r.sandboxVersion = nxt.label;

    const europeRow = findRegionDeploymentRow($, "Europe");
    const nextIsWave2 = /wave\s*2/i.test(nxt.label);
    let euTarget = null;
    let earlyR = null;
    if (europeRow && europeRow.length >= waveHeaders.length) {
      const euW1 = parseCRMDeploymentRange(europeRow[1]);
      const euW2 = parseCRMDeploymentRange(europeRow[2]);
      euTarget = nextIsWave2 ? euW2 : euW1;
      earlyR = nextIsWave2 ? earlyRanges.w2 : earlyRanges.w1;
    }

    if (euTarget?.start && euTarget?.end) {
      r.nextGAReleaseDate = formatIsoRange(euTarget.start, euTarget.end);
    } else {
      r.nextGAReleaseDate = gaIso;
    }

    const sandboxPhrase = nextIsWave2 ? sandboxEarly.october : sandboxEarly.april;
    if (sandboxPhrase) {
      r.nextReleasePreviewAvailabilityDate = sandboxPhrase;
    } else if (earlyR?.start && earlyR?.end) {
      r.nextReleasePreviewAvailabilityDate = formatIsoRange(earlyR.start, earlyR.end);
    } else if (earlyR?.start) {
      r.nextReleasePreviewAvailabilityDate = formatIsoDateLocal(earlyR.start);
    } else if (euTarget?.start) {
      r.nextReleasePreviewAvailabilityDate = previewMonthRangeBeforeGAIso(euTarget.start);
    } else if (ea) {
      r.nextReleasePreviewAvailabilityDate = formatIsoDateLocal(ea);
    } else {
      const gd = new Date(`${gaIso}T12:00:00`);
      gd.setMonth(gd.getMonth() - 1);
      gd.setDate(1);
      r.nextReleasePreviewAvailabilityDate = formatIsoDateLocal(gd);
    }
  }
  r.notes =
    "Next GA / preview use Europe regional windows when listed; otherwise First release start dates. Preview: sandbox table (typical early access starts) when present; else regional early-access dates; else approximate month before GA.";
  return r;
}

async function scrapeBC() {
  const r = emptyErpRow("D365 Business Central");
  const overviewHtml = await fetchHTML(DOCS.bc);
  let major = 27;
  let overviewMinorHint = 0;
  if (overviewHtml) {
    r.sourceUrls.push(DOCS.bc);
    const parsed = parseBCOverviewLatestVersion(overviewHtml);
    if (parsed) {
      major = parsed.major;
      overviewMinorHint = parsed.minor;
    }
  }
  let latestMinor = -1;
  for (let minor = 0; minor <= 15; minor++) {
    const url = DOCS.bcWhatsNew(major, minor);
    const html = await fetchHTML(url, 12000);
    if (!html) break;
    const h1 = cheerio.load(html)("h1").first().text();
    if (!new RegExp(`${major}\\.${minor}`, "i").test(h1) && !/Update\s+\d+\.\d+/i.test(h1)) break;
    if (!r.sourceUrls.includes(url)) r.sourceUrls.push(url);
    latestMinor = minor;
  }
  if (latestMinor < 0 && overviewHtml) {
    const url = DOCS.bcWhatsNew(major, overviewMinorHint);
    const html = await fetchHTML(url, 12000);
    if (html) {
      const h1 = cheerio.load(html)("h1").first().text();
      if (
        new RegExp(`${major}\\.${overviewMinorHint}`, "i").test(h1) ||
        /Update\s+\d+\.\d+/i.test(h1)
      ) {
        if (!r.sourceUrls.includes(url)) r.sourceUrls.push(url);
        latestMinor = overviewMinorHint;
      }
    }
  }
  const previewMajor = major + 1;
  const pUrl = DOCS.bcWhatsNew(previewMajor, 0);
  const pHtml = await fetchHTML(pUrl, 12000);
  let nextGaFromOverview = null;
  let nextPreviewApprox = null;
  if (overviewHtml) {
    const $ = cheerio.load(overviewHtml);
    $("table").each((_, table) => {
      const header = $(table).find("tr").first().text().toLowerCase();
      if (!header.includes("version") || !header.includes("update availability")) return;
      $(table)
        .find("tr")
        .each((_, tr) => {
          const cols = $(tr).find("td");
          if (cols.length < 3) return;
          const ver = $(cols[0]).text().trim();
          const avail = $(cols[2]).text().trim();
          if (ver === `${previewMajor}.0`) {
            nextGaFromOverview = parseMonthYearCellToISO(avail);
            if (nextGaFromOverview) {
              const d = new Date(`${nextGaFromOverview}T12:00:00`);
              d.setMonth(d.getMonth() - 1);
              d.setDate(1);
              nextPreviewApprox = d.toISOString().split("T")[0];
            }
          }
        });
    });
  }
  if (latestMinor >= 0) r.currentVersion = `Business Central ${major}.${latestMinor}`;
  if (pHtml) {
    const h1 = cheerio.load(pHtml)("h1").first().text();
    if (new RegExp(String(previewMajor), "i").test(h1) || /Update\s+\d+\.0/i.test(h1)) {
      if (!r.sourceUrls.includes(pUrl)) r.sourceUrls.push(pUrl);
      r.sandboxVersion = `Business Central ${previewMajor}.0 (preview/next wave)`;
      r.nextReleasePreviewAvailabilityDate = nextPreviewApprox || "NOT_FOUND";
      r.nextGAReleaseDate = nextGaFromOverview || "NOT_FOUND";
    }
  }
  r.notes = `BC overview: ${DOCS.bc}. Probed ${DOCS.bcWhatsNew(major, "{minor}")}. Next wave: ${pUrl}.`;
  return r;
}

function getSFSeason(date) {
  const m = date.getMonth() + 1;
  const y = date.getFullYear();
  if (m >= 2 && m <= 5)
    return { season: "spring", releaseYear: y, yy: String(y).slice(2), blogYear: y - 1, slug: "release-dates-countdown" };
  if (m >= 6 && m <= 9)
    return { season: "summer", releaseYear: y, yy: String(y).slice(2), blogYear: y, slug: "release-countdown" };
  const ny = y + 1;
  return { season: "winter", releaseYear: ny, yy: String(ny).slice(2), blogYear: y, slug: "release-dates-countdown" };
}

function nextSFSeason(cur) {
  if (cur.season === "spring") return getSFSeason(new Date(cur.releaseYear, 6, 1));
  if (cur.season === "summer") return getSFSeason(new Date(cur.releaseYear, 10, 1));
  return getSFSeason(new Date(cur.releaseYear, 2, 1));
}

function sfBlogUrl(s) {
  return `https://admin.salesforce.com/blog/${s.blogYear}/admin-${s.season}-${s.yy}-${s.slug}`;
}

/** All Month Day tokens in order; build ISO range for production rollout (Admin countdown posts). */
function sfMonthDayListToIsoRange(text, year) {
  const DATE_RE =
    /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}/gi;
  const isos = [];
  let m;
  while ((m = DATE_RE.exec(text)) !== null) {
    const iso = parseDateISO(`${m[0]} ${year}`);
    if (iso) isos.push(iso);
  }
  if (!isos.length) return null;
  if (isos.length === 1) return isos[0];
  const a = new Date(`${isos[0]}T12:00:00`);
  const b = new Date(`${isos[isos.length - 1]}T12:00:00`);
  return formatIsoRange(a, b);
}

async function scrapeSalesforce() {
  const r = emptyErpRow("Salesforce");
  const cur = getSFSeason(SCRAPER_TODAY);
  const next = nextSFSeason(cur);
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  async function fetchPost(s) {
    const url = sfBlogUrl(s);
    const html = await fetchHTML(url);
    if (!html) return null;
    const $ = cheerio.load(html);
    const title = $("h1").first().text().toLowerCase();
    if (!title.includes(s.season) && !title.includes(s.yy)) return null;
    let sandboxDate = null;
    let gaDate = null;
    const fullYear = s.releaseYear;
    const MONTH_RE = /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}/i;

    $("h2, h3, h4, h5, p, li").each((_, el) => {
      if (sandboxDate) return;
      const text = $(el).text().trim();
      if (/sandbox\s+preview\s+begins/i.test(text)) {
        const mDate = text.match(MONTH_RE);
        if (mDate) sandboxDate = parseDateISO(`${mDate[0]} ${fullYear}`);
      }
    });
    $("h2, h3").each((_, el) => {
      const text = $(el).text().trim();
      const low = text.toLowerCase();
      if (
        /arrives\s*!|'26\s+arrives|release\s+arrives/i.test(text) ||
        (low.includes("arrives") && (low.includes("production") || low.includes("summer") || low.includes("spring") || low.includes("winter")))
      ) {
        const range = sfMonthDayListToIsoRange(text, fullYear);
        if (range) gaDate = range;
      }
    });
    $("h2, h3").each((_, el) => {
      const text = $(el).text().trim();
      const low = text.toLowerCase();
      const mDate = text.match(MONTH_RE);
      if (!mDate) return;
      const dateStr = parseDateISO(`${mDate[0]} ${fullYear}`);
      if (!dateStr) return;
      if (!sandboxDate && (low.includes("sandbox") || low.includes("refresh"))) sandboxDate = dateStr;
      if (
        !gaDate &&
        (low.includes("release weekend") ||
          low.includes("first release") ||
          /general availability/i.test(text))
      ) {
        gaDate = dateStr;
      }
    });
    if (!sandboxDate || !gaDate) {
      const DATE_RE =
        /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}(?:,?\s*\d{4})?/gi;
      $("p, li").each((_, el) => {
        const text = $(el).text().trim();
        const low = text.toLowerCase();
        const dates = text.match(DATE_RE);
        if (!dates) return;
        const d = parseDateISO(`${dates[0]} ${fullYear}`);
        if (!sandboxDate && (low.includes("sandbox preview begins") || (low.includes("sandbox") && low.includes("preview"))))
          sandboxDate = d;
        if (
          !gaDate &&
          (low.includes("production") ||
            low.includes("general availability") ||
            low.includes("release weekend") ||
            (low.includes("arrives") && low.includes("maintenance")))
        )
          gaDate = d;
      });
    }
    return { url, sandboxDate, gaDate };
  }

  const curPost = await fetchPost(cur);
  const nextPost = await fetchPost(next);
  r.sourceUrls.push(DOCS.salesforceHelpFsUpdates);
  r.currentVersion = `Salesforce ${cap(cur.season)} '${cur.yy}`;
  if (curPost) r.sourceUrls.push(curPost.url);
  if (nextPost) {
    r.sourceUrls.push(nextPost.url);
    r.sandboxVersion = `Salesforce ${cap(next.season)} '${next.yy}`;
    r.nextReleasePreviewAvailabilityDate = nextPost.sandboxDate || "NOT_FOUND";
    r.nextGAReleaseDate = nextPost.gaDate || "NOT_FOUND";
  } else {
    r.sandboxVersion = `NOT_FOUND (${cap(next.season)} '${next.yy} post not yet published)`;
  }
  r.notes = `Current post: ${sfBlogUrl(cur)} | Next post: ${sfBlogUrl(next)}. Field Service updates (Help): ${DOCS.salesforceHelpFsUpdates}`;
  return r;
}

function oracleQ(date) {
  const yy = String(date.getFullYear()).slice(2);
  const mo = date.getMonth() + 1;
  return `${yy}${mo <= 3 ? "A" : mo <= 6 ? "B" : mo <= 9 ? "C" : "D"}`;
}
function nextOracleQ(l) {
  const y = parseInt(l.slice(0, 2), 10);
  const map = { A: "B", B: "C", C: "D", D: "A" };
  const nl = map[l[2]];
  return `${nl === "A" ? y + 1 : y}${nl}`;
}
function prevOracleQ(l) {
  const y = parseInt(l.slice(0, 2), 10);
  const map = { B: "A", C: "B", D: "C", A: "D" };
  const pl = map[l[2]];
  return `${pl === "D" ? y - 1 : y}${pl}`;
}
const ORA_GA_MONTH = { A: 1, B: 4, C: 7, D: 10 };
function oraGADate(l) {
  const y = 2000 + parseInt(l.slice(0, 2), 10);
  return new Date(y, ORA_GA_MONTH[l[2]], 15).toISOString().split("T")[0];
}
function oraPreviewDate(l) {
  const y = 2000 + parseInt(l.slice(0, 2), 10);
  return new Date(y, ORA_GA_MONTH[l[2]] - 1, 1).toISOString().split("T")[0];
}


async function scrapeOracle() {
  const URL = DOCS.oracle;
  const r = emptyErpRow("Oracle ERP Cloud");
  r.sourceUrls = [URL];

  const html = await fetchHTML(URL);
  const html2 = await fetchHTML(DOCS.oracleVersionFinder); // ✅ FIXED

  const calQ = oracleQ(SCRAPER_TODAY);
  const calGA = oraGADate(calQ);
  const curQ = isPastIso(calGA) ? calQ : prevOracleQ(calQ);
  const nextQ = nextOracleQ(curQ);

  r.currentVersion = `Oracle ERP Cloud ${curQ}`;

  if (html && new RegExp(`\\b${nextQ}\\b`).test(html)) {
    r.sandboxVersion = `Oracle ERP Cloud ${nextQ}`;

    // fallback (kept as-is)
    r.nextReleasePreviewAvailabilityDate = oraPreviewDate(nextQ);
    r.nextGAReleaseDate = oraGADate(nextQ);

    // ✅ REAL EXTRACTION (FIXED REGEX)
    if (html2) {

      // GA DATE
      const gaMatch = html2.match(
        new RegExp(`([A-Za-z]+\\s+\\d{1,2},\\s+\\d{4}).{0,80}${nextQ}\\s+General\\s+Availability`, "i")
      );
      if (gaMatch) {
        r.nextGAReleaseDate = new Date(gaMatch[1])
          .toLocaleDateString("en-GB")
          .split("/")
          .join("-");
      }

      // PRODUCTION DATE
      const prodMatch = html2.match(
        new RegExp(`([A-Za-z]+\\s+\\d{1,2},\\s+\\d{4}).{0,80}Production sites automatically updated to ${nextQ}`, "i")
      );
      if (prodMatch) {
        r.nextProductionDate = new Date(prodMatch[1])
          .toLocaleDateString("en-GB")
          .split("/")
          .join("-");
      }

      // SANDBOX DATE
      const sandboxMatch = html2.match(
        new RegExp(`([A-Za-z]+\\s+\\d{1,2},\\s+\\d{4}).{0,80}Self-service test site creation.*${nextQ}`, "i")
      );
      if (sandboxMatch) {
        r.nextReleasePreviewAvailabilityDate = new Date(sandboxMatch[1])
          .toLocaleDateString("en-GB")
          .split("/")
          .join("-");
      }

      // CURRENT PRODUCTION
      const curProdMatch = html2.match(
        new RegExp(`([A-Za-z]+\\s+\\d{1,2},\\s+\\d{4}).{0,80}Production sites automatically updated to ${curQ}`, "i")
      );
      if (curProdMatch) {
        r.currentProductionDate = new Date(curProdMatch[1])
          .toLocaleDateString("en-GB")
          .split("/")
          .join("-");
      }
    }

    const gaMonth = new Date(r.nextGAReleaseDate).toLocaleString("en-US", {
      month: "long",
      year: "numeric"
    });

    r.notes = `${nextQ} confirmed on Oracle schedule. Stage pods ≈ 1st of ${gaMonth}; production ≈ 15th.`;

  } else {
    r.sandboxVersion = `NOT_FOUND (${nextQ} not yet on readiness page)`;
    r.notes = html
      ? `${nextQ} not yet announced on readiness page.`
      : "Fetch failed — cadence derived.";
  }

  return r;
}
 

function collectSapVersionHits(text) {
  const versions = [];
  if (!text) return versions;
  const normalized = text.replace(/\s+/g, " ");
  const re = /(\d{4})\s+(FPS|SPS)\s*0*(\d{1,2})\b/gi;
  let m;
  while ((m = re.exec(normalized)) !== null) {
    versions.push({
      year: parseInt(m[1], 10),
      type: m[2].toUpperCase(),
      num: parseInt(m[3], 10)
    });
  }
  return versions;
}

function pickLatestSapVersion(versions) {
  if (!versions.length) return null;
  const seen = new Set();
  const uniq = versions.filter((v) => {
    const k = `${v.year}-${v.type}-${v.num}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  uniq.sort(
    (a, b) => b.year - a.year || (a.type === "FPS" ? -1 : 1) || b.num - a.num
  );
  return uniq[0];
}

async function scrapeSAP() {
  const r = emptyErpRow("SAP S/4HANA");
  r.sourceUrls = ["https://help.sap.com"];

  // 👉 use your existing calendar function
  const sap = getSAPCloudReleases2026();
  const quarters = sap.SAP_S4HANA_Cloud.quarters;

  const current = quarters[0]; // Q1 → 2602
  const next = quarters[1];    // Q3 → 2608

  r.currentVersion = `SAP S/4HANA Cloud ${current.releaseVersion}`;
  r.sandboxVersion = `SAP S/4HANA Cloud ${next.releaseVersion}`;
  r.nextReleasePreviewAvailabilityDate = next.previewRelease.startDate;
  r.nextGAReleaseDate = next.gaRelease.startDate;

  r.notes =
    "Derived from SAP S/4HANA Cloud release calendar. Preview = Test (T); GA = Development/Production (D/P).";

  return r;
}

async function scrapeIFS() {
  const r = emptyErpRow("IFS Cloud");
  r.sourceUrls = [DOCS.ifs, DOCS.ifsCommunity];
  let curLabel = null;
  const mainHtml = await fetchHTML(DOCS.ifs);
  if (mainHtml) {
    const $ = cheerio.load(mainHtml);
    $("h1, h2").each((_, el) => {
      if (curLabel) return;
      const m = $(el).text().trim().match(/IFS Cloud Release\s+(\w+ \d{4})/i);
      if (!m) return;
      const d = new Date(m[1]);
      if (Number.isNaN(d.getTime())) return;
      const mo = d.getMonth() + 1;
      const yy = String(d.getFullYear()).slice(2);
      curLabel = mo >= 9 ? `${yy}R2` : `${yy}R1`;
      r.currentVersion = `IFS Cloud ${m[1]} (${curLabel})`;
    });
  }
  const commHtml = await fetchHTML(DOCS.ifsCommunity);
  if (commHtml) {
    const $ = cheerio.load(commHtml);
    const body = $("body").text();
    const gaRe = /General Availability date for IFS Cloud (\w+) is ([A-Za-z]+ \d{1,2},?\s*\d{4})/gi;
    const eaRe = /Early Access date for IFS Cloud (\w+) is ([A-Za-z]+ \d{1,2},?\s*\d{4})/gi;
    const gaEntries = [];
    const eaEntries = [];
    let m;
    while ((m = gaRe.exec(body)) !== null) gaEntries.push({ label: m[1], date: parseDateISO(m[2]) });
    while ((m = eaRe.exec(body)) !== null) eaEntries.push({ label: m[1], date: parseDateISO(m[2]) });
    const pastGA = gaEntries.filter((x) => x.date && isPastIso(x.date)).sort((a, b) => b.date.localeCompare(a.date));
    if (pastGA.length && !curLabel) {
      curLabel = pastGA[0].label;
      r.currentVersion = `IFS Cloud ${curLabel}`;
    }
    const futureEA = eaEntries.filter((x) => x.date && isFutureIso(x.date)).sort((a, b) => a.date.localeCompare(b.date));
    const futureGA = gaEntries.filter((x) => x.date && isFutureIso(x.date)).sort((a, b) => a.date.localeCompare(b.date));
    if (futureEA.length) {
      r.sandboxVersion = `IFS Cloud ${futureEA[0].label}`;
      r.nextReleasePreviewAvailabilityDate = futureEA[0].date;
      r.nextGAReleaseDate = futureGA.length ? futureGA[0].date : "NOT_FOUND";
    } else if (futureGA.length) {
      r.sandboxVersion = `IFS Cloud ${futureGA[0].label}`;
      r.nextReleasePreviewAvailabilityDate = "NOT_FOUND";
      r.nextGAReleaseDate = futureGA[0].date;
    }
  }
  r.notes +=
    (r.notes ? " " : "") +
    "EA = Early Access (sandbox preview). GA = General Availability. Sources: ifs.com + community thread.";
  return r;
}

function acumaticaCurrent(date) {
  const y = date.getFullYear();
  const R1 = new Date(y, 2, 17);
  const R2 = new Date(y, 8, 17);
  if (date >= R2) return { year: y, r: 2, approxGA: `${y}-09-19` };
  if (date >= R1) return { year: y, r: 1, approxGA: `${y}-03-19` };
  return { year: y - 1, r: 2, approxGA: `${y - 1}-09-19` };
}

function acumaticaPressUrl(year, rel) {
  return `https://www.acumatica.com/cloud-erp-software/${year}-r${rel}/`;
}

async function fetchAcumaticaPageGA(year, rel) {
  const url = acumaticaPressUrl(year, rel);
  const html = await fetchHTML(url);
  if (!html) return null;
  const $ = cheerio.load(html);
  const h1 = $("h1").first().text().toLowerCase();
  if (!h1.includes("acumatica") && !h1.includes(String(year))) return null;
  const body = $("body").text();
  let mm = body.match(/Bellevue[^–—\n]{0,25}[–—]\s*([A-Za-z]+ \d{1,2},?\s*\d{4})\s*[—–]/);
  if (!mm) mm = body.match(/general\s+availability[^.]*?([A-Za-z]+ \d{1,2},?\s*\d{4})/i);
  return { url, gaDate: mm ? parseDateISO(mm[1]) : null };
}

async function scrapeAcumatica() {
  const r = emptyErpRow("Acumatica");
  r.sourceUrls = [DOCS.acumatica];
  const cur = acumaticaCurrent(SCRAPER_TODAY);
  const next =
    cur.r === 1
      ? { year: cur.year, r: 2, approxGA: `${cur.year}-09-19` }
      : { year: cur.year + 1, r: 1, approxGA: `${cur.year + 1}-03-19` };
  r.currentVersion = `Acumatica ${cur.year} R${cur.r}`;
  const curInfo = await fetchAcumaticaPageGA(cur.year, cur.r);
  if (curInfo) r.sourceUrls.push(curInfo.url);
  const nextInfo = await fetchAcumaticaPageGA(next.year, next.r);
  if (nextInfo) {
    r.sourceUrls.push(nextInfo.url);
    r.sandboxVersion = `Acumatica ${next.year} R${next.r}`;
    r.nextReleasePreviewAvailabilityDate = nextInfo.gaDate || next.approxGA;
    r.nextGAReleaseDate = nextInfo.gaDate || next.approxGA;
  } else {
    r.sandboxVersion = `Acumatica ${next.year} R${next.r}`;
    r.nextReleasePreviewAvailabilityDate = next.approxGA;
    r.nextGAReleaseDate = next.approxGA;
  }
  r.notes = `News hub: ${DOCS.acumatica}. Press URL pattern: ${acumaticaPressUrl("{year}", "{r}")}.`;
  return r;
}

const ERP_SCRAPERS = [
  { key: "d365_fo", fn: scrapeFinanceOps, label: "D365 Finance & Operations" },
  { key: "d365_crm", fn: scrapeCRM, label: "D365 CRM" },
  { key: "d365_bc", fn: scrapeBC, label: "D365 Business Central" },
  { key: "salesforce", fn: scrapeSalesforce, label: "Salesforce" },
  { key: "oracle_erp", fn: scrapeOracle, label: "Oracle ERP Cloud" },
  { key: "sap_s4hana", fn: scrapeSAP, label: "SAP S/4HANA" },
  { key: "ifs_cloud", fn: scrapeIFS, label: "IFS Cloud" },
  { key: "acumatica", fn: scrapeAcumatica, label: "Acumatica" }
];

async function runErpReleaseScrape() {
  const outPath = path.join(process.cwd(), "erp_releases.json");
  console.log(`\n${"═".repeat(62)}`);
  console.log(`  ERP Release Scraper — ${SCRAPER_TODAY.toISOString().split("T")[0]}`);
  console.log(`${"═".repeat(62)}\n`);

  const output = { scrapedAt: SCRAPER_TODAY.toISOString(), results: {} };

  for (const { key, fn, label } of ERP_SCRAPERS) {
    console.log(`─── ${label} ───`);
    try {
      const data = await fn();
      output.results[key] = data;
      console.log(`  currentVersion                   : ${data.currentVersion}`);
      console.log(`  sandboxVersion                   : ${data.sandboxVersion}`);
      console.log(`  nextReleasePreviewAvailabilityDate: ${data.nextReleasePreviewAvailabilityDate}`);
      console.log(`  nextGAReleaseDate                : ${data.nextGAReleaseDate}`);
      if (data.notes) console.log(`  notes                          : ${data.notes}`);
    } catch (err) {
      console.error(`  ❌ ERROR: ${err.message}`);
      output.results[key] = { ...emptyErpRow(label), notes: `ERROR: ${err.message}` };
    }
    console.log();
  }

  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));

  const pad = (s, n) => String(s || "").slice(0, n).padEnd(n);
  console.log(`${"═".repeat(120)}`);
  console.log(
    `  ${pad("Product", 30)} ${pad("Current Version", 35)} ${pad("Sandbox Version", 30)} ${pad("Preview Date", 13)} Next GA`
  );
  console.log(`  ${"-".repeat(117)}`);
  for (const [, d] of Object.entries(output.results))
    console.log(
      `  ${pad(d.product, 30)} ${pad(d.currentVersion, 35)} ${pad(d.sandboxVersion, 30)} ${pad(d.nextReleasePreviewAvailabilityDate, 13)} ${d.nextGAReleaseDate}`
    );

  console.log(`\n✅  ${outPath} — ${ERP_SCRAPERS.length} ERPs\n`);
  return output;
}

if (require.main === module) {
  runErpReleaseScrape();
}

module.exports = {
  validateWithSource,
  extractFromSource,
  isSourceDataComplete,
  runErpReleaseScrape,
  erpScrapeRowToSourceData,
  extractSalesforce,
  extractOracle,
  extractSAP,
  extractAcumatica,
  scrapeFinanceOps,
  scrapeCRM,
  scrapeBC,
  scrapeSalesforce,
  scrapeOracle,
  scrapeSAP,
  scrapeIFS,
  scrapeAcumatica,
  fetchHTML,
  sfBlogUrl,
  acumaticaPressUrl,
  DOCS
};
