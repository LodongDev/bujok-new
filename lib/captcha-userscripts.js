// 사용자 검증된 userscript 그대로 — CDP Page.addScriptToEvaluateOnNewDocument로 주입
// 모든 새 document(메인 페이지 + iframe)에서 자동 실행됨
// Violentmonkey 같은 효과 — URL 필터링은 스크립트 내부 location 검사로 대신함

// 1. hCaptcha iframe 안 #checkbox 인간형 클릭
const HCAPTCHA_SOLVER = `
(function() {
    'use strict';
    // hCaptcha iframe만 활성화
    if (!location.host.includes('hcaptcha.com')) return;
    if (window.__bujok_hcap_loaded) return;
    window.__bujok_hcap_loaded = true;

    const CHECKBOX_SELECTOR = "#checkbox";
    const ARIA_CHECKED = "aria-checked";
    const log = (msg) => console.log('[CaptchaSolver] ' + msg);

    const gaussRandom = (min, max) => {
        let u = 0, v = 0;
        while(u === 0) u = Math.random();
        while(v === 0) v = Math.random();
        let num = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
        num = num / 10.0 + 0.5;
        if (num > 1 || num < 0) return Math.floor(Math.random() * (max - min + 1) + min);
        return Math.floor(num * (max - min + 1) + min);
    };

    const triggerMouseEvent = (node, eventType, x, y) => {
        const mouseEvent = new MouseEvent(eventType, {
            view: window, bubbles: true, cancelable: true,
            clientX: x, clientY: y, button: 0,
        });
        node.dispatchEvent(mouseEvent);
    };

    const humanClick = (node) => {
        const rect = node.getBoundingClientRect();
        const x = rect.left + (Math.random() * (rect.width * 0.8)) + (rect.width * 0.1);
        const y = rect.top + (Math.random() * (rect.height * 0.8)) + (rect.height * 0.1);
        log('Click at (' + Math.floor(x) + ', ' + Math.floor(y) + ')');
        triggerMouseEvent(node, "mouseover", x, y);
        triggerMouseEvent(node, "mousedown", x, y);
        setTimeout(() => {
            triggerMouseEvent(node, "mouseup", x, y);
            triggerMouseEvent(node, "click", x, y);
        }, gaussRandom(50, 150));
    };

    const intervalId = setInterval(() => {
        const checkbox = document.querySelector(CHECKBOX_SELECTOR);
        if (!checkbox) return;
        if (checkbox.getAttribute(ARIA_CHECKED) === "true") {
            log('Solved!');
            clearInterval(intervalId);
            return;
        }
        if (checkbox.offsetParent !== null && checkbox.getAttribute(ARIA_CHECKED) === "false") {
            clearInterval(intervalId);
            const reactionTime = gaussRandom(2000, 4500);
            log('Found checkbox, waiting ' + reactionTime + 'ms');
            setTimeout(() => humanClick(checkbox), reactionTime);
        }
    }, 1000);
})();
`;

// 2. 게임 페이지 봇 프로텍션 자동 클릭
const GAME_BOT_SOLVER = `
(function() {
    'use strict';
    // tribalwars.net 게임 페이지만 활성화
    if (!location.host.includes('tribalwars.net')) return;
    if (!location.pathname.includes('game.php')) return;
    if (window.__bujok_botbot_loaded) return;
    window.__bujok_botbot_loaded = true;

    const d = document;
    const log = (msg) => console.log('[BotSolver] ' + msg);
    const randomDelay = (min, max) => Math.floor(Math.random() * (max - min + 1) + min);

    const detectTrap = (element) => {
        try {
            if (!element) return true;
            const ctor = element.constructor && element.constructor.name;
            const known = ['HTMLDivElement','HTMLElement','HTMLAnchorElement','HTMLButtonElement','HTMLInputElement','HTMLSpanElement'];
            if (ctor && !known.includes(ctor)) return true;
            const desc = Object.getOwnPropertyDescriptor(Element.prototype, 'className');
            if (desc && desc.get && !desc.get.toString().includes('[native code]')) return true;
        } catch (e) { return true; }
        return false;
    };

    const solveBot = async () => {
        const botHeader = d.querySelector('h2');
        const isBotPage = (botHeader && botHeader.textContent.includes('Bot protection')) ||
                          d.title.includes('Bot protection') ||
                          d.querySelector('.bot-protection-row') ||
                          d.getElementById('botprotection_quest');

        if (!isBotPage) {
            setTimeout(solveBot, randomDelay(10000, 20000));
            return;
        }

        log('Bot protection page — attempting solve');
        const selectors = [
            '#botprotection_quest',
            '.btn.btn-default',
            'input[type="submit"][value*="확인"]',
            'button[type="submit"]',
        ];

        let targetBtn = null;
        for (const sel of selectors) {
            const candidates = d.querySelectorAll(sel);
            for (const el of candidates) {
                if (el && !detectTrap(el) && el.offsetParent !== null) {
                    if (sel === '.btn.btn-default') {
                        const t = el.textContent || '';
                        if (!t.includes('Begin bot protection check') &&
                            !t.includes('봇 보호') &&
                            !t.includes('Bot protection check')) continue;
                    }
                    targetBtn = el;
                    log('Target: ' + sel);
                    break;
                }
            }
            if (targetBtn) break;
        }

        if (targetBtn) {
            await new Promise(r => setTimeout(r, randomDelay(500, 1500)));
            targetBtn.click();
            log('Clicked');
            setTimeout(solveBot, randomDelay(8000, 15000));
        } else {
            setTimeout(solveBot, randomDelay(3000, 6000));
        }
    };

    if (d.readyState === 'complete') solveBot();
    else window.addEventListener('load', solveBot);
})();
`;

module.exports = { HCAPTCHA_SOLVER, GAME_BOT_SOLVER };
