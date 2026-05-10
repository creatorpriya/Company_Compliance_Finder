// =====================================================================================
//  POLYFILL FOR Node 18
// =====================================================================================

if (typeof global.File === 'undefined') {
    class FilePolyfill {
        constructor(bits = [], name = '', options = {}) {
            this.bits = bits;
            this.name = name;
            this.lastModified = options.lastModified || Date.now();
            this.type = options.type || '';
        }
    }
    global.File = FilePolyfill;
    globalThis.File = FilePolyfill;
}

// =====================================================================================
//  IMPORTS
// =====================================================================================

const fs = require('fs');
const axios = require('axios');
const cheerio = require('cheerio');
const { chromium } = require('playwright');
//const { parse } = require('json2csv');
const { MongoClient } = require('mongodb');

// =====================================================================================
//  CONFIG
// =====================================================================================

const config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));

const {
    HOST,
    PORTEND_EMAIL,
    PORTEND_PASSWORD,
    MONGO_URI,
    CompaniesToProcess,
    CONCURRENCY,
    DB_NAME,
    COLLECTION_NAME
} = config;

// =====================================================================================
//  CONSTANTS (BATCH CONTROL)
// =====================================================================================

const BATCH_SIZE = 100;
const BATCH_DELAY_MINUTES = 3;
const BATCH_DELAY_MS = BATCH_DELAY_MINUTES * 60 * 1000;

const TEST_MODE = false;       // true = local testing, false = production
const FAST_TEST_MODE = false;  // skips slow crawling in test mode

// =====================================================================================
//  HELPERS
// =====================================================================================

function logProgress(message) {
    console.log(`[${new Date().toISOString()}] ${message}`);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// =====================================================================================
//  COMPANY FETCH CONFIG
// =====================================================================================

function getCompanyFetchConfig(option) {
    switch (String(option).toLowerCase()) {
        case '100':
            return { limit: 100, usedInCheck: undefined, fetchAll: false };
        case '500':
            return { limit: 500, usedInCheck: undefined, fetchAll: false };
        case 'usedinchecks':
        case 'usedincheck':
            return { limit: 500, usedInCheck: true, fetchAll: true };
        case 'all':
        default:
            return { limit: 500, usedInCheck: undefined, fetchAll: true };
    }
}

const companyFetchConfig = getCompanyFetchConfig(CompaniesToProcess);

// =====================================================================================
//  SIMPLE CONCURRENCY HELPER
// =====================================================================================

async function mapWithConcurrency(items, mapper, concurrency) {
    let idx = 0;

    async function worker() {
        while (true) {
            const i = idx++;
            if (i >= items.length) break;
            await mapper(items[i], i);
        }
    }

    const workers = Array.from(
        { length: Math.min(concurrency, items.length || 1) },
        worker
    );

    await Promise.all(workers);
}

// =====================================================================================
//  MONGODB
// =====================================================================================

let mongoClient;
let mongoCollection;
let complianceLogCollection;
let mongoInitialized = false;

async function initMongo() {
    if (mongoInitialized) return;

    try {
        mongoClient = new MongoClient(MONGO_URI);
        await mongoClient.connect();

        const db = mongoClient.db(DB_NAME);
        mongoCollection = db.collection(COLLECTION_NAME);
        complianceLogCollection = db.collection("log");

        mongoInitialized = true;
        logProgress('✔ MongoDB connected');
    } catch (err) {
        throw new Error("MongoDB connection failed: " + err.message);
    }
}

// =====================================================================================
//  PORTEND API
// =====================================================================================

async function loginToPortend() {
    const res = await axios.post(
        `${HOST}/nexus/v1/login`,
        {
            email: PORTEND_EMAIL,
            password: PORTEND_PASSWORD
        },
        { timeout: 8000 }
    );

    return res.data?.data?.sessionId;
}

async function getCompanies(sessionId, skip, limit, usedInCheck) {
    const url =
        `${HOST}/nexus/v1/companies?skip=${skip}&limit=${limit}` +
        (usedInCheck ? `&usedInCheck=true` : '');

    const res = await axios.get(url, {
        headers: { sessionId },
        timeout: 8000
    });

    return res.data?.data?.list || [];
}

// =====================================================================================
//  NEXUS WEBPAGE API
// =====================================================================================

async function fetchHtmlViaNexus(sessionId, url) {
    const resp = await axios.post(
        `${HOST}/nexus/v1/webpages`,
        { url, type: 'html' },
        { 
            headers: { sessionId },
            timeout: TEST_MODE ? 4000 : 10000   // ⚡ faster in test, safe in prod
        }
    );
    return resp.data?.data?.html || '';
}

// =====================================================================================
//  AXIOS HTML FETCH (PRIMARY)
// =====================================================================================
async function fetchHtmlViaAxios(url) {
    try {
        const timeout = TEST_MODE && FAST_TEST_MODE ? 3000 : 8000;

        const res = await axios.get(url, {
            timeout,
            validateStatus: () => true,
            headers: {
                'User-Agent': 'Mozilla/5.0',
                'Accept': 'text/html,application/xhtml+xml',
                'Accept-Language': 'en-US,en;q=0.9'
            }
        });

        if (res.status >= 400 || !res.data) return '';
        return typeof res.data === 'string' ? res.data : '';
    } catch {
        return '';
    }
}
// =====================================================================================
//  COMPLIANCE URL LOGIC
// =====================================================================================

async function findComplianceUrls(domain) {
    const root = domain.replace(/^www\./, '');

    const candidates = [

        // ================= EXISTING =================
        `https://trust.${root}`,
        `https://${root}/trust`,
        `https://${root}/trust/`,
        `https://trust-center.${root}`,
        `https://security.${root}`,
        `https://${root}/security`,
        `https://${root}/security/`,
        `https://compliance.${root}`,
        `https://${root}/compliance`,
        `https://${root}/compliance/`,

        // ================= NEW (IMPORTANT) =================

        // 🔥 Legal pages (VERY COMMON)
        `https://${root}/legal`,
        `https://${root}/legal/`,
        `https://${root}/legal/compliance`,
        `https://${root}/legal-compliance`,
        `https://${root}/legal-compliance/`,
        `https://${root}/press`,
        `https://${root}/press/`,

        // 🔥 Security / data security pages
        `https://${root}/data-security`,
        `https://${root}/data-security/`,
        `https://${root}/security/compliance`,
        `https://${root}/security/compliance/`,

        // 🔥 Trust + compliance combined
        `https://${root}/trust/compliance`,
        `https://${root}/trust-center`,
        `https://${root}/trust-center/`,

        // 🔥 Privacy / governance (sometimes contains compliance)
        `https://${root}/governance`,
        `https://${root}/governance/`,

        // 🔥 About / security pages (ADP type)
        `https://${root}/about/data-security`,
        `https://${root}/about/security`,
        `https://${root}/about/security/`,
        `https://${root}/about/certifications`,
        `https://${root}/about/certifications/`,
        `https://${root}/accessible`,
        `https://${root}/accessibility`,
        `https://${root}/accessibility/`,
        `https://${root}/compliance-and-accessibility`,

        // 🔥 Zoom-like structure
        `https://${root}/trust/legal-compliance`,
        `https://${root}/trust/legal-compliance/`,
        `https://${root}/data-security.aspx`,
        `https://${root}/security.aspx`,
        `https://${root}/legal.aspx`,
        `https://${root}`,
    ];

    const validUrls = [];

    for (const url of candidates) {
        try {
            const res = await axios.get(url, {
                timeout: 6000,
                validateStatus: () => true
            });

            if (res.status < 400 && typeof res.data === 'string') {
                validUrls.push(url);
            }
        } catch {}
    }

    return validUrls;
}

async function findTrustCenterFromHomepage(domain) {
    const root = domain.replace(/^www\./, '');

    try {
        const res = await axios.get(`https://${root}`, {
            timeout: 8000,
            validateStatus: () => true
        });

        if (res.status >= 400 || !res.data) return [];

        const $ = cheerio.load(res.data);

        const TRUST_PATTERNS = [
            'trust.vanta.com',
            'trust.drata.com',
            'trust.secureframe.com',

            'trust-center',
            'trust.',
            'security',
            'compliance',

            // new
            'legal',
            'legal-compliance',
            'data-security',
            'governance',
            'privacy',
            'risk',

            'whistic.com',
            'onetrust.com',
            'conveyor.com'
        ];

        const links = new Set();

        // ✅ capture homepage redirect (correct place)
        if (res.request?.res?.responseUrl) {
            links.add(res.request.res.responseUrl);
        }

        $('a[href]').each((_, el) => {
            let href = $(el).attr('href');
            if (!href) return;

            // normalize
            if (href.startsWith('//')) {
                href = 'https:' + href;
            } else if (href.startsWith('/')) {
                href = `https://${root}${href}`;
            }

            if (
                TRUST_PATTERNS.some(pattern =>
                    href.toLowerCase().includes(pattern)
                )
            ) {
                links.add(href);
            }
        });

        return [...links];
    } catch {
        return [];
    }
}

// =====================================================================================
//  COMPLIANCE NORMALIZATION + JSON EXTRACTION
// =====================================================================================

function normalizeCertification(slug) {
    const MAP = {
        'soc2-type-2': 'SOC 2 TYPE II',
        'soc2-type-1': 'SOC 2 TYPE I',
        'soc3': 'SOC 3',
        'iso 9001':'ISO 9001',
        'iso-27001': 'ISO 27001',
        'iso-27001-2013': 'ISO 27001:2013',
        'iso-27001-2022': 'ISO 27001:2022',
        'iso-27017': 'ISO 27017',
        'iso-27018': 'ISO 27018',
        'gdpr': 'GDPR',
        'hipaa': 'HIPAA',
        'ccpa': 'CCPA',
        'pci': 'PCI',
        'fedramp': 'FEDRAMP',
        'fedramp-moderate': 'FEDRAMP MODERATE',
        'stateramp': 'GOVRAMP',
        'cyber-essentials': 'CYBER ESSENTIALS',
        'cyber-essentials-plus': 'CYBER ESSENTIALS PLUS',
        'sig': 'SIG',
        'sbdp': 'SECURE BY DESIGN PLEDGE',
        'hitrust': 'HITRUST',
        'csa': 'CSA STAR'
    };

    return MAP[slug] || slug.toUpperCase().replace(/-/g, ' ');
}

function extractComplianceFromEmbeddedJson(html) {
    if (!html) return [];

// --------------------------------------------------
// TRY MULTIPLE JSON SOURCES (KEEP THIS)
// --------------------------------------------------

// 1. Generic JSON inside script (MOST USEFUL)
let match = html.match(/<script[^>]*>[\s\S]*?({[\s\S]*?"certifications"[\s\S]*?})[\s\S]*?<\/script>/i);

// 2. API-like embedded JSON
if (!match) {
    match = html.match(/"certifications"\s*:\s*(\[[\s\S]*?\])/i);
}

// 3. OLD Vanta (LOW PRIORITY - optional)
if (!match) {
    match = html.match(/window\.VENDOR_REPORT\s*=\s*({[\s\S]*?});/);
}

if (match) {
    try {
        const json = JSON.parse(match[1]);

        const certs =
            json?._embedded?.canonical_asset?.certifications ||
            json?.certifications ||
            json?.data?.certifications ||
            [];

        if (certs.length) {
            return certs.map(normalizeCertification);
        }
    } catch {}
}

    // --------------------------------------------------
    // 2. BONUS: Fallback for Vanta / Drata / Secureframe
    // --------------------------------------------------

    const text = html.toUpperCase();

    const found = new Set();

    // SOC 2 (generic)
    if (/\bSOC\s*2\b/.test(text)) {
        found.add('SOC 2');
    }

    // SOC 2 TYPE II
    if (/SOC\s*2([\s\S]{0,80})TYPE\s*(II|2)/i.test(text)) {
        found.add('SOC 2 TYPE II');
    }

    // SOC 2 TYPE I
    if (/SOC\s*2([\s\S]{0,80})TYPE\s*(I|1)/i.test(text)) {
        found.add('SOC 2 TYPE I');
    }

    // ISO
    if (/ISO\s*27001/i.test(text)) {
        found.add('ISO 27001');
    }

    if (/ISO\s*27018/i.test(text)) {
        found.add('ISO 27018');
    }

    // GDPR
    if (/\bGDPR\b/i.test(text)) {
        found.add('GDPR');
    }

    // HIPAA
    if (/\bHIPAA\b/i.test(text)) {
        found.add('HIPAA');
    }

    // CCPA
    if (/\bCCPA\b/i.test(text)) {
        found.add('CCPA');
    }

    // PCI
    if (/\bPCI\b/i.test(text)) {
        found.add('PCI');
    }

    // FEDRAMP
    if (/FEDRAMP/i.test(text)) {
        found.add('FEDRAMP');
    }

    // CSA STAR
    if (/CSA\s*STAR/i.test(text)) {
        found.add('CSA STAR');
    }

    // --------------------------------------------------
    // 3. CLEANUP (IMPORTANT)
    // --------------------------------------------------

    // Remove generic SOC 2 if TYPE exists
    if (found.has('SOC 2 TYPE II') || found.has('SOC 2 TYPE I')) {
        found.delete('SOC 2');
    }

    // 🔥 EXTRA: handle "TYPE 2" written without SOC nearby
    if (/TYPE\s*(II|2)\s*(AUDIT|REPORT)?/i.test(text) && /\bSOC\s*2\b/i.test(text)) {
        found.add('SOC 2 TYPE II');
    }

    return [...found];
}

// ==================================================
// DRATA (GraphQL) SUPPORT
// ==================================================

function extractSlugId(html) {
    const match = html.match(/"slugId"\s*:\s*"([a-z0-9]+)"/i);
    return match ? match[1] : null;
}

async function fetchDrataGraphQL(slugId) {
    try {
        const res = await axios.post(
            'https://api.drata.com/graphql',
            {
                operationName: "fetchDataForTrustReport",
                variables: { slugId },
                query: `query fetchDataForTrustReport($slugId: String!) {
                    trust {
                        trustReportBySlugId(slugId: $slugId) {
                            resourceCategories { name }
                            frameworks { name }
                        }
                    }
                }`
            },
            {
                headers: { 'content-type': 'application/json' },
                timeout: 10000
            }
        );

        return res.data?.data?.trust?.trustReportBySlugId;
    } catch {
        return null;
    }
}

async function fetchVantaData(html) {
    try {
        const match = html.match(/"vendorId"\s*:\s*"([a-z0-9-]+)"/i);
        if (!match) return [];

        const vendorId = match[1];

        const res = await axios.get(
            `https://api.vanta.com/v1/public/vendors/${vendorId}`,
            { timeout: 10000 }
        );

        const certs = res.data?.certifications || [];

        return certs.map(c => c.name.toUpperCase());
    } catch {
        return [];
    }
}

// ==================================================
// 🔥 PLAYWRIGHT GRAPHQL SCRAPER (VANTA / WEVO FIX)
// ==================================================

async function fetchComplianceViaPlaywright(url) {
    let browser;

    try {
        browser = await chromium.launch({ headless: true });
        const page = await browser.newPage();

        const apiData = [];

        // capture API responses
        page.on('response', async (response) => {
            const type = response.request().resourceType();

            if (type === 'xhr' || type === 'fetch') {
                try {
                    const json = await response.json();

                    // 🔥 IMPORTANT: filter useful GraphQL responses
                    if (response.url().includes('graphql')) {
                        apiData.push(json);
                    } 
                } catch {}
            }
        });

        await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });

        await browser.close();

        // ----------------------------------------
        // PARSE API DATA
        // ----------------------------------------

        const found = new Set();

        apiData.forEach(data => {
            const text = JSON.stringify(data).toUpperCase();
        
            // ✅ GDPR (important for wevo)
            if (text.includes('GDPR')) found.add('GDPR');
        
            // SOC
            if (text.includes('SOC 2 TYPE II')) found.add('SOC 2 TYPE II');
            else if (text.includes('SOC 2 TYPE I')) found.add('SOC 2 TYPE I');
            else if (text.includes('SOC 2')) found.add('SOC 2');
        
            // ISO
            if (text.includes('ISO 27001')) found.add('ISO 27001');
        
            // Others
            if (text.includes('HIPAA')) found.add('HIPAA');
            if (text.includes('CCPA')) found.add('CCPA');
        });

        // cleanup
        if (found.has('SOC 2 TYPE II') || found.has('SOC 2 TYPE I')) {
            found.delete('SOC 2');
        }

        return [...found];

    } catch (err) {
        if (browser) await browser.close();
        return [];
    }
}

function extractComplianceFromDrata(data) {
    if (!data) return [];

    const found = new Set();

    // resourceCategories (main signal)
    (data.resourceCategories || []).forEach(cat => {
        const name = cat.name.toUpperCase();

        if (name.includes('SOC 2') && name.includes('TYPE 2')) {
            found.add('SOC 2 TYPE II');
        } else if (name.includes('SOC 2') && name.includes('TYPE 1')) {
            found.add('SOC 2 TYPE I');
        } else if (name.includes('SOC 2')) {
            found.add('SOC 2');
        }

        if (name.includes('HIPAA')) found.add('HIPAA');
    });

    // frameworks (backup)
    (data.frameworks || []).forEach(f => {
        const name = f.name.toUpperCase();

        if (name.includes('ISO 27001')) found.add('ISO 27001');
        if (name.includes('GDPR')) found.add('GDPR');
        if (name.includes('HIPAA')) found.add('HIPAA');
    });

    // cleanup
    if (found.has('SOC 2 TYPE II') || found.has('SOC 2 TYPE I')) {
        found.delete('SOC 2');
    }

    return [...found];
}

// ==================================================
// VANTA SUPPORT (NEW)
// ==================================================

function extractVantaData(html) {
    try {
        const match = html.match(/window\.__INITIAL_STATE__\s*=\s*({[\s\S]*?});/);

        if (!match) return [];

        const json = JSON.parse(match[1]);

        const certs =
            json?.vendor?.certifications ||
            json?.certifications ||
            [];

        if (!certs.length) return [];

        return certs.map(c =>
            (c.name || c.slug || '').toUpperCase()
        );
    } catch {
        return [];
    }
}

// =====================================================================================
//  COMPLIANCE PARSER (NEXUS)
// =====================================================================================

async function parseComplianceFromPage(sessionId, complianceUrl) {
    try {
        const html = await fetchHtmlViaNexus(sessionId, complianceUrl);
        if (!html) return [];


        const jsonCompliance = extractComplianceFromEmbeddedJson(html);
        if (jsonCompliance.length) {
            return [...new Set(jsonCompliance)];
        }

        // 🔥 VANTA SUPPORT (ADD HERE)
        const vantaCompliance = await fetchVantaData(html);
        if (vantaCompliance.length) {
            return vantaCompliance;
        }

        const slugId = extractSlugId(html);

        if (slugId) {
            const drataData = await fetchDrataGraphQL(slugId);
            const drataCompliance = extractComplianceFromDrata(drataData);
        
            if (drataCompliance.length) {
                return drataCompliance;
            }
        }

        const $ = cheerio.load(html);
        const text = $('body').text().replace(/\s+/g, ' ').toUpperCase();

        const PATTERNS = [
        // SOC 2 TYPE II (VERY ROBUST)
        {
            name: 'SOC 2 TYPE II',
            regex: /\bSOC\s*2\b[\s\S]{0,120}\b(TYPE\s*(II|2)|T2)\b/i
        },
        
        // SOC 2 TYPE I
        {
            name: 'SOC 2 TYPE I',
            regex: /\bSOC\s*2\b[\s\S]{0,120}\b(TYPE\s*(I|1)|T1)\b/i
        },
        
        // SOC 2 generic
        {
            name: 'SOC 2',
            regex: /\bSOC\s*2\b/i
        },
            
        // SOC 3
        {
            name: 'SOC 3',
            regex: /\bSOC\s*3\b/i
        },
    
        // GDPR (badge / footer / policy section)
        {
            name: 'GDPR',
            regex: /\bGDPR\b/i
        },
    
        // ISO
        {
            name: 'ISO 27001',
            regex: /ISO\s*27001/i
        },
        {
            name: 'ISO 27018',
            regex: /ISO\s*27018/i
        },

    // Others (future-proof)
    {
        name: 'HIPAA',
        regex: /\bHIPAA\b/i
    },
    {
        name: 'CCPA',
        regex: /\bCCPA\b/i
    },
    {
        name: 'PCI',
        regex: /\bPCI\b/i
    },
    {
        name: 'FEDRAMP',
        regex: /FEDRAMP/i
    },
    {
        name: 'CSA STAR',
        regex: /CSA\s*STAR/i
    }
];

        const found = new Set();

        for (const { name, regex } of PATTERNS) {
            if (regex.test(text)) {
                found.add(name);
            }
        }
        
        // ✅ BONUS: remove duplicate SOC 2 if TYPE exists
        if (found.has('SOC 2 TYPE II') || found.has('SOC 2 TYPE I')) {
            found.delete('SOC 2');
        }

        // 🔥 EXTRA FALLBACK: detect from HTML (badges / hidden text)
if (!found.size) {
    const raw = html.toUpperCase();

    if (raw.includes('SOC2') || raw.includes('SOC 2')) {
        found.add('SOC 2');
    }

    if (raw.includes('ISO27001') || raw.includes('ISO 27001')) {
        found.add('ISO 27001');
    }

    if (raw.includes('GDPR')) {
        found.add('GDPR');
    }
}

    // ==================================================
    // 🔥 FINAL FALLBACK → PLAYWRIGHT
    // ==================================================

    const playwrightData = await fetchComplianceViaPlaywright(complianceUrl);

    if (playwrightData.length) {
        return playwrightData;
    }
        
        return [...found];
    } catch {
        return [];
    }
}

// =====================================================================================
//  COMPLIANCE PARSER (AXIOS)
// =====================================================================================

async function parseComplianceViaAxios(complianceUrl) {
    const html = await fetchHtmlViaAxios(complianceUrl);
    if (!html) return [];

    const jsonCompliance = extractComplianceFromEmbeddedJson(html);
    if (jsonCompliance.length) {
        return [...new Set(jsonCompliance)];
    }

        // ✅ VANTA CHECK (ADD HERE)
    const vantaCompliance = extractVantaData(html);
    if (vantaCompliance.length) {
        return vantaCompliance;
    }

    // ==================================================
    // 🔥 DRATA GRAPHQL (NEW FIX)
    // ==================================================
    
    const slugId = extractSlugId(html);
    
    if (slugId) {
        const drataData = await fetchDrataGraphQL(slugId);
        const drataCompliance = extractComplianceFromDrata(drataData);
    
        if (drataCompliance.length) {
            return drataCompliance;
        }
    }

    const $ = cheerio.load(html);
    const text = $('body').text().replace(/\s+/g, ' ').toUpperCase();

    const PATTERNS = [

        // SOC 2 TYPE II (VERY ROBUST)
    {
        name: 'SOC 2 TYPE II',
        regex: /\bSOC\s*2\b[\s\S]{0,120}\b(TYPE\s*(II|2)|T2)\b/i
    },
    
    // SOC 2 TYPE I
    {
        name: 'SOC 2 TYPE I',
        regex: /\bSOC\s*2\b[\s\S]{0,120}\b(TYPE\s*(I|1)|T1)\b/i
    },
    
    // SOC 2 generic
    {
        name: 'SOC 2',
        regex: /\bSOC\s*2\b/i
    },


    { name: 'SOC 3', regex: /\bSOC\s*3\b/i },
    { name: 'ISO 27001', regex: /ISO\s*27001/i },
    { name: 'ISO 27018', regex: /ISO\s*27018/i },
    { name: 'GDPR', regex: /\bGDPR\b/i },
    { name: 'HIPAA', regex: /\bHIPAA\b/i },
    { name: 'CCPA', regex: /\bCCPA\b/i },
    { name: 'PCI', regex: /\bPCI\b/i },
    { name: 'FEDRAMP', regex: /FEDRAMP/i },
    { name: 'CSA STAR', regex: /CSA\s*STAR/i }
];

    const found = new Set();

    for (const { name, regex } of PATTERNS) {
        if (regex.test(text)) {
            found.add(name);
        }
    }
    
    // ✅ BONUS: remove duplicate SOC 2 if TYPE exists
    if (found.has('SOC 2 TYPE II') || found.has('SOC 2 TYPE I')) {
        found.delete('SOC 2');
    }

    // 🔥 EXTRA FALLBACK: detect from HTML (badges / hidden text)
if (!found.size) {
    const raw = html.toUpperCase();

    if (raw.includes('SOC2') || raw.includes('SOC 2')) {
        found.add('SOC 2');
    }

    if (raw.includes('ISO27001') || raw.includes('ISO 27001')) {
        found.add('ISO 27001');
    }

    if (raw.includes('GDPR')) {
        found.add('GDPR');
    }
}

    // ==================================================
    // 🔥 FINAL FALLBACK → PLAYWRIGHT (VERY IMPORTANT)
    // ==================================================

    const playwrightData = await fetchComplianceViaPlaywright(complianceUrl);

    if (playwrightData.length) {
        return playwrightData;
    }
    
    return [...found];
}

// =====================================================================================
//  CSV
// =====================================================================================

// const CSV_FILE = 'company_compliance3.csv';
// let csvHeaderWritten = false;

// // Reset CSV file at start of each run
// if (fs.existsSync(CSV_FILE)) {
//     fs.unlinkSync(CSV_FILE);
// }

// function saveToCSV(row) {
//     const csv = parse([row], { header: !csvHeaderWritten });
//     fs.appendFileSync(CSV_FILE, csv + '\n', 'utf8');
//     csvHeaderWritten = true;
// }

// =====================================================================================
//  MAIN
// =====================================================================================

async function main() {
    logProgress('Starting main');

    await initMongo();

    const sessionId = await loginToPortend();
    if (!sessionId) throw new Error('Login failed');

    logProgress('✔ Logged in');

    // --------------------------------------------------
    // FETCH COMPANIES (FULL ITERATION BASED ON CONFIG)
    // --------------------------------------------------

    let skip = 0;
    let companies = [];

    while (true) {
        const batch = await getCompanies(
            sessionId,
            skip,
            companyFetchConfig.limit,
            companyFetchConfig.usedInCheck
        );

        if (!batch.length) break;

        companies.push(...batch);
        skip += companyFetchConfig.limit;

        if (!companyFetchConfig.fetchAll &&
            companies.length >= companyFetchConfig.limit) {
            companies = companies.slice(0, companyFetchConfig.limit);
            break;
        }
    }

    logProgress(`✔ Companies fetched: ${companies.length}`);

    // --------------------------------------------------
    // PROCESS IN BATCHES OF 100 (THROTTLING ONLY)
    // --------------------------------------------------

    let totalProcessed = 0;
    let totalBatches = 0;

    const startIndex = Math.min(0, companies.length);

    for (let i = startIndex; i < companies.length; i += BATCH_SIZE) {
        totalBatches++;

        const batch = companies.slice(i, i + BATCH_SIZE);
        logProgress(`🚀 Processing batch ${totalBatches} (${batch.length} companies)`);

        let batchProcessed = 0;


        await mapWithConcurrency(
    batch,
    async (c, idx) => {

        if (!c.domain) {
            logProgress(`⚠️ Skipping company ${c.id}: no domain`);
            return;
        }

        try {
            const index = i + idx + 1;
            logProgress(`🔍 ${index}/${companies.length}: ${c.domain}`);


            const directUrls = await findComplianceUrls(c.domain);
            const homepageUrls = await findTrustCenterFromHomepage(c.domain);
            
            // merge + dedupe
            const urls = [...new Set([...directUrls, ...homepageUrls])];

            let compliance = [];
            let finalUrl = null;
            
            for (const url of urls) {

                // 1. Try Axios
                let axiosCompliance = await parseComplianceViaAxios(url);
            
                // 2. Try Nexus (always, not only fallback)
                let nexusCompliance = [];
            
                if (!TEST_MODE) {
                    nexusCompliance = await parseComplianceFromPage(sessionId, url);
                }
            
                // 3. Merge results
                const merged = [...new Set([...axiosCompliance, ...nexusCompliance])];
            
                if (merged.length) {
                    compliance = merged;
                    finalUrl = url;
                    break;
                }
            }
                        
            // better fallback URL
            if (!finalUrl && urls.length) {
                finalUrl =
                    urls.find(u =>
                    u.includes('trust') ||
                    u.includes('security') ||
                    u.includes('vanta') ||
                    u.includes('drata')
                ) ||
                    urls[0];
            }
            
            const doc = {
                companyId: c.id,
                companyDomain: c.domain,
                complianceUrl: finalUrl || 'none',
                compliance,
                ts: new Date().toISOString()
            };

            // saveToCSV(doc);

            // logProgress(`📝 CSV saved for ${c.domain}`);

            await mongoCollection.updateOne(
                { companyId: c.id },
                { $set: doc },
                { upsert: true }
            );

            batchProcessed++;
            totalProcessed++;

        } catch (err) {
            logProgress(`❌ Error processing ${c.domain}: ${err.message}`);
        }
    },
    CONCURRENCY
);


        // --------------------------------------------------
        // MAIN COLLECTION CONFIRMATION
        // --------------------------------------------------
        
        logProgress(
            `📦 Main collection updated: ${batchProcessed} companies (total ${totalProcessed})`
        );
        
        // --------------------------------------------------
        // LOG COLLECTION UPDATE (AFTER EACH BATCH)
        // --------------------------------------------------

    await complianceLogCollection.updateOne(
    { name: "company_compliance_finder" },   // filter
    {
        $set: {
            batchNumber: totalBatches,
            batchProcessed,
            processedCount: totalProcessed,
            date: new Date().toISOString(),
            scope: CompaniesToProcess
        }
    },
    { upsert: true } // insert if not exists
);
        
    
// --------------------------------------------------
// BATCH THROTTLING
// --------------------------------------------------

if (i + BATCH_SIZE < companies.length) {
    logProgress(`⏸ Waiting ${BATCH_DELAY_MINUTES} minutes before next batch`);
    await sleep(BATCH_DELAY_MS);
}

    }

// END OF FULL ITERATION
    logProgress(
        `🧾 Batch log inserted | Batch: ${totalBatches}, Total processed: ${totalProcessed}`
    );


    logProgress('🎉 Completed');
}

// ==================================================
// RUN LOCK (PREVENT OVERLAPPING RUNS)
// ==================================================

let isRunning = false;

async function safeMain() {
    if (isRunning) {
        logProgress("⚠️ Previous run still in progress. Skipping.");
        return;
    }

    isRunning = true;
    try {
        await main();
    } finally {
        isRunning = false;
    }
}

async function testComplianceFinderLocally() {
    const testCompanies = [
        { id: "test1", domain: "custodiabank.com" },
        { id: "test2", domain: "poweredbyash.com" },
        { id: "test3", domain: "azarahealthcare.com" },
        { id: "test4", domain: "tcs.com" },
        { id: "test5", domain: "blockchair.com" }
    ];

    console.log("🧪 Running COMPLIANCE Finder in TEST MODE...\n");

    await mapWithConcurrency(testCompanies, async (c) => {
        console.log(`🔎 Testing: ${c.domain}`);

        const directUrls = await findComplianceUrls(c.domain);
        const homepageUrls = await findTrustCenterFromHomepage(c.domain);
        
        // merge + remove duplicates
        const urls = [...new Set([...directUrls, ...homepageUrls])];

        let compliance = [];
        let finalUrl = null;
        
        for (const url of urls) {
            compliance = await parseComplianceViaAxios(url);
        
            if (compliance.length) {
                finalUrl = url;
                break;
            }
        }
        
        if (!finalUrl && urls.length) {
            finalUrl =
                urls.find(u =>
                    u.includes('trust') ||
                    u.includes('security') ||
                    u.includes('vanta') ||
                    u.includes('drata')
                ) ||
                urls[0];
        }
        
        console.log({
            domain: c.domain,
            complianceUrl: finalUrl || 'none',
            compliance
        });

        console.log("--------------------------------------------------\n");
    }, 3);
}


if (TEST_MODE) {
    testComplianceFinderLocally();
} else {
    safeMain().catch(err =>
        logProgress(`❌ Fatal error in main(): ${err?.stack || err}`)
    );

    setInterval(() => {
        logProgress('⏰ Scheduled run started');
        safeMain().catch(err =>
            logProgress(`❌ Unhandled error in scheduled main(): ${err?.stack || err}`)
        );
    }, 24 * 60 * 60 * 1000);
}

