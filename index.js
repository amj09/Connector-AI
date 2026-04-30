require("dotenv").config();
const express = require("express");
const cron = require("node-cron");
const path = require("path");

const { runAgent } = require("./src/agent");
const { sendMail } = require("./mailer");

const app = express();

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Serve static files from "public"
app.use(express.static("public"));

// generated json response end-point
app.get("/api/data", (req, res) => {
  res.sendFile(path.join(__dirname, "output.json"));
});

// ✅ Cron job (India time)
// cron.schedule("0 11 * * *", async () => { // runs 11AM everyday
cron.schedule("0 * * * *", async () => { // runs every hour
  try {
    await runAgent();   // generates output.json
    await sendMail();   // sends email

  } catch (err) {
    console.error("❌ Cron failed:", err);
  }
}, {
  timezone: "Asia/Kolkata"
});

app.listen(3000, () => {
  console.log("Server running on port 3000");
});
