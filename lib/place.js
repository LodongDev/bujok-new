// 광장(Place) 화면 조작 — 좌표/병력 입력, Support/Attack 버튼 클릭, confirm 대기
const { evaluate } = require('./runtime');
const { navigate, waitForLoad, waitForSelector, sleep } = require('./page');
const { moveAndClick } = require('./mouse');
const log = require('./log');

// 광장 화면으로 이동
async function gotoPlace(cdp, sessionId, baseUrl, villageId) {
    const url = `${baseUrl}/game.php?village=${villageId}&screen=place`;
    await navigate(cdp, sessionId, url);
    await waitForLoad(cdp, sessionId);
    await sleep(300 + Math.random() * 500);
}

// 좌표 + 병력 입력 (Runtime.evaluate로 DOM 값 설정)
async function fillForm(cdp, sessionId, targetX, targetY, troops) {
    await evaluate(cdp, sessionId, `
        (() => {
            // 좌표 입력 — 게임의 input 방식에 맞춤
            const ix = document.getElementById('inputx') || document.querySelector('input[name="x"]');
            const iy = document.getElementById('inputy') || document.querySelector('input[name="y"]');
            if (ix) { ix.value = ${JSON.stringify(String(targetX))}; ix.dispatchEvent(new Event('change')); }
            if (iy) { iy.value = ${JSON.stringify(String(targetY))}; iy.dispatchEvent(new Event('change')); }

            // 좌표 텍스트 입력 (게임의 coord input이 별도로 있을 수 있음)
            const coordInput = document.querySelector('#place_target input[data-type="coord"], input.target-input-field');
            if (coordInput) {
                coordInput.value = '${targetX}|${targetY}';
                coordInput.dispatchEvent(new Event('input'));
                coordInput.dispatchEvent(new Event('change'));
            }

            // 병력 입력
            const troops = ${JSON.stringify(troops)};
            for (const [unit, count] of Object.entries(troops)) {
                if (count <= 0) continue;
                const el = document.getElementById('unit_input_' + unit);
                if (el) {
                    el.value = String(count);
                    el.dispatchEvent(new Event('change'));
                    el.dispatchEvent(new Event('input'));
                }
            }
        })()
    `);
    log.debug(`폼 입력: (${targetX}|${targetY}) ${JSON.stringify(troops)}`);
}

// Support 버튼 클릭 (마우스 이벤트로 — 인간처럼)
async function clickSupport(cdp, sessionId, lastMouse) {
    const rect = await evaluate(cdp, sessionId, `
        (() => {
            const btn = document.getElementById('target_support');
            if (!btn) return null;
            btn.scrollIntoView({ block: 'center' });
            const r = btn.getBoundingClientRect();
            return { x: r.x + r.width/2, y: r.y + r.height/2 };
        })()
    `);
    if (!rect) throw new Error('Support 버튼 못 찾음');

    await moveAndClick(cdp, sessionId, lastMouse, rect);
    log.debug('Support 버튼 클릭됨');
    return rect;
}

// Attack 버튼 클릭
async function clickAttack(cdp, sessionId, lastMouse) {
    const rect = await evaluate(cdp, sessionId, `
        (() => {
            const btn = document.getElementById('target_attack');
            if (!btn) return null;
            btn.scrollIntoView({ block: 'center' });
            const r = btn.getBoundingClientRect();
            return { x: r.x + r.width/2, y: r.y + r.height/2 };
        })()
    `);
    if (!rect) throw new Error('Attack 버튼 못 찾음');

    await moveAndClick(cdp, sessionId, lastMouse, rect);
    log.debug('Attack 버튼 클릭됨');
    return rect;
}

// confirm 화면 대기 (Support/Attack 클릭 후 confirm 다이얼로그/페이지 출현)
async function waitForConfirm(cdp, sessionId, timeoutMs = 15000) {
    log.debug('confirm 화면 대기...');
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        // AJAX confirm: popup_box_command_confirm 또는 troop_confirm_submit
        // Legacy confirm: 전체 페이지 (action=command form)
        const found = await evaluate(cdp, sessionId, `
            (() => {
                // AJAX popup confirm
                const popup = document.getElementById('popup_box_command_confirm')
                    || document.getElementById('troop_confirm_go');
                if (popup && popup.offsetParent !== null) {
                    const btn = popup.querySelector('#troop_confirm_go, input[id="troop_confirm_go"]')
                        || popup.querySelector('input[type="submit"]')
                        || popup.querySelector('.btn-confirm-yes');
                    if (btn) {
                        const r = btn.getBoundingClientRect();
                        return { type: 'popup', x: r.x + r.width/2, y: r.y + r.height/2 };
                    }
                }
                // 혹시 troop_confirm_go가 직접 보이면
                const directBtn = document.getElementById('troop_confirm_go');
                if (directBtn && directBtn.offsetParent !== null) {
                    const r = directBtn.getBoundingClientRect();
                    return { type: 'direct', x: r.x + r.width/2, y: r.y + r.height/2 };
                }
                // Legacy confirm (전체 페이지에 action=command form)
                const form = document.querySelector('form[action*="action=command"]');
                if (form) {
                    const btn = form.querySelector('input[type="submit"]');
                    if (btn) {
                        const r = btn.getBoundingClientRect();
                        return { type: 'legacy', x: r.x + r.width/2, y: r.y + r.height/2 };
                    }
                }
                return null;
            })()
        `);
        if (found) {
            log.debug(`confirm 발견: ${found.type}`);
            return found;
        }
        await sleep(100);
    }
    throw new Error('confirm 화면 타임아웃');
}

// confirm OK 버튼 클릭 (발사)
async function clickConfirmOk(cdp, sessionId, confirmBtn, lastMouse) {
    await moveAndClick(cdp, sessionId, lastMouse, confirmBtn);
    log.ok('confirm OK 클릭 → 발사!');
    return confirmBtn;
}

// 가용 병력 조회 (place 화면의 data-all-count에서)
async function getAvailableTroops(cdp, sessionId) {
    return await evaluate(cdp, sessionId, `
        (() => {
            const troops = {};
            const inputs = document.querySelectorAll('input.unitsInput[data-all-count]');
            for (const inp of inputs) {
                const name = inp.getAttribute('name');
                const count = parseInt(inp.getAttribute('data-all-count')) || 0;
                if (name) troops[name] = count;
            }
            return troops;
        })()
    `);
}

module.exports = {
    gotoPlace, fillForm, clickSupport, clickAttack,
    waitForConfirm, clickConfirmOk, getAvailableTroops,
};
