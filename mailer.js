require("dotenv").config();
const nodemailer = require("nodemailer");
const fs = require("fs");
const path = require("path");

// Create transporter
const transporter = nodemailer.createTransport({
  /*
  host: "smtp.office365.com",
  port: 587,
  secure: false,
  auth: {
    user: process.env.OUTLOOK_USER,
    pass: process.env.OUTLOOK_PASS,
  },
  */
  service: "gmail",
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_PASS, // NOT your real password
  },
});

// Styles
const thStyle = "padding:11px 16px; font-weight:600; white-space:nowrap; font-family:'Inter';";
const tdStyle =
  "padding:10px 16px; border-top:1px solid #e8ecf0; color:#1a1a1a; vertical-align:middle; font-family:'Inter'; font-weight:500;";

// Confidence badge
function getConfidenceBadge(confidence) {
  if (!confidence || confidence === "—") return "—";

  const map = {
    CONFIRMED: { color: "#1E6455", label: "Confirmed" },
    HIGH_CONFIDENCE_PATTERN: { color: "#0c5460", label: "High" },
    PREDICTED: { color: "#856404", label: "Predicted" },
    LOW_CONFIDENCE: { color: "#721c24", label: "Low" },
  };

  const style = map[confidence] || { color: "#383d41", label: confidence };

  return `<span style="
    color:${style.color};
    font-size:13px;
    font-weight:600;
    white-space:nowrap;
    font-family:'Inter';
  ">${style.label}</span>`;
}

// Format HTML
function formatDataAsHtml(data) {
  const tableRows = Object.entries(data.data)
    .map(([productName, product], i) => {
      const rowBg = i % 2 === 0 ? "#ffffff" : "#f7f9fc";

      if (product?.error) {
        return `
          <tr style="background:${rowBg};">
            <td style="${tdStyle} font-weight:700;">${productName}</td>
            <td colspan="5" style="${tdStyle} color:#cc0000;">⚠️ ${product.error}</td>
          </tr>`;
      }

      const sandboxDisplay =
        !product.sandboxVersion || product.sandboxVersion === "NOT_FOUND"
          ? `<span style="color:#999; font-style:italic;">NOT_FOUND</span>`
          : product.sandboxVersion;

      const previewDate =
        !product.sandboxVersion || product.sandboxVersion === "NOT_FOUND"
          ? `<span style="color:#999;">NOT_FOUND</span>`
          : product.nextReleasePreviewAvailabilityDate || "—";

      const nextGA = product.nextGAReleaseDate || "—";

      return `
        <tr style="background:${rowBg};">
          <td style="${tdStyle} font-weight:700;">${productName}</td>
          <td style="${tdStyle} font-size:13px;">${product.currentVersion || "—"}</td>
          <td style="${tdStyle} font-size:13px;">${sandboxDisplay}</td>
          <td style="${tdStyle} font-size:13px; text-align:center;">${previewDate}</td>
          <td style="${tdStyle} font-size:13px; text-align:center; font-weight:600; color:#0078d4;">${nextGA}</td>
          <td style="${tdStyle} font-size:13px; text-align:center;">${getConfidenceBadge(product.confidence)}</td>
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
  table { font-size:12px !important; }
  th, td { padding:8px !important; }
}

/* DARK MODE (pure black) */
@media (prefers-color-scheme: dark) {
  body { background:#000000 !important; }

  .container {
    background:#000000 !important;
    color:#ffffff !important;
  }

  table {
    border-color:#333333 !important;
  }

  th {
    background:#3785e0 !important;
    color:#ffffff !important;
  }

  td {
    background:#000000 !important;
    color:#ffffff !important;
    border-color:#333333 !important;
  }

  .footer {
    background:#000000 !important;
    color:#97A3B6 !important;
  }
  .last-updated {
    color:#cbd5f5 !important;
  }
}
</style>
</head>

<body style="margin:0; padding:0; background:#ffffff;">

<div class="container" style="
  width:100%;
  max-width:100%;
  margin:0;
  background:#ffffff;
">

<!-- Header -->
<div style="padding:20px 16px;">
  <h1 style="margin:0; font-size:20px;">
    Vendor Release Report
  </h1>
  <p class="last-updated" style="margin:6px 0 0; color:#31479E; font-size:13px;">
    Last Updated: ${data.lastUpdated} | Auto-generated weekly report
  </p>
</div>

<!-- Table -->
<div style="padding:16px;">
  <div style="overflow-x:auto;">
    <table style="
      width:100%;
      border-collapse:collapse;
      font-size:14px;
      border:1px solid #d0d7de;
    ">
      <thead>
        <tr style="background:#3785e0; color:#ffffff;">
          <th style="${thStyle} text-align:left;">Product Name</th>
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
<div class="footer" style="
  padding:12px;
  font-size:12px;
  color:#97A3B6;
  text-align:center;
">
  This report is auto-generated by the ERP Release Intelligence System. Do not reply to this email.
</div>

</div>
</body>
</html>`;
}

// Send mail
async function sendMail() {
  const outputData = JSON.parse(
    fs.readFileSync(path.join(__dirname, "output.json"), "utf-8")
  );

  const sent_to_mails = [
    "aaz@clicklearn.com", 
    "sam@clicklearn.com", 
    "amj@clicklearn.com", 
    "pod@clicklearn.com"
  ];

  const mailOptions = {
    /*
    from: `"ERP Release System" <${process.env.OUTLOOK_USER}>`,
    to: process.env.MAIL_TO.split(","),
    subject: `ERP Release Report — ${outputData.lastUpdated}`,
    html: formatDataAsHtml(outputData),
    */

    from: `"ERP Release System" <${process.env.GMAIL_USER}>`,
    to: sent_to_mails.join(','),
    subject: `ERP Release Report — ${outputData.lastUpdated}`,
    html: formatDataAsHtml(outputData),
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log('info: ', info);
    console.log("✅ Email sent:", info.messageId);
  } catch (err) {
    console.error("❌ Error:", err.message);
  }
}

// sendMail();

module.exports = { sendMail };
