// 자동 양성 큐 — 마을별 독립 타이머
// 각 마을이 자기 큐 완료 시각에 맞춰 자기만 처리. BotLock으로 봇 탭 충돌 자동 직렬화.
// 글로벌 배치(이전)에서 마을별 독립으로 변경 — 큐 빨리 비는 마을 즉시 보충.

const { trainVillage, BotProtectionError } = require('./trainer');
const { sleep } = require('./page');
const { randInt } = require('./human');
const log = require('./log');

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
        this.stopped = false;

        // 마을별 독립 상태
        this.villageTimers = new Map();   // villageId → setTimeout
        this.villageRunning = new Set();  // 처리 중 마을
        this.villageNextAt = new Map();   // villageId → ms (UI용)

        // 폴백 주기 (큐 정보 못 구할 때만)
        this.fallbackMinMs = 4 * 60 * 1000;
        this.fallbackMaxMs = 8 * 60 * 1000;
    }

    async start(villages, plan) {
        this.stopped = false;
        this.villages = villages;
        if (plan && plan.length > 0) this.plan = plan;
        log.info(`[양성큐] 시작 — ${villages.length}개 마을, ${this.plan.length}개 작업 (마을별 독립)`);
        // 각 마을 첫 실행 분산 (3~30초)
        for (const v of villages) {
            this._scheduleVillage(v.id, randInt(3000, 30000));
        }
    }

    stop() {
        this.stopped = true;
        for (const t of this.villageTimers.values()) clearTimeout(t);
        this.villageTimers.clear();
        this.villageRunning.clear();
        this.villageNextAt.clear();
        log.info('[양성큐] 정지');
    }

    setPlan(plan) {
        this.plan = plan;
        log.info(`[양성큐] 계획 변경: ${plan.length}개 작업`);
    }

    updateSelection(villageIds) {
        const ids = new Set(villageIds);
        const removed = this.villages.filter(v => !ids.has(v.id));
        this.villages = this.villages.filter(v => ids.has(v.id));
        for (const v of removed) {
            const t = this.villageTimers.get(v.id);
            if (t) clearTimeout(t);
            this.villageTimers.delete(v.id);
            this.villageNextAt.delete(v.id);
        }
        // 새 마을 즉시 첫 실행 스케줄
        for (const v of this.villages) {
            if (!this.villageTimers.has(v.id) && !this.villageRunning.has(v.id)) {
                this._scheduleVillage(v.id, randInt(3000, 15000));
            }
        }
    }

    _scheduleVillage(villageId, delayMs) {
        if (this.stopped) return;
        if (this.villageTimers.has(villageId)) {
            clearTimeout(this.villageTimers.get(villageId));
        }
        const delay = Math.max(0, delayMs);
        this.villageNextAt.set(villageId, Date.now() + delay);
        const t = setTimeout(() => {
            this.villageTimers.delete(villageId);
            this._tickVillage(villageId).catch(e => log.err(`[양성큐:${villageId}] tick 에러: ${e.message}`));
        }, delay);
        this.villageTimers.set(villageId, t);
    }

    async _tickVillage(villageId) {
        if (this.stopped) return;
        if (this.villageRunning.has(villageId)) return;

        const v = this.villages.find(vv => vv.id === villageId);
        if (!v) return;

        // 스케줄러 임박 → 마을별 재시도
        if (this.scheduler && this.scheduler.isBusy()) {
            const wait = Math.max(60000, this.scheduler.nextFireInMs() + 60000);
            log.info(`[양성:${v.name}] 스케줄러 임박 → ${Math.round(wait / 1000)}초 후`);
            this._scheduleVillage(villageId, wait);
            return;
        }

        // 봇 락 — 같은 시각 다른 마을과 경합 시 직렬화
        if (this.botLock) {
            try {
                await this.botLock.acquire(`trainer-${villageId}`);
            } catch (e) {
                log.warn(`[양성:${v.name}] 락 실패: ${e.message}`);
                this._scheduleVillage(villageId, randInt(30000, 60000));
                return;
            }
        }
        if (this.stopped) {
            if (this.botLock) this.botLock.release(`trainer-${villageId}`);
            return;
        }

        this.villageRunning.add(villageId);
        let nextSec = null;
        try {
            const r = await trainVillage(this.cdp, this.sessionId, this.baseUrl, v, this.plan);
            nextSec = r.nextCheckSec;
        } catch (e) {
            if (e instanceof BotProtectionError) {
                log.err(`🛑 [양성:${v.name}] 봇 프로텍션 감지: ${e.detail.type} — 정지`);
                this.stopped = true;
                if (this.onBotProtection) this.onBotProtection(e.detail);
            } else {
                log.err(`[양성:${v.name}] 실패: ${e.message}`);
            }
        } finally {
            this.villageRunning.delete(villageId);
            if (this.botLock) this.botLock.release(`trainer-${villageId}`);
        }

        if (!this.stopped) {
            // 큐 가장 빨리 끝나는 시각 + 20~60초 여유
            const delayMs = (typeof nextSec === 'number' && nextSec >= 0)
                ? (nextSec * 1000 + randInt(20000, 60000))
                : randInt(this.fallbackMinMs, this.fallbackMaxMs);
            this._scheduleVillage(villageId, delayMs);
        }
    }

    status() {
        const now = Date.now();
        return {
            running: this.villageRunning.size > 0,
            stopped: this.stopped,
            villages: this.villages.length,
            plan: this.plan,
            villageDetail: this.villages.map(v => ({
                id: v.id,
                name: v.name,
                running: this.villageRunning.has(v.id),
                nextInMs: this.villageNextAt.has(v.id) ? Math.max(0, this.villageNextAt.get(v.id) - now) : null,
            })),
        };
    }
}

module.exports = { TrainerQueue, DEFAULT_PLAN };
