#!/usr/bin/env node
// 열려있는 모든 tribalwars 탭의 DOM/iframe 상태를 captchas/로 덤프
// 사용법: node dump-all-tabs.js
const CDP = require('./lib/cdp');
const { evaluate } = require('./lib/runtime');
const { saveDomDump } = require('./lib/bot-protection');
const log = require('./lib/log');

(async () => {
    const cdp = new CDP('127.0.0.1', 9222);
    await cdp.connect();

    // iframe 자동 부착 — cross-origin hCaptcha iframe 안까지 들여다보기
    const iframeSessions = new Map();
    cdp.on((method, params, parentSid) => {
        if (method === 'Target.attachedToTarget') {
            const ti = params.targetInfo || {};
            if (ti.type === 'iframe') {
                iframeSessions.set(params.sessionId, { url: ti.url || '', parentSid });
                cdp.send('Target.setAutoAttach', {
                    autoAttach: true, waitForDebuggerOnStart: false, flatten: true,
                }, params.sessionId).catch(() => {});
                cdp.send('Runtime.enable', {}, params.sessionId).catch(() => {});
            }
        }
    });

    const tabs = await cdp.listTabs();
    const twTabs = tabs.filter(t => t.type === 'page' && t.url.includes('tribalwars.net'));
    log.info(`tribalwars 탭 ${twTabs.length}개 발견`);

    for (const tab of twTabs) {
        const urlMatch = tab.url.match(/https:\/\/([a-z0-9]+)\.tribalwars\.net/);
        const server = urlMatch ? urlMatch[1] : 'unknown';
        log.info(`[${server}] 부착 중: ${tab.url.slice(0, 80)}`);

        const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: tab.id, flatten: true });
        await cdp.send('Page.enable', {}, sessionId).catch(() => {});
        await cdp.send('Runtime.enable', {}, sessionId).catch(() => {});
        await cdp.send('Target.setAutoAttach', {
            autoAttach: true, waitForDebuggerOnStart: false, flatten: true,
        }, sessionId).catch(() => {});

        // iframe 부착 이벤트 받을 시간
        await new Promise(r => setTimeout(r, 1500));

        // 메인 페이지 덤프
        await saveDomDump(cdp, sessionId, `manual-${server}-main`);

        // 각 iframe도 덤프 (URL/title 정도만)
        for (const [sid, info] of iframeSessions.entries()) {
            try {
                const data = await evaluate(cdp, sid, `
                    (() => ({
                        url: location.href,
                        title: document.title,
                        bodyText: (document.body?.innerText || '').slice(0, 2000),
                        html: document.documentElement.outerHTML.slice(0, 10000),
                        hasCheckbox: !!document.getElementById('checkbox'),
                        checkboxAriaChecked: document.getElementById('checkbox')?.getAttribute('aria-checked'),
                        hasAnchor: !!document.getElementById('anchor-state'),
                        captchaElements: [...document.querySelectorAll('[id*="captcha"],[class*="captcha"],[class*="challenge"]')].slice(0, 10).map(el => ({
                            tag: el.tagName, id: el.id, className: (el.className||'').toString().slice(0, 150),
                        })),
                    }))()
                `);
                const fs = require('fs');
                const path = require('path');
                const dir = path.join(__dirname, 'captchas');
                if (!fs.existsSync(dir)) fs.mkdirSync(dir);
                const safeUrl = info.url.replace(/[^a-z0-9]/gi, '_').slice(0, 60);
                const file = path.join(dir, `manual-${server}-iframe-${safeUrl}-${Date.now()}.json`);
                fs.writeFileSync(file, JSON.stringify({ ...data, frameUrl: info.url }, null, 2));
                log.ok(`  iframe 덤프: ${file.split(/[\\\/]/).pop()}`);
            } catch (e) {
                log.warn(`  iframe ${info.url.slice(0, 50)} 덤프 실패: ${e.message}`);
            }
        }
        iframeSessions.clear();

        // 분리 (다음 탭 깨끗하게)
        await cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {});
    }

    log.ok('완료 — captchas/ 폴더 확인');
    cdp.close();
    process.exit(0);
})().catch(e => { log.err(e.message); process.exit(1); });
