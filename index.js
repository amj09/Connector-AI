require("dotenv").config();
const express = require("express");
const cron = require("node-cron");
const path = require("path");

const { runAgent } = require("./src/agent");
const { sendMail } = require("./mailer");

const app = express();

app.get("/index.html", (req, res) => {
  // res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Serve static files from "public"
// app.use(express.static(path.join(__dirname, "public")));

// ✅ Cron job (India time)
cron.schedule("0 9 * * 1", async () => {
//cron.schedule("* * * * *", async () => { // every minute
  try {
    console.log("⏰ Running weekly job...");

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
