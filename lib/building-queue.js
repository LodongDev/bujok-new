// 자동 건물 큐 — 마을별 우선순위 기반 연속 업그레이드
// 자원 부족 시 생산량 계산해서 ETA 뒤에 재시도
// 스케줄러 우선순위 존중, 봇 프로텍션 감지 시 정지

const { processBuildVillage, BotProtectionError } = require('./building');
const { sleep } = require('./page');
const { randInt } = require('./human');
const log = require('./log');

class BuildingQueue {
    constructor(cdp, sessionId, baseUrl, scheduler, botLock, onBotProtection) {
        this.cdp = cdp;
        this.sessionId = sessionId;
        this.baseUrl = baseUrl;
        this.scheduler = scheduler;
        this.botLock = botLock;
        this.onBotProtection = onBotProtection;
        // villageId → { villageId, name, priority: [{building, target}], nextCheckAt, lastStatus }
        this.villages = new Map();
        this.timer = null;
        this.running = false;
        this.stopped = false;
        this.maxQueueSize = 2; // 기본 2 (프리미엄 계정)
    }

    setMaxQueueSize(n) { this.maxQueueSize = Math.max(1, Math.min(5, n)); }

    // 마을별 우선순위 세팅
    setVillagePriority(villageId, name, priority) {
        this.villages.set(villageId, {
            villageId, name, priority,
            nextCheckAt: Date.now(),
            lastStatus: null,
        });
        this.scheduleNext(0);
    }

    removeVillage(villageId) {
        this.villages.delete(villageId);
    }

    async start() {
        this.stopped = false;
        log.info(`[건설큐] 시작 — ${this.villages.size}개 마을`);
        this.scheduleNext(randInt(2000, 5000));
    }

    stop() {
        this.stopped = true;
        if (this.timer) { clearTimeout(this.timer); this.timer = null; }
        log.info('[건설큐] 정지');
    }

    scheduleNext(overrideMs) {
        if (this.stopped || this.timer) return;
        let delay;
        if (overrideMs !== undefined) {
            delay = overrideMs;
        } else {
            // 가장 빠른 nextCheckAt까지 기다림
            const now = Date.now();
            let earliest = Infinity;
            for (const v of this.villages.values()) {
                if (v.nextCheckAt < earliest) earliest = v.nextCheckAt;
            }
            delay = Math.max(5000, earliest - now); // 최소 5초
            if (earliest === Infinity) delay = 60000; // 할일 없으면 1분 후 재확인
        }
        this.timer = setTimeout(() => {
            this.timer = null;
            this.tick().catch(e => log.err(`[건설큐] tick 에러: ${e.message}`));
        }, delay);
    }

    async tick() {
        if (this.stopped || this.running) return;

        // 스케줄러 임박 시 대기
        if (this.scheduler && this.scheduler.isBusy()) {
            const wait = Math.max(60000, this.scheduler.nextFireInMs() + 60000);
            log.info(`[건설큐] 스케줄러 임박 → ${Math.round(wait / 1000)}초 후`);
            this.scheduleNext(wait);
            return;
        }

        const now = Date.now();
        const ready = [...this.villages.values()].filter(v => v.nextCheckAt <= now);
        if (ready.length === 0) { this.scheduleNext(); return; }

        if (this.botLock) {
            try { await this.botLock.acquire('building'); }
            catch (e) { log.warn(`[건설큐] 락 실패: ${e.message}`); this.scheduleNext(); return; }
        }
        if (this.stopped) {
            if (this.botLock) this.botLock.release('building');
            return;
        }

        this.running = true;
        try {
            for (const v of ready) {
                if (this.stopped) break;
                if (this.scheduler && this.scheduler.isBusy()) {
                    log.info('[건설큐] 스케줄러 감지 → 중단');
                    break;
                }

                try {
                    const r = await processBuildVillage(this.cdp, this.sessionId, this.baseUrl, v, v.priority, { maxQueueSize: this.maxQueueSize });
                    v.lastStatus = r;
                    if (r.status === 'built') {
                        // 큐 또 찼을 수 있으니 5~15초 후 재확인
                        v.nextCheckAt = Date.now() + randInt(5000, 15000);
                    } else if (r.status === 'waiting') {
                        // 자원 부족 → 생산 ETA + 5초 여유
                        v.nextCheckAt = Date.now() + (r.waitSec * 1000) + randInt(5000, 15000);
                        log.info(`[건설큐] ${v.name} → ${r.nextBuilding} Lv${r.currentLevel+1} 자원 대기 ${Math.round(r.waitSec/60)}분`);
                    } else if (r.status === 'full_queue') {
                        // 큐 가득 → 30초~1분 후 재확인
                        v.nextCheckAt = Date.now() + randInt(30000, 60000);
                    } else if (r.status === 'done') {
                        // 완료 → 1시간 후 재확인 (목표 변경 시 대비)
                        v.nextCheckAt = Date.now() + 3600000;
                        log.ok(`[건설큐] ${v.name} — 우선순위 리스트 완료`);
                    } else {
                        // error → 5분 후
                        v.nextCheckAt = Date.now() + 5 * 60 * 1000;
                        log.warn(`[건설큐] ${v.name} 에러: ${r.error}`);
                    }
                    await sleep(randInt(2000, 4000));
                } catch (e) {
                    if (e instanceof BotProtectionError) {
                        log.err(`🛑 [건설큐] 봇 프로텍션: ${e.detail.type}`);
                        this.stopped = true;
                        if (this.onBotProtection) this.onBotProtection(e.detail);
                        break;
                    }
                    v.nextCheckAt = Date.now() + 5 * 60 * 1000;
                    log.err(`[건설큐] ${v.name} 예외: ${e.message}`);
                }
            }
        } finally {
            this.running = false;
            if (this.botLock) this.botLock.release('building');
        }

        if (!this.stopped) this.scheduleNext();
    }

    status() {
        const now = Date.now();
        return {
            running: this.running,
            stopped: this.stopped,
            villages: [...this.villages.values()].map(v => ({
                villageId: v.villageId,
                name: v.name,
                prioritySize: v.priority.length,
                nextCheckInSec: Math.max(0, Math.round((v.nextCheckAt - now) / 1000)),
                lastStatus: v.lastStatus,
            })),
        };
    }
}

module.exports = BuildingQueue;
