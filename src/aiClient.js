const axios = require("axios");

function trimTrailingSlash(url) {
  return (url || "").replace(/\/+$/, "");
}

function isAzureConfigured() {
  return Boolean(
    process.env.AZURE_OPENAI_ENDPOINT &&
      process.env.AZURE_OPENAI_API_KEY &&
      process.env.AZURE_OPENAI_DEPLOYMENT
  );
}

async function askAI(prompt) {
  const messages = [
    {
      role: "user",
      content: prompt,
    },
  ];

  let url;
  let headers;
  let body;

  if (isAzureConfigured()) {
    const endpoint = trimTrailingSlash(process.env.AZURE_OPENAI_ENDPOINT);
    const deployment = process.env.AZURE_OPENAI_DEPLOYMENT;
    const apiVersion =
      process.env.AZURE_OPENAI_API_VERSION || "2024-08-01-preview";

    url = `${endpoint}/openai/deployments/${encodeURIComponent(
      deployment
    )}/chat/completions?api-version=${encodeURIComponent(apiVersion)}`;

    headers = {
      "Content-Type": "application/json",
      "api-key": process.env.AZURE_OPENAI_API_KEY,
    };

    body = { messages };
  } else {
    const model = "gpt-4o-mini";
    url = "https://api.openai.com/v1/chat/completions";
    headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    };
    body = { model, messages };
  }

  try {
    const response = await axios.post(url, body, { headers });

    const text = response.data?.choices?.[0]?.message?.content;

    if (!text) {
      throw new Error("Empty response from OpenAI");
    }

    return text;
  } catch (error) {
    console.error("❌ OpenAI Error:", error.response?.data || error.message);
    return null;
  }
}

module.exports = { askAI };