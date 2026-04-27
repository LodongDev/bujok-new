// 자동 양성 큐 — 주기적으로 막사/마구간 1마리씩 발주
// 자원 부족 시 그냥 다음 주기에 재시도
const { trainAllVillages, BotProtectionError } = require('./trainer');
const { sleep } = require('./page');
const { randInt } = require('./human');
const log = require('./log');

// 기본 양성 계획: 마구간 light 1, 막사 spear 1 (마구간 우선)
const DEFAULT_PLAN = [
    { building: 'stable', unit: 'light', count: 1 },
    { building: 'barracks', unit: 'spear', count: 1 },
];

class TrainerQueue {
    constructor(cdp, sessionId, baseUrl, scheduler, botLock, onBotProtection) {
        this.cdp = cdp;
        this.sessionId = sessionId;
        this.baseUrl = baseUrl;
        this.scheduler = scheduler;
        this.botLock = botLock;
        this.onBotProtection = onBotProtection;
        this.villages = [];
        this.plan = DEFAULT_PLAN;
        this.timer = null;
        this.running = false;
        this.stopped = false;
        // 마구간 light 1마리 ~ 200초 (마구간 레벨/시계열에 따라 변동)
        // 안전하게 4~8분 주기 (병력 양성 시간 + 여유)
        this.minIntervalMs = 4 * 60 * 1000;
        this.maxIntervalMs = 8 * 60 * 1000;
    }

    async start(villages, plan) {
        this.stopped = false;
        this.villages = villages;
        if (plan && plan.length > 0) this.plan = plan;
        log.info(`[양성큐] 시작 — ${villages.length}개 마을, ${this.plan.length}개 작업`);
        this.scheduleNext(randInt(3000, 8000));
    }

    stop() {
        this.stopped = true;
        if (this.timer) { clearTimeout(this.timer); this.timer = null; }
        log.info('[양성큐] 정지');
    }

    setPlan(plan) {
        this.plan = plan;
        log.info(`[양성큐] 계획 변경: ${plan.length}개 작업`);
    }

    updateSelection(villageIds) {
        const ids = new Set(villageIds);
        this.villages = this.villages.filter(v => ids.has(v.id));
    }

    scheduleNext(overrideMs) {
        if (this.stopped || this.timer) return;
        const delay = overrideMs !== undefined ? overrideMs : randInt(this.minIntervalMs, this.maxIntervalMs);
        log.info(`[양성큐] 다음 실행: ${Math.round(delay / 1000)}초 후`);
        this.timer = setTimeout(() => {
            this.timer = null;
            this.tick().catch(e => log.err(`[양성큐] tick 에러: ${e.message}`));
        }, delay);
    }

    async tick() {
        if (this.stopped || this.running) return;

        if (this.scheduler && this.scheduler.isBusy()) {
            const wait = Math.max(60000, this.scheduler.nextFireInMs() + 60000);
            log.info(`[양성큐] 스케줄러 임박 → ${Math.round(wait / 1000)}초 후`);
            this.scheduleNext(wait);
            return;
        }

        if (this.botLock) {
            try { await this.botLock.acquire('trainer'); }
            catch (e) { log.warn(`[양성큐] 락 실패: ${e.message}`); this.scheduleNext(); return; }
        }
        if (this.stopped) {
            if (this.botLock) this.botLock.release('trainer');
            return;
        }

        this.running = true;
        let nextSec = null;
        try {
            const r = await trainAllVillages(this.cdp, this.sessionId, this.baseUrl, this.villages, this.plan);
            nextSec = r.nextCheckSec;
        } catch (e) {
            if (e instanceof BotProtectionError) {
                log.err(`🛑 [양성큐] 봇 프로텍션 감지: ${e.detail.type}`);
                this.stopped = true;
                if (this.onBotProtection) this.onBotProtection(e.detail);
            } else {
                log.err(`[양성큐] 실패: ${e.message}`);
            }
        } finally {
            this.running = false;
            if (this.botLock) this.botLock.release('trainer');
        }

        // 큐 완료 시각 + 30초 여유 (재시도 폴링 아니라 정확한 시각 기반)
        if (!this.stopped) {
            const delayMs = nextSec ? (nextSec * 1000 + randInt(20000, 60000)) : randInt(this.minIntervalMs, this.maxIntervalMs);
            this.scheduleNext(delayMs);
        }
    }

    status() {
        return {
            running: this.running,
            stopped: this.stopped,
            villages: this.villages.length,
            plan: this.plan,
        };
    }
}

module.exports = { TrainerQueue, DEFAULT_PLAN };
