// 공격/원군 예약 스케줄러 — 시간 되면 CDP로 진짜 Chrome에서 발사
const { evaluate } = require('./runtime');
const { navigate, waitForLoad, sleep } = require('./page');
const { gotoPlace, fillForm, clickSupport, clickAttack, waitForConfirm, clickConfirmOk, getAvailableTroops } = require('./place');
const { moveAndClick } = require('./mouse');
const { randInt } = require('./human');
const log = require('./log');

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
    // 스캐빈징 등 저우선순위 작업이 yield할지 판단용
    nextFireInMs() {
        if (this.executing) return 0;
        const now = Date.now();
        let earliest = Infinity;
        for (const atk of this.attacks) {
            if (atk.status !== 'waiting') continue;
            // 2분 전부터 준비 시작 → 3분 마진
            const prepareAt = atk.arrivalTime - 180000;
            const remain = prepareAt - now;
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
        this.attacks.push(attack);
        log.ok(`[예약 #${id}] ${attack.type} (${sourceVillageId}) → (${targetX}|${targetY}) 도착 ${new Date(attack.arrivalTime).toISOString().slice(11, 23)}`);
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

            const remainMs = atk.arrivalTime - now;

            // 도착 2분 전 → 준비 시작 (navigate + form + confirm)
            if (remainMs <= 120000 && remainMs > 0) {
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
                return; // 한 번에 하나만
            }

            // 이미 도착 시간 지남
            if (remainMs <= 0) {
                atk.status = 'failed';
                atk.error = '도착 시간 이미 지남';
                log.warn(`[예약 #${atk.id}] 도착 시간 이미 지남`);
            }
        }
    }

    // 준비 + 대기 + 발사
    async prepareAndFire(atk) {
        let lastMouse = { x: 500, y: 300 };

        // 1. 광장으로 이동
        log.info(`[예약 #${atk.id}] 광장 이동...`);
        await gotoPlace(this.cdp, this.sessionId, this.baseUrl, atk.sourceVillageId);
        await sleep(randInt(500, 1000));

        // 2. 폼 입력
        log.info(`[예약 #${atk.id}] 폼 입력: (${atk.targetX}|${atk.targetY})`);
        await fillForm(this.cdp, this.sessionId, atk.targetX, atk.targetY, atk.troops);
        await sleep(randInt(800, 1500));

        // 3. Attack/Support 버튼 클릭
        if (atk.type === 'support') {
            lastMouse = await clickSupport(this.cdp, this.sessionId, lastMouse);
        } else {
            lastMouse = await clickAttack(this.cdp, this.sessionId, lastMouse);
        }
        log.info(`[예약 #${atk.id}] ${atk.type === 'support' ? 'Support' : 'Attack'} 버튼 클릭`);
        await sleep(randInt(300, 800));

        // 4. confirm 화면 대기
        const confirmBtn = await waitForConfirm(this.cdp, this.sessionId);
        atk.status = 'ready';
        log.info(`[예약 #${atk.id}] confirm 준비 완료`);

        // 5. 이동시간 추출 (confirm 화면의 Duration)
        const travelInfo = await this.extractTravelTime();
        if (!travelInfo) {
            throw new Error('이동시간 추출 실패');
        }
        atk.travelTimeMs = travelInfo;
        log.info(`[예약 #${atk.id}] 이동시간: ${Math.round(travelInfo / 1000)}초`);

        // 6. 발사 시점 = 도착시간 - 이동시간
        atk.fireTime = atk.arrivalTime - atk.travelTimeMs;
        const waitMs = atk.fireTime - Date.now();

        if (waitMs < -5000) {
            throw new Error(`발사 시점 이미 ${Math.round(-waitMs / 1000)}초 지남`);
        }

        log.info(`[예약 #${atk.id}] 발사까지 ${Math.round(Math.max(0, waitMs) / 1000)}초 대기`);

        // 7. confirm이 만료되지 않도록 체크 (3분 이상 남으면 재준비)
        if (waitMs > 180000) {
            const earlyWait = waitMs - 30000;
            log.info(`[예약 #${atk.id}] ${Math.round(earlyWait / 1000)}초 사전 대기...`);
            await sleep(earlyWait);

            // 취소 체크
            if (atk.status === 'cancelled') return;

            // 재준비
            log.info(`[예약 #${atk.id}] 재준비...`);
            await gotoPlace(this.cdp, this.sessionId, this.baseUrl, atk.sourceVillageId);
            await sleep(randInt(500, 1000));
            await fillForm(this.cdp, this.sessionId, atk.targetX, atk.targetY, atk.troops);
            await sleep(randInt(500, 1000));
            if (atk.type === 'support') {
                lastMouse = await clickSupport(this.cdp, this.sessionId, lastMouse);
            } else {
                lastMouse = await clickAttack(this.cdp, this.sessionId, lastMouse);
            }
            await sleep(randInt(300, 800));
            const newConfirm = await waitForConfirm(this.cdp, this.sessionId);
            Object.assign(confirmBtn, newConfirm);
        }

        // 8. 정밀 대기
        const finalWait = atk.fireTime - Date.now();
        if (finalWait > 3000) {
            await sleep(finalWait - 2000);
        }

        // 취소 체크
        if (atk.status === 'cancelled') return;

        // 마지막 ms 대기
        const lastWait = atk.fireTime - Date.now();
        if (lastWait > 0) {
            await sleep(lastWait);
        }

        // 9. 발사!
        atk.status = 'firing';
        log.ok(`[예약 #${atk.id}] ★ 발사!`);
        await clickConfirmOk(this.cdp, this.sessionId, confirmBtn, lastMouse);

        const actualFireTime = Date.now();
        const diffMs = actualFireTime - atk.fireTime;

        atk.status = 'done';
        atk.result = {
            actualFireTime,
            expectedArrival: actualFireTime + atk.travelTimeMs,
            diffMs,
        };
        log.ok(`[예약 #${atk.id}] 완료! (목표 대비 ${diffMs > 0 ? '+' : ''}${diffMs}ms)`);
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
