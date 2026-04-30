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
        // 최근 공격한 타겟 추적 (라운드 간 같은 마을 반복 공격 방지)
        // targetId → { sentAtMs, returnsAtMs }
        this.recentTargets = new Map();
        // 같은 타겟 재공격 차단 시간 (모를 때 fallback)
        this.cooldownMs = 10 * 60 * 1000;

        // 적응형 쿨다운 — 타겟별 평균 loot로 최적 주기 계산
        // targetId → { avgLoot, attackCount, lastUpdated }
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
            const tally = new Map(); // coordsKey → { totalLoot, count }
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
            // 좌표 → avgLoot 매핑 (target ID 모를 수도 있어 좌표 기반)
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
        // 서버명 추출 (baseUrl 'https://en155.tribalwars.net' → 'en155')
        const m = this.baseUrl.match(/https:\/\/([a-z0-9]+)\.tribalwars\.net/);
        if (m) this.loadTargetStats(m[1]);
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
            // 만료된 cooldown 정리 (메모리 누적 방지)
            // 객체 형식 (returnsAtMs) 또는 숫자 형식 (legacy) 둘 다 처리
            const nowMs = Date.now();
            for (const [tid, rec] of this.recentTargets.entries()) {
                const expiry = typeof rec === 'object' ? rec.returnsAtMs : rec + this.cooldownMs;
                if (nowMs > expiry) this.recentTargets.delete(tid);
            }
            const { grandTotal, earliestReturnMs } = await farmAllVillages(this.cdp, this.sessionId, this.baseUrl, this.villages, {
                ...this.options,
                recentTargets: this.recentTargets,
                cooldownMs: this.cooldownMs,
                targetStatsByCoords: this.targetStatsByCoords,
            });
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
