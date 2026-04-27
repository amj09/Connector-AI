require("dotenv").config();
const nodemailer = require("nodemailer");
const fs = require("fs");
const path = require("path");
const cron = require("node-cron");

// Create transporter
const transporter = nodemailer.createTransport({
  host: "smtp.office365.com",
  port: 587,
  secure: false,
  auth: {
    user: process.env.OUTLOOK_USER,
    pass: process.env.OUTLOOK_PASS,
  },
});

// ─────────────────────────────────────────────
// Shared cell styles
// ─────────────────────────────────────────────
const thStyle = "padding:11px 16px; font-weight:600; white-space:nowrap;";
const tdStyle =
  "padding:10px 16px; border-top:1px solid #e8ecf0; color:#1a1a1a; vertical-align:middle;";

// ─────────────────────────────────────────────
// Confidence badge helper
// ─────────────────────────────────────────────
function getConfidenceBadge(confidence) {
  if (!confidence || confidence === "—") return "—";

  const map = {
    CONFIRMED:               { bg: "#d4edda", color: "#155724", label: "✅ Confirmed" },
    HIGH_CONFIDENCE_PATTERN: { bg: "#d1ecf1", color: "#0c5460", label: "🔵 High" },
    PREDICTED:               { bg: "#fff3cd", color: "#856404", label: "🟡 Predicted" },
    LOW_CONFIDENCE:          { bg: "#f8d7da", color: "#721c24", label: "🔴 Low" },
  };

  const style = map[confidence] || { bg: "#e2e3e5", color: "#383d41", label: confidence };

  return `<span style="
    background:${style.bg};
    color:${style.color};
    padding:2px 8px;
    border-radius:10px;
    font-size:11px;
    font-weight:600;
    white-space:nowrap;
  ">${style.label}</span>`;
}

// ─────────────────────────────────────────────
// Format output.json → single compact table
// ─────────────────────────────────────────────
function formatDataAsHtml(data) {
  const tableRows = Object.entries(data.data)
    .map(([productName, product], i) => {
      const rowBg = i % 2 === 0 ? "#ffffff" : "#f7f9fc";

      // Error row
      if (product?.error) {
        return `
          <tr style="background:${rowBg};">
            <td style="${tdStyle} font-weight:600;">${productName}</td>
            <td colspan="5" style="${tdStyle} color:#cc0000;">⚠️ ${product.error}</td>
          </tr>`;
      }

      const sandboxDisplay =
        !product.sandboxVersion || product.sandboxVersion === "NOT_FOUND"
          ? `<span style="color:#999; font-style:italic;">NOT_FOUND</span>`
          : product.sandboxVersion;

      // "Preview Date" = releaseDate of the sandbox (next release's preview),
      // fall back to nextReleaseDate when sandbox is unknown
      const previewDate =
        !product.sandboxVersion || product.sandboxVersion === "NOT_FOUND"
          ? `<span style="color:#999;">NOT_FOUND</span>`
          : product.nextReleasePreviewAvailabilityDate || "—";

      const nextGA = product.nextGAReleaseDate || "—";

      return `
        <tr style="background:${rowBg};">
          <td style="${tdStyle} font-weight:600; white-space:nowrap;">${productName}</td>
          <td style="${tdStyle} font-family:'Courier New',monospace; font-size:13px;">${product.currentVersion || "—"}</td>
          <td style="${tdStyle} font-family:'Courier New',monospace; font-size:13px;">${sandboxDisplay}</td>
          <td style="${tdStyle} white-space:nowrap; text-align:center;">${previewDate}</td>
          <td style="${tdStyle} white-space:nowrap; text-align:center; font-weight:600; color:#0078d4;">${nextGA}</td>
          <td style="${tdStyle} text-align:center;">${getConfidenceBadge(product.confidence)}</td>
        </tr>`;
    })
    .join("");

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <style>
    @media only screen and (max-width: 600px) {
      table {
        font-size:12px !important;
      }
      th, td {
        padding:8px !important;
      }
    }
  </style>
</head>
<body style="margin:0; padding:0; background:#f0f2f5; font-family:Arial, sans-serif;">
  <div style="
    max-width:1050px;
    margin:30px auto;
    background:#ffffff;
    border-radius:8px;
    overflow:hidden;
    box-shadow:0 2px 10px rgba(0,0,0,0.12);
  ">

    <!-- Header -->
    <div style="
      background:linear-gradient(135deg, #0078d4 0%, #005a9e 100%);
    ">
      <h1 style="margin:0; color:#000000; font-size:20px; letter-spacing:0.3px;">
        📦 Connector Version Report
      </h1>
      <p style="margin:6px 0 0; color:#0078d4; font-size:13px;">
        Last Updated: ${data.lastUpdated} &nbsp;|&nbsp; Auto-generated weekly report
      </p>
    </div>

    <!-- Table -->
    <div style="padding:24px 0px 32px 0px;">
      <div style="overflow-x:auto; width:100%;">
        <table style="
          width:100%;
          min-width:700px;
            width:100%;
            border-collapse:collapse;
            font-family:Arial, sans-serif;
            font-size:14px;
            border:1px solid #d0d7de;
            border-radius:6px;
            overflow:hidden;
          ">
            <thead>
              <tr style="background:#0078d4; color:#ffffff;">
                <th style="${thStyle} text-align:left;">Product</th>
                <th style="${thStyle} text-align:left;">Current Version</th>
                <th style="${thStyle} text-align:left;">Sandbox Version</th>
                <th style="${thStyle} text-align:center;">Preview Date</th>
                <th style="${thStyle} text-align:center;">Next GA</th>
                <th style="${thStyle} text-align:center;">Confidence</th>
              </tr>
            </thead>
            <tbody>
              ${tableRows}
            </tbody>
        </table>
      </div>
    </div>

    <!-- Footer -->
    <div style="
      background:#f5f5f5;
      border-top:1px solid #e0e0e0;
      padding:14px 32px;
      font-size:12px;
      color:#888;
      text-align:center;
    ">
      This report is auto-generated by the ERP Release Intelligence System. Do not reply to this email.
    </div>

  </div>
</body>
</html>`;
}

// ─────────────────────────────────────────────
// Send mail
// ─────────────────────────────────────────────
async function sendMail() {
  console.log("📧 Sending email...");

  const outputData = JSON.parse(
    fs.readFileSync(path.join(__dirname, "output.json"), "utf-8")
  );

  const mailOptions = {
    from: `"ERP Release System" <${process.env.OUTLOOK_USER}>`,
    to: process.env.MAIL_TO.split(",").map(e => e.trim()),
    subject: `ERP Release Report — ${outputData.lastUpdated}`,
    html: formatDataAsHtml(outputData),
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log("✅ Email sent successfully!", info.messageId);
  } catch (err) {
    console.error("❌ Error sending email:", err.message);
  }
}

sendMail();

// Schedule: Every Monday at 9:00 AM
// cron.schedule("0 9 * * 1", () => {
//   runAgent();
//   sendMail();
// });