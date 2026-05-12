// 자동 동줍 큐 — 마을별 독립 타이머
// 각 마을이 자기 부대 복귀 시각에 맞춰 자기만 처리. BotLock으로 동시 실행 직렬화.
// 글로벌 배치(이전 버전)에서 마을별 독립으로 변경 — 이른 복귀 마을 즉시 처리, idle 시간 최소화.

const { farmFromVillage, getReturnsForVillage, BotProtectionError } = require('./farm-auto');
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
        this.stopped = false;

        // 마을별 독립 상태
        this.villageTimers = new Map();      // villageId → setTimeout handle
        this.villageRunning = new Set();     // 현재 처리 중 마을 ID
        this.villageNextAt = new Map();      // villageId → ms (다음 실행 시각, UI용)

        // 폴백 주기 (복귀 시각 못 구할 때만)
        this.fallbackMinMs = 5 * 60 * 1000;
        this.fallbackMaxMs = 10 * 60 * 1000;

        // 최근 공격한 타겟 추적 — 마을별 독립 (다른 마을이 같은 타겟 공격해도 차단 안 함)
        // villageId → Map<targetId, { sentAtMs, returnsAtMs }>
        this.villageRecentTargets = new Map();
        this.cooldownMs = 7.5 * 60 * 1000;  // 7.5분 (30분/4)

        // 적응형 쿨다운 — 타겟별 평균 loot로 최적 주기 계산
        this.targetStats = new Map();
        this.statsLoaded = false;
    }

    // 누적 보고서에서 타겟별 평균 loot 추출 (보고서수집기가 누적한 데이터 활용)
    loadTargetStats(server) {
        if (this.statsLoaded) return;
        try {
            const fs = require('fs');
            const path = require('path');
            const f = path.join(__dirname, '..', 'data', `reports-${server}.jsonl`);
            if (!fs.existsSync(f)) { this.statsLoaded = true; return; }
            const tally = new Map();
            for (const l of fs.readFileSync(f, 'utf8').split('\n')) {
                if (!l.trim()) continue;
                try {
                    const r = JSON.parse(l);
                    if (r.isFarm === false) continue;
                    if (!r.dst) continue;
                    const k = `${r.dst[0]}|${r.dst[1]}`;
                    const t = (r.wood || 0) + (r.stone || 0) + (r.iron || 0);
                    const cur = tally.get(k) || { totalLoot: 0, count: 0 };
                    cur.totalLoot += t;
                    cur.count++;
                    tally.set(k, cur);
                } catch {}
            }
            this.targetStatsByCoords = new Map();
            for (const [k, v] of tally.entries()) {
                this.targetStatsByCoords.set(k, {
                    avgLoot: v.totalLoot / v.count,
                    attackCount: v.count,
                });
            }
            log.info(`[동줍큐] 타겟 통계 로드: ${this.targetStatsByCoords.size}개 마을 (보고서 기반)`);
            this.statsLoaded = true;
        } catch (e) { log.warn(`[동줍큐] 통계 로드 실패: ${e.message}`); this.statsLoaded = true; }
    }

    async start(villages, options = {}) {
        this.stopped = false;
        this.villages = villages;
        this.options = { ...this.options, ...options };
        const m = this.baseUrl.match(/https:\/\/([a-z0-9]+)\.tribalwars\.net/);
        if (m) this.loadTargetStats(m[1]);
        log.info(`[동줍큐] 시작 — ${villages.length}개 마을, mode=${this.options.mode} (마을별 독립)`);
        // 각 마을 첫 실행 — 시작 시각 분산 (3~30초)
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
        this.villageRecentTargets.clear();
        log.info('[동줍큐] 정지');
    }

    updateSelection(villageIds) {
        const ids = new Set(villageIds);
        const removed = this.villages.filter(v => !ids.has(v.id));
        this.villages = this.villages.filter(v => ids.has(v.id));
        // 제거된 마을 타이머 정리
        for (const v of removed) {
            const t = this.villageTimers.get(v.id);
            if (t) clearTimeout(t);
            this.villageTimers.delete(v.id);
            this.villageNextAt.delete(v.id);
        }
        // 새로 추가된 마을은 즉시 첫 실행 스케줄
        for (const v of this.villages) {
            if (!this.villageTimers.has(v.id) && !this.villageRunning.has(v.id)) {
                this._scheduleVillage(v.id, randInt(3000, 15000));
            }
        }
        log.info(`[동줍큐] 마을 ${this.villages.length}개로 갱신`);
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
            this._tickVillage(villageId).catch(e => log.err(`[동줍큐:${villageId}] tick 에러: ${e.message}`));
        }, delay);
        this.villageTimers.set(villageId, t);
    }

    async _tickVillage(villageId) {
        if (this.stopped) return;
        if (this.villageRunning.has(villageId)) return;

        const v = this.villages.find(vv => vv.id === villageId);
        if (!v) return; // 선택 해제됨

        // 스케줄러 임박 → 마을별 재시도
        if (this.scheduler && this.scheduler.isBusy()) {
            const wait = Math.max(60000, this.scheduler.nextFireInMs() + 60000);
            log.info(`[동줍:${v.name}] 스케줄러 임박 → ${Math.round(wait / 1000)}초 후`);
            this._scheduleVillage(villageId, wait);
            return;
        }

        // 락 획득 — 같은 시각 다른 마을과 경합 시 직렬화
        if (this.botLock) {
            try {
                await this.botLock.acquire(`farm-${villageId}`);
            } catch (e) {
                log.warn(`[동줍:${v.name}] 락 실패: ${e.message}`);
                this._scheduleVillage(villageId, randInt(30000, 60000));
                return;
            }
        }
        if (this.stopped) {
            if (this.botLock) this.botLock.release(`farm-${villageId}`);
            return;
        }

        this.villageRunning.add(villageId);
        let nextDelay = null;
        try {
            // 이 마을 전용 cooldown Map (다른 마을과 공유 X)
            let recentTargets = this.villageRecentTargets.get(villageId);
            if (!recentTargets) {
                recentTargets = new Map();
                this.villageRecentTargets.set(villageId, recentTargets);
            }
            // 만료된 항목 정리
            const nowMs = Date.now();
            for (const [tid, rec] of recentTargets.entries()) {
                const expiry = typeof rec === 'object' ? rec.returnsAtMs : rec + this.cooldownMs;
                if (nowMs > expiry) recentTargets.delete(tid);
            }

            // 한 마을만 처리
            const r = await farmFromVillage(this.cdp, this.sessionId, this.baseUrl, v, {
                ...this.options,
                recentTargets,
                cooldownMs: this.cooldownMs,
                targetStatsByCoords: this.targetStatsByCoords,
            });
            const failPart = r.totalFailed > 0 ? ` (실패 ${r.totalFailed}: ${r.lastError || ''})` : '';
            log.ok(`[동줍:${v.name}] ${r.totalSent}회 전송${failPart}`);

            // 다음 실행 시각 결정 — 이 마을의 overview 조회로 실제 복귀 시각 파악
            try {
                const ov = await getReturnsForVillage(this.cdp, this.sessionId, this.baseUrl, v.id);
                if (ov?.ok && ov.returns.length > 0) {
                    let earliest = null;
                    for (const ret of ov.returns) {
                        if (!earliest || ret.endtimeMs < earliest) earliest = ret.endtimeMs;
                    }
                    if (earliest) {
                        const remain = earliest - Date.now();
                        nextDelay = Math.max(30000, remain + randInt(5000, 30000));
                    }
                }
            } catch (e) { log.warn(`[동줍:${v.name}] overview 실패: ${e.message}`); }

            // overview 못 구했고 farm 결과의 earliestReturnMs가 있으면 사용
            if (!nextDelay && r.earliestReturnMs) {
                const remain = r.earliestReturnMs - Date.now();
                nextDelay = Math.max(30000, remain + randInt(5000, 30000));
            }
        } catch (e) {
            if (e instanceof BotProtectionError) {
                log.err(`🛑 [동줍:${v.name}] 봇 프로텍션 감지: ${e.detail.type} — 정지`);
                this.stopped = true;
                if (this.onBotProtection) this.onBotProtection(e.detail);
            } else {
                log.err(`[동줍:${v.name}] 실패: ${e.message}`);
            }
        } finally {
            this.villageRunning.delete(villageId);
            if (this.botLock) this.botLock.release(`farm-${villageId}`);
        }

        if (!this.stopped) this._scheduleVillage(villageId, nextDelay);
    }

    status() {
        const now = Date.now();
        return {
            running: this.villageRunning.size > 0,
            stopped: this.stopped,
            villages: this.villages.length,
            mode: this.options.mode,
            villageDetail: this.villages.map(v => ({
                id: v.id,
                name: v.name,
                running: this.villageRunning.has(v.id),
                nextInMs: this.villageNextAt.has(v.id) ? Math.max(0, this.villageNextAt.get(v.id) - now) : null,
            })),
        };
    }
}

module.exports = FarmQueue;
