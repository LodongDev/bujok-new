// 시장 판매 큐 — 주기적으로 전체 마을 자원 판매
// 우선순위: scheduler (공격/예약/노블)가 바쁘면 yield
const { sellAllVillages, BotProtectionError } = require('./market');
const { sleep } = require('./page');
const { randInt } = require('./human');
const log = require('./log');

class MarketQueue {
    constructor(cdp, sessionId, baseUrl, scheduler, botLock, onBotProtection) {
        this.cdp = cdp;
        this.sessionId = sessionId;
        this.baseUrl = baseUrl;
        this.scheduler = scheduler;
        this.botLock = botLock;
        this.onBotProtection = onBotProtection; // 감지 시 호출 (글로벌 정지용)
        this.villages = [];
        this.timer = null;
        this.running = false;
        this.stopped = false;
        // 주기: 10초~1분 랜덤
        this.minIntervalMs = 10 * 1000;
        this.maxIntervalMs = 60 * 1000;
        // 휴식: 매 N번째 체크 후 긴 휴식 (2~5분)
        this.checksDone = 0;
        this.nextBreakAt = this._randBreakInterval();
    }

    _randBreakInterval() {
        return randInt(15, 30); // 15~30번 체크마다 휴식
    }

    _schedulerBusy() {
        return this.scheduler && this.scheduler.isBusy();
    }

    async start(villages) {
        this.stopped = false;
        this.villages = villages;
        log.info(`[시장큐] 시작 — ${villages.length}개 마을, 10초~1분 랜덤 주기`);
        // 초기 시작은 살짝 지연 (다른 큐와 동시 시작 시 충돌 방지)
        this.scheduleNext(randInt(2000, 5000));
    }

    stop() {
        this.stopped = true;
        if (this.timer) { clearTimeout(this.timer); this.timer = null; }
        log.info('[시장큐] 정지');
    }

    scheduleNext(overrideMs) {
        if (this.stopped || this.timer) return;
        // 기본: 10초~1분 랜덤 (null/undefined 모두 fallback)
        let delay = (overrideMs != null && overrideMs > 0)
            ? overrideMs
            : randInt(this.minIntervalMs, this.maxIntervalMs);
        // 휴식 시점이면 긴 대기 (2~5분)
        if (this.checksDone >= this.nextBreakAt) {
            delay = randInt(2 * 60 * 1000, 5 * 60 * 1000);
            log.info(`[시장큐] 휴식 — ${Math.round(delay / 1000)}초`);
            this.checksDone = 0;
            this.nextBreakAt = this._randBreakInterval();
        }
        this.timer = setTimeout(() => {
            this.timer = null;
            this.tick().catch(e => log.err(`[시장큐] tick 에러: ${e.message}`));
        }, delay);
    }

    async tick() {
        if (this.stopped || this.running) return;

        // 스케줄러 임박 체크 (스케줄러는 락 밖에서 동작하므로 먼저 체크)
        if (this._schedulerBusy()) {
            const wait = Math.max(60000, this.scheduler.nextFireInMs() + 60000);
            log.info(`[시장큐] 스케줄러 임박 → ${Math.round(wait / 1000)}초 후`);
            this.scheduleNext(wait);
            return;
        }

        // 봇 락 획득 (다른 작업 끝날 때까지 대기)
        if (this.botLock) {
            try {
                await this.botLock.acquire('market');
            } catch (e) {
                log.warn(`[시장큐] 락 획득 실패: ${e.message}`);
                this.scheduleNext();
                return;
            }
        }
        if (this.stopped) {
            if (this.botLock) this.botLock.release('market');
            return;
        }

        this.running = true;
        this.checksDone++;
        let totalPP = 0;
        let allFull = false;
        try {
            const result = await sellAllVillages(this.cdp, this.sessionId, this.baseUrl, this.villages);
            totalPP = result.totalPP;

            // 모든 마을이 시장 가득참으로 스킵되었는지 체크
            const sellResults = result.results || [];
            const fullCount = sellResults.filter(r =>
                r.status === 'skip' && r.reason?.includes('시장 가득참')
            ).length;
            allFull = sellResults.length > 0 && fullCount === sellResults.length;

            if (totalPP > 0) {
                log.ok(`[시장큐] 라운드 완료 — ${totalPP}PP`);
            } else if (allFull) {
                log.info(`[시장큐] 시장 가득참 (판매 불가) — 간격 늘림`);
            } else {
                log.info(`[시장큐] 판매 없음`);
            }
        } catch (e) {
            if (e instanceof BotProtectionError) {
                log.err(`🛑 [시장큐] 봇 프로텍션 감지: ${e.detail.type} — 정지`);
                this.stopped = true;
                if (this.onBotProtection) this.onBotProtection(e.detail);
            } else {
                log.err(`[시장큐] 실패: ${e.message}`);
            }
        } finally {
            this.running = false;
            if (this.botLock) this.botLock.release('market');
        }

        // 다음 체크: 기본 랜덤 (10초~1분), 성공 시 조금 빠르게
        let nextDelay;
        if (totalPP > 0) {
            nextDelay = randInt(10000, 30000); // 10~30초
        } else {
            nextDelay = randInt(this.minIntervalMs, this.maxIntervalMs); // 10초~1분
        }
        log.info(`[시장큐] 다음 체크: ${Math.round(nextDelay / 1000)}초 후 (${this.checksDone}/${this.nextBreakAt})`);
        if (!this.stopped) this.scheduleNext(nextDelay);
    }

    status() {
        return {
            running: this.running,
            stopped: this.stopped,
            villages: this.villages.length,
            intervalMin: this.intervalMin,
        };
    }
}

module.exports = MarketQueue;
