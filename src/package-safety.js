import corpusText from './slopsquatting-corpus.js';

export const CORPUS_SOURCE = 'Trend Micro slopsquatting dataset, commit 92cc9f6ad9aa77daae858865c1df1edaa67df8ab';
export const CORPUS_SHA256 = '54e487fbe4fea9feffa6b6660c5e23a6ed58fd7b5539db981a545d5347dced74';

export function normalizePypiName(name) {
  return String(name).toLowerCase().replace(/[-_.]+/g, '-');
}

export function parseHallucinationCorpus(text) {
  const index = new Map();
  const lines = String(text).split(/\r?\n/);
  for (let lineNumber = 0; lineNumber < lines.length; lineNumber++) {
    const line = lines[lineNumber].trim();
    if (!line) continue;
    let row;
    try { row = JSON.parse(line); } catch { throw new Error(`Invalid Trend Micro corpus JSON on line ${lineNumber + 1}`); }
    if (!Array.isArray(row.modulenotfound)) throw new Error(`Trend Micro corpus line ${lineNumber + 1} has no modulenotfound array`);
    for (const moduleName of row.modulenotfound) {
      if (typeof moduleName !== 'string' || !moduleName.trim()) continue;
      const key = normalizePypiName(moduleName);
      const entry = index.get(key) || { count: 0, evidence: [] };
      entry.count++;
      if (entry.evidence.length < 5) entry.evidence.push({
        module: moduleName,
        model: String(row.model || '').replace(/[^A-Za-z0-9 ._-]/g, '').slice(0, 80),
        questionIndex: Number.isInteger(row.question_index) ? row.question_index : null,
      });
      index.set(key, entry);
    }
  }
  return index;
}

const corpusIndex = parseHallucinationCorpus(corpusText);
const MAX_RESPONSE_BYTES = 512 * 1024;
const REQUEST_TIMEOUT_MS = 5000;

function validPypiName(name) {
  return /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,212}[A-Za-z0-9])?$/.test(name);
}

function validNpmName(name) {
  if (name.startsWith('.') || name.startsWith('_') || name === '.' || name === '..') return false;
  const part = '[a-z0-9][a-z0-9._~-]{0,213}';
  return new RegExp(`^(?:${part}|@[a-z0-9][a-z0-9._~-]{0,213}/${part})$`).test(name);
}

async function boundedJson(response) {
  if (!response.body) throw new Error('Registry returned no response body');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        const error = new Error('Registry response exceeded the size limit');
        error.code = 'RESPONSE_TOO_LARGE';
        throw error;
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
}

function unknown(ecosystem, name, reason) {
  return {
    status: 'UNKNOWN', ecosystem, name, corpusCoverage: ecosystem === 'pypi' ? 'covered' : 'not-covered',
    message: `Verification failed closed (${reason}). Do not add or install this dependency until it is verified from authoritative sources.`,
  };
}

export async function verifyPackage({ ecosystem, name }, { fetchImpl = globalThis.fetch } = {}) {
  if (ecosystem !== 'pypi' && ecosystem !== 'npm') throw new TypeError('ecosystem must be "pypi" or "npm"');
  if (typeof name !== 'string' || name.length > 214 || name !== name.trim()) throw new TypeError('name must be an exact package name of at most 214 characters');

  if (ecosystem === 'pypi') {
    if (!validPypiName(name)) throw new TypeError('name is not a valid PyPI project name');
    const normalized = normalizePypiName(name);
    const entry = corpusIndex.get(normalized);
    if (entry) {
      return {
        status: 'BLOCKED_BY_DATASET', ecosystem, name, normalized, corpusCoverage: 'covered',
        source: CORPUS_SOURCE, evidenceCount: entry.count, evidence: entry.evidence.slice(0, 3),
        message: 'DO NOT USE this exact dependency name. Its normalized name matches a Trend Micro hallucinated-module record. Do not override the match based on registry presence or web search. The dataset records Python module names, which may differ from distribution names; if this was an import name, identify the distinct canonical distribution name and verify that name separately.',
      };
    }
  } else if (!validNpmName(name)) {
    throw new TypeError('name is not a valid npm package name');
  }

  const encoded = encodeURIComponent(name);
  const url = ecosystem === 'pypi'
    ? `https://pypi.org/pypi/${encoded}/json`
    // Ask npm for one dist-tagged version, not the multi-megabyte full packument.
    : `https://registry.npmjs.org/${encoded}/latest`;
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'GET', redirect: 'error', cache: 'no-store',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    return unknown(ecosystem, name, error?.name === 'TimeoutError' ? 'registry request timed out' : 'registry request failed');
  }
  if (response.status === 404) {
    return {
      status: 'NOT_FOUND', ecosystem, name, corpusCoverage: ecosystem === 'pypi' ? 'covered-no-match' : 'not-covered',
      message: `No exact package record was found in the official ${ecosystem === 'pypi' ? 'PyPI' : 'npm'} registry. Do not add or install this dependency.`,
    };
  }
  if (!response.ok) return unknown(ecosystem, name, `official registry returned HTTP ${response.status}`);

  let metadata;
  try {
    metadata = await boundedJson(response);
  } catch (error) {
    if (ecosystem !== 'pypi' || error?.code !== 'RESPONSE_TOO_LARGE') {
      return unknown(ecosystem, name, 'registry response was invalid or exceeded the size limit');
    }

    let confirmation;
    try {
      confirmation = await fetchImpl(url, {
        method: 'HEAD', redirect: 'error', cache: 'no-store',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      return unknown(ecosystem, name, 'oversized PyPI metadata could not be verified by the official JSON endpoint');
    }

    const contentType = confirmation.headers?.get?.('content-type') || '';
    if (!confirmation.ok || !/application\/json/i.test(contentType)) {
      return unknown(ecosystem, name, 'oversized PyPI metadata could not be verified by the official JSON endpoint');
    }

    return {
      status: 'REGISTRY_EXISTS_REVIEW_REQUIRED', ecosystem, name,
      registry: 'https://pypi.org', corpusCoverage: 'covered-no-match',
      message: 'The exact PyPI JSON endpoint confirmed this package exists, but its metadata exceeded the checker size limit. This is not a safety or trust verdict; verify the package against its canonical maintainer documentation and source before proposing or installing it.',
    };
  }
  const returnedName = ecosystem === 'pypi' ? metadata?.info?.name : metadata?.name;
  const exact = typeof returnedName === 'string' && (ecosystem === 'pypi'
    ? normalizePypiName(returnedName) === normalizePypiName(name)
    : returnedName.toLowerCase() === name.toLowerCase());
  if (!exact) return unknown(ecosystem, name, 'registry response did not identify the exact requested package');

  const rawVersion = String(ecosystem === 'pypi' ? metadata.info.version || '' : metadata.version || '');
  const version = /^[A-Za-z0-9.+!_-]{1,100}$/.test(rawVersion) ? rawVersion : '';
  return {
    status: 'REGISTRY_EXISTS_REVIEW_REQUIRED', ecosystem, name, version,
    registry: ecosystem === 'pypi' ? 'https://pypi.org' : 'https://registry.npmjs.org',
    corpusCoverage: ecosystem === 'pypi' ? 'covered-no-match' : 'not-covered',
    message: ecosystem === 'pypi'
      ? 'The exact name exists in PyPI and did not match this pinned dataset. This is not a safety or trust verdict; verify the package against its canonical maintainer documentation and source before proposing or installing it.'
      : 'The exact name exists in npm, but the Trend Micro corpus contains Python module data and does not cover npm. This is not a safety verdict; verify the package against its canonical maintainer documentation and source before proposing or installing it.',
  };
}

export const packageCorpusStats = Object.freeze({ uniqueNormalizedNames: corpusIndex.size });
