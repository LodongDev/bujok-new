// 자동 동줍 큐 — 주기적으로 전체 마을 farm assistant 실행
const { farmAllVillages, BotProtectionError } = require('./farm-auto');
const { sleep } = require('./page');
const { randInt } = require('./human');
const log = require('./log');

class FarmQueue {
    constructor(cdp, sessionId, baseUrl, scheduler, botLock, onBotProtection) {
        this.cdp = cdp;
        this.sessionId = sessionId;
        this.baseUrl = baseUrl;
        this.scheduler = scheduler;
        this.botLock = botLock;
        this.onBotProtection = onBotProtection;
        this.villages = [];
        this.options = { mode: 'C', maxPages: 5 };
        this.timer = null;
        this.running = false;
        this.stopped = false;
        // 폴백 주기 (복귀 시각 못 구할 때만)
        this.fallbackMinMs = 5 * 60 * 1000;
        this.fallbackMaxMs = 10 * 60 * 1000;
    }

    async start(villages, options = {}) {
        this.stopped = false;
        this.villages = villages;
        this.options = { ...this.options, ...options };
        log.info(`[동줍큐] 시작 — ${villages.length}개 마을, mode=${this.options.mode}`);
        this.scheduleNext(randInt(3000, 8000));
    }

    stop() {
        this.stopped = true;
        if (this.timer) { clearTimeout(this.timer); this.timer = null; }
        log.info('[동줍큐] 정지');
    }

    updateSelection(villageIds) {
        const ids = new Set(villageIds);
        this.villages = this.villages.filter(v => ids.has(v.id));
        log.info(`[동줍큐] 마을 ${this.villages.length}개로 갱신`);
    }

    scheduleNext(overrideMs) {
        if (this.stopped || this.timer) return;
        // null/undefined 모두 fallback (이전 버그: null 통과되어 setTimeout 0)
        const delay = (overrideMs != null && overrideMs > 0)
            ? overrideMs
            : randInt(this.fallbackMinMs, this.fallbackMaxMs);
        const sec = Math.round(delay / 1000);
        const display = sec < 120 ? `${sec}초` : `${Math.round(sec / 60)}분`;
        log.info(`[동줍큐] 다음 실행: ${display} 후`);
        this.timer = setTimeout(() => {
            this.timer = null;
            this.tick().catch(e => log.err(`[동줍큐] tick 에러: ${e.message}`));
        }, delay);
    }

    async tick() {
        if (this.stopped || this.running) return;

        // 스케줄러 임박 시 대기
        if (this.scheduler && this.scheduler.isBusy()) {
            const wait = Math.max(60000, this.scheduler.nextFireInMs() + 60000);
            log.info(`[동줍큐] 스케줄러 임박 → ${Math.round(wait / 1000)}초 후`);
            this.scheduleNext(wait);
            return;
        }

        // 락 획득
        if (this.botLock) {
            try {
                await this.botLock.acquire('farm');
            } catch (e) {
                log.warn(`[동줍큐] 락 실패: ${e.message}`);
                this.scheduleNext();
                return;
            }
        }
        if (this.stopped) {
            if (this.botLock) this.botLock.release('farm');
            return;
        }

        this.running = true;
        let nextDelay = null;
        try {
            const { grandTotal, earliestReturnMs } = await farmAllVillages(this.cdp, this.sessionId, this.baseUrl, this.villages, this.options);
            log.ok(`[동줍큐] 라운드 완료 — ${grandTotal}회 전송`);
            // 가장 빠른 복귀 시각 기반 스케줄링
            // 버퍼 5~30초 랜덤 (자연스러운 패턴)
            if (earliestReturnMs) {
                const remain = earliestReturnMs - Date.now();
                nextDelay = Math.max(30000, remain + randInt(5000, 30000));
            }
        } catch (e) {
            if (e instanceof BotProtectionError) {
                log.err(`🛑 [동줍큐] 봇 프로텍션 감지: ${e.detail.type} — 정지`);
                this.stopped = true;
                if (this.onBotProtection) this.onBotProtection(e.detail);
            } else {
                log.err(`[동줍큐] 실패: ${e.message}`);
            }
        } finally {
            this.running = false;
            if (this.botLock) this.botLock.release('farm');
        }

        if (!this.stopped) this.scheduleNext(nextDelay);
    }

    status() {
        return {
            running: this.running,
            stopped: this.stopped,
            villages: this.villages.length,
            mode: this.options.mode,
        };
    }
}

module.exports = FarmQueue;
