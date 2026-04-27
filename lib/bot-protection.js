// 봇 프로텍션 감지 — 캡차/차단 등
// 감지되면 자동으로 DOM 덤프 저장 + 큐 정지
const { evaluate } = require('./runtime');
const fs = require('fs');
const path = require('path');
const log = require('./log');

// DOM 전체 덤프 저장 (captchas/ 폴더) — 감지 시마다 매번 저장
async function saveDomDump(cdp, sessionId, reason) {
    try {
        const dump = await evaluate(cdp, sessionId, `
            (() => {
                const info = {
                    url: location.href,
                    title: document.title,
                    ts: new Date().toISOString(),
                    bodyText: (document.body?.innerText || '').slice(0, 3000),
                    bodyClasses: document.body?.className || '',
                };
                info.iframes = [...document.querySelectorAll('iframe')].map(f => {
                    const r = f.getBoundingClientRect();
                    return { src: f.src, id: f.id, name: f.name, x: r.x, y: r.y, w: r.width, h: r.height, visible: f.offsetParent !== null };
                });
                info.topLevelElements = [...document.body?.children || []].slice(0, 30).map(el => ({
                    tag: el.tagName, id: el.id, className: (el.className||'').toString().slice(0, 120), childCount: el.children.length,
                }));
                info.captchaElements = [...document.querySelectorAll('[id*="botcheck"],[id*="captcha"],[class*="captcha"],[class*="challenge"],[class*="hcaptcha"],[data-sitekey]')].slice(0, 15).map(el => {
                    const r = el.getBoundingClientRect();
                    return { tag: el.tagName, id: el.id, className: (el.className||'').toString().slice(0,150), x: r.x, y: r.y, w: r.width, h: r.height, sitekey: el.getAttribute('data-sitekey') };
                });
                info.html = document.documentElement.outerHTML.slice(0, 15000);
                return info;
            })()
        `);
        const dir = path.join(__dirname, '..', 'captchas');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir);
        const file = path.join(dir, `${reason}-${Date.now()}.json`);
        fs.writeFileSync(file, JSON.stringify(dump, null, 2));
        log.info(`[캡차캡처] ${reason} → captchas/${path.basename(file)}`);
        return file;
    } catch (e) {
        log.warn('[캡차캡처] 실패: ' + e.message);
        return null;
    }
}

// 현재 페이지에서 봇 프로텍션 징후 감지
// 감지되면 자동 DOM 덤프 저장
async function checkBotProtection(cdp, sessionId, options = {}) {
    try {
        const result = await evaluate(cdp, sessionId, `
            (() => {
                const url = location.href;
                const body = document.body?.innerText || '';
                const html = document.documentElement?.innerHTML || '';

                // 1. 캡차 iframe (실제 이미지 챌린지)
                const challengeFrame = document.querySelector('iframe[src*="hcaptcha.com/challenge"]');
                if (challengeFrame && challengeFrame.offsetParent !== null
                    && challengeFrame.getBoundingClientRect().height > 100) {
                    return { detected: true, type: 'captcha_challenge' };
                }

                // 1b. 봇 프로텍션 진입 신호 — quest 아이콘 / 봇 프로텍션 row / h2 텍스트
                if (document.getElementById('botprotection_quest')) {
                    return { detected: true, type: 'bot_protection_quest' };
                }
                if (document.querySelector('.bot-protection-row')) {
                    return { detected: true, type: 'bot_protection_row' };
                }
                const h2 = document.querySelector('h2');
                if (h2 && /bot protection/i.test(h2.textContent || '')) {
                    return { detected: true, type: 'bot_protection_h2' };
                }
                if (/bot protection/i.test(document.title || '')) {
                    return { detected: true, type: 'bot_protection_title' };
                }

                // 2. 봇 프로텍션 전용 페이지 URL
                if (url.includes('/bot_protection') || url.includes('bot-protection')) {
                    return { detected: true, type: 'bot_protection_page' };
                }

                // 3. 세션 만료 / 로그인 페이지 리다이렉트
                if (url.includes('session_expired') || url.includes('/page/auth')) {
                    return { detected: true, type: 'session_expired' };
                }

                // 4. Cloudflare / 유사 차단 페이지
                if (body.includes('Checking your browser') || body.includes('Ray ID')
                    || html.includes('cf-chl-')) {
                    return { detected: true, type: 'cloudflare' };
                }

                // 5. "사람인지 확인" 메시지
                const text = body.toLowerCase();
                if (text.includes('verify you are human') || text.includes('bot detected')) {
                    return { detected: true, type: 'human_verify' };
                }

                return { detected: false };
            })()
        `);
        // 감지 시 매번 DOM 저장
        if (result?.detected && !options.skipDump) {
            await saveDomDump(cdp, sessionId, `detected-${result.type}`);
        }
        return result || { detected: false };
    } catch (e) {
        return { detected: false, error: e.message };
    }
}

// 응답 텍스트에서 봇 프로텍션 감지 (JSON 응답 대신 HTML이 오면 차단/캡차 가능성)
function detectFromResponse(text) {
    if (!text) return null;
    const t = text.substring(0, 500);
    if (t.startsWith('<!DOCTYPE') || t.startsWith('<html')) {
        if (t.includes('hcaptcha') || t.includes('captcha')) return 'captcha_response';
        if (t.includes('Cloudflare') || t.includes('cf-')) return 'cloudflare_response';
        return 'html_response';
    }
    if (t.startsWith('<?xml')) return 'xml_response';
    return null;
}

module.exports = { checkBotProtection, detectFromResponse, saveDomDump };
