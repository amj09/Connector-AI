const axios = require("axios");

async function searchWeb(query) {
  try {
    const response = await axios.post(
      "https://api.tavily.com/search",
      {
        api_key: process.env.TAVILY_API_KEY,
        query,
        search_depth: "advanced",
        include_answer: true,
        max_results: 5,
      }
    );
    // console.log("WEB SEARCH RESPONSE:", response.data);
    return response.data;
  } catch (err) {
    console.error("❌ Web Search Error:", err.response?.data || err.message);
    return null;
  }
}

module.exports = { searchWeb };