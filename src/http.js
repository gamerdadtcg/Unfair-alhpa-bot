const axios = require('axios');
const { log, logError } = require('./log');

const documented404s = new Set();

async function getJson(url, options = {}) {
  try {
    const res = await axios.get(url, {
      timeout: options.timeout || 12000,
      headers: options.headers || {},
      params: options.params,
      validateStatus: status => status >= 200 && status < 300
    });
    return res.data;
  } catch (err) {
    const status = err?.response?.status;
    if (status === 404) {
      if (!documented404s.has(url)) {
        documented404s.add(url);
        log(`SOURCE 404 (skipped): ${url}`);
      }
      return null;
    }
    if (options.silent) return null;
    logError(`HTTP GET ${url}`, err);
    return null;
  }
}

async function postJson(url, body, options = {}) {
  try {
    const res = await axios.post(url, body, {
      timeout: options.timeout || 15000,
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      validateStatus: status => status >= 200 && status < 300
    });
    return res.data ?? true;
  } catch (err) {
    if (options.silent) return null;
    logError(`HTTP POST ${url}`, err);
    return null;
  }
}

async function rpc(url, method, params, id = 1) {
  if (!url) return null;
  const data = await postJson(url, { jsonrpc: '2.0', id, method, params }, { silent: true });
  return data?.result ?? null;
}

module.exports = { getJson, postJson, rpc };
