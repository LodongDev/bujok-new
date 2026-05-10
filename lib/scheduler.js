// 공격/원군 예약 스케줄러 — 시간 되면 CDP로 진짜 Chrome에서 발사
const { evaluate } = require('./runtime');
const { navigate, waitForLoad, sleep } = require('./page');
const { gotoPlace, fillForm, clickSupport, clickAttack, waitForConfirm, clickConfirmOk, getAvailableTroops } = require('./place');
const { moveAndClick } = require('./mouse');
const { randInt } = require('./human');
const log = require('./log');

// TW 표준 분/필드 — 좌표 기반 이동시간 사전 계산용 (월드 속도 1.0 기준)
// 부대 속도 = 가장 느린 병종 결정 (각 부대 단위)
const UNIT_SPEEDS_MIN_PER_FIELD = {
    spear: 18, sword: 22, axe: 18, archer: 18,
    spy: 9, light: 10, marcher: 10, heavy: 11,
    ram: 30, catapult: 30, knight: 10, snob: 35,
};
function computeTravelMs(srcX, srcY, tgtX, tgtY, troops, worldSpeed = 1.0) {
    if (srcX == null || srcY == null || tgtX == null || tgtY == null) return null;
    const dx = tgtX - srcX, dy = tgtY - srcY;
    const dist = Math.sqrt(dx*dx + dy*dy);
    let slowestMin = 0;
    for (const [u, c] of Object.entries(troops || {})) {
        if (c > 0 && UNIT_SPEEDS_MIN_PER_FIELD[u] && UNIT_SPEEDS_MIN_PER_FIELD[u] > slowestMin) {
            slowestMin = UNIT_SPEEDS_MIN_PER_FIELD[u];
        }
    }
    if (slowestMin === 0) return null;
    return Math.round(dist * slowestMin * 60 * 1000 / worldSpeed);
}

let nextId = 1;

class Scheduler {
    constructor(cdp, sessionId, baseUrl) {
        this.cdp = cdp;
        this.sessionId = sessionId;
        this.baseUrl = baseUrl;
        this.attacks = []; // {id, type, sourceVillage, targetX, targetY, troops, arrivalTime, building, status, ...}
        this.tickInterval = null;
        this.executing = false; // 한 번에 하나만 실행
    }

    start() {
        this.tickInterval = setInterval(() => this.tick(), 1000);
        log.info('[스케줄러] 시작');
    }

    // 다음 실행까지 남은 시간 (ms). 실행 중이면 0. 예약 없으면 Infinity
    // 스캐빈징 등 저우선순위 작업이 yield할지 판단용 — fireTime 우선 (이동시간 2분+ 케이스)
    nextFireInMs() {
        if (this.executing) return 0;
        const now = Date.now();
        let earliest = Infinity;
        for (const atk of this.attacks) {
            if (atk.status !== 'waiting') continue;
            const trigger = atk.fireTime ? (atk.fireTime - 180000) : (atk.arrivalTime - 180000);
            const remain = trigger - now;
            if (remain < earliest) earliest = Math.max(0, remain);
        }
        return earliest;
    }

    isBusy() {
        return this.executing || this.nextFireInMs() < 30000; // 30초 이내 임박
    }

    stop() {
        if (this.tickInterval) clearInterval(this.tickInterval);
        log.info('[스케줄러] 정지');
    }

    // 공격/원군 예약
    schedule({ type, sourceVillageId, sourceX, sourceY, sourceName, targetX, targetY, troops, arrivalTime, building }) {
        const id = nextId++;
        const attack = {
            id,
            type: type || 'attack',          // 'attack' | 'support'
            sourceVillageId,
            sourceX, sourceY, sourceName,
            targetX: parseInt(targetX),
            targetY: parseInt(targetY),
            troops,                           // {spear: N, sword: N, ...}
            arrivalTime: new Date(arrivalTime).getTime(), // ms timestamp
            building: building || 'main',     // 'main', 'barracks', 'stable', ...
            status: 'waiting',                // 'waiting' → 'preparing' → 'ready' → 'firing' → 'done' / 'failed'
            createdAt: Date.now(),
            error: null,
            result: null,
            travelTimeMs: null,
            fireTime: null,
        };
        // 좌표 기반 사전 fire time 계산 (UI 표시 + 발사 정확도 향상용)
        // confirm 페이지 Duration이 더 정확하지만 (월드/팔라딘 보너스 등) 일단 추정값 박아둠
        const estTravelMs = computeTravelMs(sourceX, sourceY, parseInt(targetX), parseInt(targetY), troops);
        if (estTravelMs) {
            attack.travelTimeMs = estTravelMs;       // 추정값 (confirm에서 덮어씀)
            attack.fireTime = attack.arrivalTime - estTravelMs;
        }
        this.attacks.push(attack);
        const fireStr = attack.fireTime ? ` 발사 ${new Date(attack.fireTime).toISOString().slice(11, 23)}` : '';
        log.ok(`[예약 #${id}] ${attack.type} (${sourceVillageId}) → (${targetX}|${targetY}) 도착 ${new Date(attack.arrivalTime).toISOString().slice(11, 23)}${fireStr}`);
        return attack;
    }

    // 예약 취소
    cancel(id) {
        const atk = this.attacks.find(a => a.id === id);
        if (!atk) return false;
        if (atk.status === 'waiting' || atk.status === 'preparing') {
            atk.status = 'cancelled';
            log.warn(`[예약 #${id}] 취소됨`);
            return true;
        }
        return false;
    }

    // 예약 목록
    list() {
        return this.attacks.map(a => ({
            ...a,
            remainingMs: a.arrivalTime - Date.now(),
            fireRemainingMs: a.fireTime ? a.fireTime - Date.now() : null,
        }));
    }

    // 매초 체크 — 준비/발사 시점 도래 시 실행
    async tick() {
        if (this.executing) return;
        const now = Date.now();

        for (const atk of this.attacks) {
            if (atk.status !== 'waiting') continue;

            // 준비 시작 시점 = fireTime이 있으면 fireTime - 3분, 없으면 도착 - 2분
            // 이동시간이 2분 넘는 경우 (먼 거리) — fireTime이 도착보다 한참 전이라
            // 도착 -2분 트리거로는 발사 시점 놓침. fireTime 기준으로 트리거 필요.
            const prepStart = atk.fireTime ? atk.fireTime - 180000 : atk.arrivalTime - 120000;
            const triggerLimit = atk.fireTime || atk.arrivalTime;
            const remainToPrep = prepStart - now;
            const remainToFire = triggerLimit - now;

            if (remainToPrep <= 0 && remainToFire > 0) {
                this.executing = true;
                atk.status = 'preparing';
                try {
                    await this.prepareAndFire(atk);
                } catch (e) {
                    atk.status = 'failed';
                    atk.error = e.message;
                    log.err(`[예약 #${atk.id}] 실패: ${e.message}`);
                }
                this.executing = false;
                return;
            }

            // 발사 시점 이미 지남
            if (remainToFire <= 0) {
                atk.status = 'failed';
                atk.error = atk.fireTime ? '발사 시점 이미 지남' : '도착 시간 이미 지남';
                log.warn(`[예약 #${atk.id}] ${atk.error}`);
            }
        }
    }

    // 준비 + 대기 + 발사 — API 직접 호출 (클릭/네비게이션 없음, ms 정밀)
    // 캡처 검증: POST place&ajax=confirm → ch 토큰 + Duration 추출
    //           POST place&action=command (with ch + troops) → 실제 공격 발사
    async prepareAndFire(atk) {
        // 1. 광장 페이지 1회 로드 — CSRF + 폼 토큰 추출
        log.info(`[예약 #${atk.id}] 광장 페이지 로드 (API 준비)...`);
        await gotoPlace(this.cdp, this.sessionId, this.baseUrl, atk.sourceVillageId);
        await sleep(randInt(300, 700));

        const formData = await this.extractPlaceFormData();
        if (!formData?.csrf) throw new Error('CSRF 토큰 추출 실패');
        if (!formData?.tokenName || !formData?.tokenValue) throw new Error('폼 보안 토큰 추출 실패');

        // 2. confirm POST → Duration + ch 토큰 받기
        log.info(`[예약 #${atk.id}] confirm POST...`);
        const confirm = await this.postConfirm(atk, formData);
        if (!confirm?.ch) throw new Error('ch 토큰 추출 실패: ' + (confirm?.error || ''));
        if (!confirm?.durationMs) throw new Error('Duration 추출 실패');
        atk.status = 'ready';

        const oldEst = atk.travelTimeMs;
        atk.travelTimeMs = confirm.durationMs;
        if (oldEst && Math.abs(oldEst - confirm.durationMs) > 1000) {
            log.warn(`[예약 #${atk.id}] 이동시간 추정(${Math.round(oldEst/1000)}s) vs 실제(${Math.round(confirm.durationMs/1000)}s) 차이 — 보정`);
        }
        atk.fireTime = atk.arrivalTime - atk.travelTimeMs;
        const waitMs = atk.fireTime - Date.now();
        if (waitMs < -5000) throw new Error(`발사 시점 이미 ${Math.round(-waitMs/1000)}초 지남`);
        log.info(`[예약 #${atk.id}] ch 받음. 발사까지 ${Math.round(Math.max(0, waitMs)/1000)}초 (Duration ${Math.round(confirm.durationMs/1000)}초)`);

        // 3. 정밀 대기 (sleep로 100ms 전까지, 그 후 spinning)
        const finalWait = atk.fireTime - Date.now();
        if (finalWait > 200) await sleep(finalWait - 100);
        if (atk.status === 'cancelled') return;
        while (Date.now() < atk.fireTime) {
            await new Promise(r => setImmediate(r));
        }

        // 4. 발사 — POST place&action=command (ch + troops)
        atk.status = 'firing';
        const beforePost = Date.now();
        log.ok(`[예약 #${atk.id}] ★ 발사!`);
        const sendResult = await this.postCommand(atk, formData, confirm.ch);
        const actualFireTime = Date.now();
        const postLatencyMs = actualFireTime - beforePost;
        const diffMs = actualFireTime - atk.fireTime;
        log.info(`[예약 #${atk.id}] POST latency: ${postLatencyMs}ms`);

        if (!sendResult?.ok) {
            throw new Error('발사 POST 실패: ' + (sendResult?.error || 'unknown'));
        }

        atk.status = 'done';
        atk.result = {
            actualFireTime,
            expectedArrival: actualFireTime + atk.travelTimeMs,
            diffMs,
            postLatencyMs,
        };
        log.ok(`[예약 #${atk.id}] 완료! (목표 대비 ${diffMs > 0 ? '+' : ''}${diffMs}ms, POST ${postLatencyMs}ms)`);
    }

    // 광장 페이지에서 CSRF + 폼 보안 토큰 추출
    async extractPlaceFormData() {
        return await evaluate(this.cdp, this.sessionId, `
            (() => {
                const html = document.documentElement.innerHTML;
                const csrfM = html.match(/csrf_token\\s*=\\s*['\\\"]([a-f0-9]+)['\\\"]/);
                const csrf = csrfM ? csrfM[1] : null;
                // 폼 보안 토큰 — name/value가 hex인 hidden input
                const form = document.getElementById('command-data-form');
                let tokenName = null, tokenValue = null;
                if (form) {
                    for (const inp of form.querySelectorAll('input[type="hidden"]')) {
                        const n = inp.name || '';
                        const v = inp.value || '';
                        if (/^[a-f0-9]{15,40}$/.test(n) && /^[a-f0-9]{10,40}$/.test(v)) {
                            tokenName = n; tokenValue = v; break;
                        }
                    }
                }
                return { csrf, tokenName, tokenValue };
            })()
        `);
    }

    // POST /game.php?village=X&screen=place&try=confirm
    // 응답에서 ch 토큰 + Duration 추출
    async postConfirm(atk, formData) {
        const isAttack = atk.type !== 'support';
        const url = `${this.baseUrl}/game.php?village=${atk.sourceVillageId}&screen=place&try=confirm`;
        const troops = atk.troops || {};
        return await evaluate(this.cdp, this.sessionId, `
            (async () => {
                try {
                    const params = new URLSearchParams();
                    params.append(${JSON.stringify(formData.tokenName)}, ${JSON.stringify(formData.tokenValue)});
                    params.append('template_id', '');
                    params.append('source_village', '${atk.sourceVillageId}');
                    const t = ${JSON.stringify(troops)};
                    for (const u of ['spear','sword','axe','archer','spy','light','marcher','heavy','ram','catapult','knight','snob']) {
                        params.append(u, t[u] != null ? String(t[u]) : '');
                    }
                    params.append('x', '${atk.targetX}');
                    params.append('y', '${atk.targetY}');
                    params.append('input', '');
                    params.append('attack', ${isAttack ? "'l'" : "'s'"});
                    params.append('h', '${formData.csrf}');
                    const r = await fetch('${url}', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                            'X-Requested-With': 'XMLHttpRequest',
                        },
                        body: params.toString(),
                    });
                    const text = await r.text();
                    // ch 토큰 추출 (input name="ch" value="...")
                    const chM = text.match(/name=[\"']ch[\"']\\s+value=[\"']([^\"']+)[\"']/);
                    // Duration "0:37:06"
                    const durM = text.match(/Duration[^<]*<\\/td>\\s*<td>(\\d+):(\\d{1,2}):(\\d{1,2})/);
                    let durationMs = null;
                    if (durM) durationMs = parseInt(durM[1])*3600000 + parseInt(durM[2])*60000 + parseInt(durM[3])*1000;
                    return {
                        ch: chM ? chM[1] : null,
                        durationMs,
                        snippet: text.slice(0, 300),
                    };
                } catch (e) {
                    return { error: e.message };
                }
            })()
        `);
    }

    // POST /game.php?village=X&screen=place&action=command&h=CSRF
    // ch 토큰 + 같은 troops로 실제 공격 발사
    async postCommand(atk, formData, ch) {
        const url = `${this.baseUrl}/game.php?village=${atk.sourceVillageId}&screen=place&action=command&h=${formData.csrf}`;
        const troops = atk.troops || {};
        return await evaluate(this.cdp, this.sessionId, `
            (async () => {
                try {
                    const params = new URLSearchParams();
                    params.append('attack', 'true');
                    params.append('ch', '${ch}');
                    params.append('cb', 'troop_confirm_submit');
                    params.append('x', '${atk.targetX}');
                    params.append('y', '${atk.targetY}');
                    params.append('source_village', '${atk.sourceVillageId}');
                    params.append('village', '${atk.sourceVillageId}');
                    params.append('attack_name', '');
                    const t = ${JSON.stringify(troops)};
                    for (const u of ['spear','sword','axe','archer','spy','light','marcher','heavy','ram','catapult','knight','snob']) {
                        params.append(u, String(t[u] || 0));
                    }
                    params.append('building', '${atk.building || 'main'}');
                    params.append('submit_confirm', 'Send attack');
                    params.append('h', '${formData.csrf}');
                    const r = await fetch('${url}', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
                        body: params.toString(),
                    });
                    const text = await r.text();
                    // 성공: 응답이 page redirect (HTML)이고 'error' 단어 없음
                    // 실패: error message 포함
                    const hasError = /class=[\"']error/i.test(text) || /error_box/i.test(text);
                    return {
                        ok: !hasError && r.status === 200,
                        status: r.status,
                        snippet: text.slice(0, 300),
                    };
                } catch (e) {
                    return { ok: false, error: e.message };
                }
            })()
        `);
    }

    // confirm 화면에서 이동시간 추출
    async extractTravelTime() {
        const result = await evaluate(this.cdp, this.sessionId, `
            (() => {
                const html = document.documentElement.innerHTML;
                const durM = html.match(/Duration[:\\\\s]*?(\\\\d+):(\\\\d{2}):(\\\\d{2})/i);
                if (durM) {
                    return parseInt(durM[1]) * 3600000 + parseInt(durM[2]) * 60000 + parseInt(durM[3]) * 1000;
                }
                const endM = html.match(/data-endtime="(\\\\d+)"/);
                if (endM) {
                    const et = parseInt(endM[1]);
                    const now = Date.now();
                    const endMs = et < 1e12 ? et * 1000 : et;
                    return endMs - now;
                }
                return null;
            })()
        `);
        return result;
    }
}

module.exports = Scheduler;
