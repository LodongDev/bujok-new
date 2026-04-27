// 페이지 헬퍼: navigate, waitForLoad, DOM 쿼리
const { evaluate } = require('./runtime');
const log = require('./log');

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

async function navigate(cdp, sessionId, url) {
    await cdp.send('Page.navigate', { url }, sessionId);
}

async function waitForLoad(cdp, sessionId, timeoutMs = 30000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const ready = await evaluate(cdp, sessionId, 'document.readyState');
            if (ready === 'complete') return true;
        } catch {
            // 페이지 전환 중
        }
        await sleep(150);
    }
    throw new Error('페이지 로드 타임아웃');
}

async function currentUrl(cdp, sessionId) {
    return await evaluate(cdp, sessionId, 'location.href');
}

// CSS 셀렉터로 요소의 viewport 좌표 가져오기
async function getRect(cdp, sessionId, selector) {
    const expr = `
        (() => {
            const el = document.querySelector(${JSON.stringify(selector)});
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { x: r.x, y: r.y, w: r.width, h: r.height };
        })()
    `;
    return await evaluate(cdp, sessionId, expr);
}

async function waitForSelector(cdp, sessionId, selector, timeoutMs = 10000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const rect = await getRect(cdp, sessionId, selector);
        if (rect && rect.w > 0) return rect;
        await sleep(120);
    }
    throw new Error(`요소 못 찾음: ${selector}`);
}

// 요소를 viewport 안으로 스크롤
async function scrollIntoView(cdp, sessionId, selector) {
    await evaluate(cdp, sessionId, `
        (() => {
            const el = document.querySelector(${JSON.stringify(selector)});
            if (el) el.scrollIntoView({ block: 'center', inline: 'center' });
        })()
    `);
}

// 페이지에 세션 만료 확인
async function checkSessionAlive(cdp, sessionId) {
    try {
        const html = await evaluate(cdp, sessionId, 'document.documentElement.innerHTML.slice(0, 5000)');
        if (!html) return false;
        if (html.includes('session has expired') || html.includes('screen=login')) return false;
        return true;
    } catch {
        return false;
    }
}

module.exports = {
    sleep, navigate, waitForLoad, currentUrl,
    getRect, waitForSelector, scrollIntoView, checkSessionAlive,
};
