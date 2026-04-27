function emptyResult(reason) {
  return {
    currentVersion: "UNKNOWN",
    sandboxVersion: "UNKNOWN",
    nextReleasePreviewAvailabilityDate: "NOT_FOUND",
    nextGAReleaseDate: "NOT_FOUND",
    confidence: "LOW",
    sourceUrl: "",
    notes: reason || "No valid response"
  };
}

function parseResponse(text) {
  if (!text) return emptyResult("No response");

  try {
    const clean = text
      .replace(/```json/g, "")
      .replace(/```/g, "")
      .trim();

    const parsed = JSON.parse(clean);

    if (!parsed.currentVersion) {
      return emptyResult("Invalid structure");
    }

    if (parsed.sourceUrl === undefined || parsed.sourceUrl === null) {
      parsed.sourceUrl = "";
    }

    return parsed;
  } catch {
    return emptyResult("Parsing failed");
  }
}

module.exports = { parseResponse };