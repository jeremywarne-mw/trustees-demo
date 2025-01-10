import axios from "axios";
import { promises as fs } from "fs";
import dotenv from "dotenv";

dotenv.config();

const azureEndpoint = process.env.AZURE_OPENAI_ENDPOINT;
const azureApiKey = process.env.AZURE_API_KEY;

export async function getGptResponse(prompt) {
    const headers = {
        "Content-Type": "application/json",
        "api-key": azureApiKey,
    };

    const body = {
        messages: [{ role: "user", content: prompt }],
        max_tokens: 15000,
        temperature: 0,
        top_p: 1,
    };

    const response = await cachedPost(`${azureEndpoint}`, body, headers);
    return response.choices[0].message.content;
}

// Load the cache from the file, or initialize it
export let cache = {};
const cacheFilePath = './cache.json';

try {
    const data = await fs.readFile(cacheFilePath, 'utf8');
    cache = JSON.parse(data);
} catch (err) {
    if (err.code !== 'ENOENT') {
    console.error('Error loading cache:', err);
    }
}


/**
 * Save the cache to a file
 */
export async function saveCache() {
    try {
        await fs.writeFile(cacheFilePath, JSON.stringify(cache, null, 2), 'utf-8');
    } catch (err) {
        console.error('Error saving cache file:', err);
    }
}

  /**
   * Cached POST request with persistent cache
   * @param {string} url - The endpoint URL
   * @param {object} body - The request payload
   * @param {object} headers - The request headers
   * @returns {Promise<object>} - The response data
   */
 export async function cachedPost(url, body, headers, enableCache = true) {
    // Create a unique cache key based on the URL and payload
    const cacheKey = `${url}:${JSON.stringify(body)}`;
  
    // Return the cached response if available
    if (cache[cacheKey] && enableCache) {
      return cache[cacheKey];
    }
    try {
      const response = await axios.post(url, body, { headers });
  
      // Cache the response data
      cache[cacheKey] = response.data;
  
      // Persist the cache to the file
      await saveCache();
  
      return response.data;
    } catch (err) {
      console.error('Error in cachedPost:', err);
      throw err;
    }
  }