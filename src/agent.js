require("dotenv").config();
const fs = require("fs");
const { buildPrompt } = require("./promptBuilder");
const { askAI } = require("./aiClient");
const { parseResponse } = require("./parser");
const { log } = require("../utils/logger");
const {
  validateWithSource,
  extractFromSource,
  isSourceDataComplete
} = require("../utils/sourceValidator");

// TAVILY_API_KEY
const { searchWeb } = require("./webSearch");
 
// ─────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────
const BATCH_SIZE = 5;        // how many connectors run in parallel per batch
const BATCH_DELAY = 5000;    // ms to wait between batches
const MAX_RETRIES = 3;       // max retry attempts per connector
 
// ─────────────────────────────────────────────
// Retry wrapper — handles 429 rate limits
// ─────────────────────────────────────────────
async function askWithRetry(prompt, retries = MAX_RETRIES) {
  try {
    return await askAI(prompt);
  } catch (err) {
    // err.status OR err?.error?.code for rate limits
    const status = err?.status ?? err?.error?.code;
    const message = err?.message ?? err?.error?.message ?? "";
 
    if (status === 429 && retries > 0) {
      // Error message format: "Rate limit reached... Please retry after 20s"
      const match = message.match(/retry after (\d+(\.\d+)?)s/i)
        ?? message.match(/retry in (\d+(\.\d+)?)s/i);
 
      let waitTime = 30000; // default 30s fallback
 
      if (match) {
        waitTime = Math.ceil(parseFloat(match[1]) * 1000);
      }
 
      console.log(`⏳ Rate limited. Retrying in ${waitTime / 1000}s... (${retries} retries left)`);
      await new Promise((res) => setTimeout(res, waitTime));
      return askWithRetry(prompt, retries - 1);
    }
 
    // Non-429 error or retries exhausted
    console.error("❌ Error:", err?.error ?? err);
    return null;
  }
}
 
// ─────────────────────────────────────────────
// Process a single connector
// ─────────────────────────────────────────────
async function processConnector(connector) {
  // ── 1) Official source first (no Tavily / no LLM when complete)
  console.log(`[agent] ${connector.name}: trying official source…`);
  const sourceData = await extractFromSource(connector.name);

  if (isSourceDataComplete(sourceData)) {
    console.log(
      `[agent] ${connector.name}: official source OK — skipping Tavily & LLM`
    );
    return {
      name: connector.name,
      data: {
        ...sourceData,
        dataSource: "official"
      }
    };
  }

  // ── 2) Fallback: Tavily + LLM (reuse cached source row when present to avoid duplicate fetch)
  console.log(`[agent] ${connector.name}: fetching web data…`);

  function extractUsefulData(webData) {
    if (!webData) return "NOT_AVAILABLE";

    let text = "";

    if (webData.answer) {
      text += `PRIMARY ANSWER:\n${webData.answer}\n\n`;
    }

    if (webData.results) {
      webData.results.slice(0, 3).forEach((r, i) => {
        text += `SOURCE ${i + 1}:\n${r.content}\n\n`;
      });
    }

    return text;
  }

  // ─────────────────────────────────────────────
// SAP-specific multi-query search
// ─────────────────────────────────────────────
  async function fetchSAPWebData(today) {
    const queries = [
      `SAP S/4HANA latest on-premise release FPS SPS generally available as of ${today}`,
      `SAP S/4HANA Cloud Public Edition latest YYMM release announced as of ${today}`,
      `SAP S/4HANA next FPS SPS major release date announcement as of ${today}`,
    ];

    const results = await Promise.allSettled(queries.map((q) => searchWeb(q)));

    let combined = "";
    const allSources = [];

  for (const r of results) {
      if (r.status !== "fulfilled" || !r.value) continue;
      if (r.value.answer) combined += `PRIMARY ANSWER:\n${r.value.answer}\n\n`;
      if (Array.isArray(r.value.results)) {
        r.value.results.slice(0, 2).forEach((s, i) => {
          combined += `SOURCE ${i + 1}:\n${s.content}\n\n`;
          allSources.push(s);
        });
      }
    }

    return { text: combined || "NOT_AVAILABLE", sources: allSources };
  }

  const d = new Date();
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  const today = `${dd}-${mm}-${yyyy}`; // dd-mm-yyyy
  // const rawWebData = await searchWeb(
  //   `${connector.name} current GA version official release and release date as of ${today}`
  // );
  // console.log("raw web data:", rawWebData);

  // const cleanedData = extractUsefulData(rawWebData);
  // console.log("cleaned data:", cleanedData);

  let cleanedData;

  if (connector.name.toLowerCase().includes("SAP S/4HANA")) {
    console.log("[agent] SAP S/4HANA: using multi-query search");

    const sapData = await fetchSAPWebData(today);
    cleanedData = sapData.text;

    console.log("sap cleaned data:", cleanedData);
  } else {
    const rawWebData = await searchWeb(
      `${connector.name} current GA version official release and release date as of ${today}`
    );

    console.log("raw web data:", rawWebData);

    cleanedData = extractUsefulData(rawWebData);
  }

  const prompt = buildPrompt(connector.name, cleanedData);

  console.log(`[agent] ${connector.name}: calling AI…`);

  const aiResponse = await askWithRetry(prompt);

  console.log("RAW AI RESPONSE", aiResponse);

  if (!aiResponse) {
    console.warn(
      `[agent] ${connector.name}: failed after all retries → marking as RATE_LIMITED`
    );
    return { name: connector.name, data: { error: "RATE_LIMITED" } };
  }

  const parsed = parseResponse(aiResponse);

  console.log(`[agent] ${connector.name}: merging with source (if any)…`);

  const merged = await validateWithSource(
    connector.name,
    parsed,
    sourceData
  );

  console.log(`✅ [agent] ${connector.name}: done`);

  return {
    name: connector.name,
    data: {
      ...merged,
      dataSource: "ai_web"
    }
  };
}
 
// ─────────────────────────────────────────────
// Main agent — batched parallel execution
// ─────────────────────────────────────────────
async function runAgent() {
  const connectors = JSON.parse(
    fs.readFileSync("./config/connectors.json", "utf-8")
  );
 
  console.log(`🚀 Starting agent for ${connectors.length} connectors (batch size: ${BATCH_SIZE})`);
 
  const results = {};
 
  for (let i = 0; i < connectors.length; i += BATCH_SIZE) {
    const batch = connectors.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(connectors.length / BATCH_SIZE);
 
    console.log(`\n📦 Batch ${batchNum}/${totalBatches}: processing ${batch.map(c => c.name).join(", ")}`);
 
    // Run this batch in parallel
    const batchResults = await Promise.all(
      batch.map((connector) => processConnector(connector))
    );
 
    // Collect results
    for (const item of batchResults) {
      results[item.name] = item.data;
    }
 
    // Wait between batches (skip delay after the last batch)
    if (i + BATCH_SIZE < connectors.length) {
      console.log(`⏳ Batch ${batchNum} done. Waiting ${BATCH_DELAY / 1000}s before next batch…`);
      await new Promise((res) => setTimeout(res, BATCH_DELAY));
    }
  }
 
  // ─────────────────────────────────────────────
  // Write output
  // ─────────────────────────────────────────────
  const finalOutput = {
    lastUpdated: new Date().toISOString().split("T")[0],
    data: results,
  };
 
  fs.writeFileSync("./output.json", JSON.stringify(finalOutput, null, 2));
 
  const failed = Object.values(results).filter(r => r?.error === "RATE_LIMITED").length;
 
  console.log(`\n✅ output.json updated`);
  console.log(`📊 Summary: ${connectors.length - failed} succeeded, ${failed} rate-limited`);
}
 
runAgent();