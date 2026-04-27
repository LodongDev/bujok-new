// 스캐빈징 큐 — 마을별 복귀 시간 추적해서 개별 재실행
// 우선순위: scheduler(공격/예약/노블)가 바쁘면 yield
const { scavengeVillage, getMassStatus, BotProtectionError } = require('./scavenge');
const { sleep } = require('./page');
const { randInt } = require('./human');
const log = require('./log');

class ScavengeQueue {
    constructor(cdp, sessionId, baseUrl, scheduler, botLock, onBotProtection) {
        this.cdp = cdp;
        this.sessionId = sessionId;
        this.baseUrl = baseUrl;
        this.scheduler = scheduler;
        this.botLock = botLock;
        this.onBotProtection = onBotProtection;
        this.queue = [];
        this.villageIds = new Set();
        this.timer = null;
        this.running = false;
        this.stopped = false;
    }

    // 큐 시작 — 전체 마을 초기화
    async start(villages) {
        this.stopped = false;
        this.villageIds = new Set(villages.map(v => v.id));
        this.queue = [];

        log.info(`[큐] 시작 — ${villages.length}개 마을`);
        // 초기 상태 조회는 락 획득 후
        if (this.botLock) {
            await this.botLock.withLock('scavenge-init', async () => {
                this.running = true;
                try {
                    await this.refreshFromMass(villages);
                } finally {
                    this.running = false;
                }
            });
        } else {
            await this.refreshFromMass(villages);
        }
        this.scheduleNext();
    }

    stop() {
        this.stopped = true;
        if (this.timer) { clearTimeout(this.timer); this.timer = null; }
        log.info('[큐] 정지');
    }

    // 선택 마을 목록 동적 업데이트 (UI 체크박스 변경 반영)
    updateSelection(villageIds) {
        const newSet = new Set(villageIds);
        const removed = [...this.villageIds].filter(id => !newSet.has(id));
        const added = villageIds.filter(id => !this.villageIds.has(id));

        this.villageIds = newSet;
        // 제거된 마을은 큐에서 삭제
        if (removed.length > 0) {
            this.queue = this.queue.filter(q => newSet.has(q.villageId));
            log.info(`[큐] 선택 해제: ${removed.length}개 마을 큐에서 제거`);
        }
        // 새로 추가된 마을은 즉시 가능하게 넣기
        for (const id of added) {
            if (!this.queue.find(q => q.villageId === id)) {
                this.queue.push({ villageId: id, name: `마을 ${id}`, availableAt: Date.now() });
            }
        }
        if (added.length > 0) {
            log.info(`[큐] 선택 추가: ${added.length}개 마을 큐에 추가`);
            this.sortQueue();
        }
    }

    // scavenge_mass로 전체 상태 가져와서 큐 초기화/업데이트
    async refreshFromMass(villages) {
        const massData = await getMassStatus(this.cdp, this.sessionId, this.baseUrl);
        if (!Array.isArray(massData)) {
            log.err('[큐] mass 조회 실패');
            return;
        }

        const now = Date.now();
        for (const mv of massData) {
            if (!this.villageIds.has(mv.village_id)) continue;
            const v = villages.find(vv => vv.id === mv.village_id) || { id: mv.village_id, name: mv.village_name };

            // 진행 중인 옵션이 있으면 그 중 최대 return_time 후에 가능
            // 없으면 지금 바로 가능
            let maxReturn = 0;
            for (const opt of Object.values(mv.options || {})) {
                if (opt.scavenging_squad?.return_time) {
                    const rt = opt.scavenging_squad.return_time * 1000;
                    if (rt > maxReturn) maxReturn = rt;
                }
            }
            const availableAt = maxReturn > 0 ? maxReturn : now;
            this.addOrUpdate(v.id, v.name, availableAt);
        }
        this.sortQueue();
    }

    addOrUpdate(villageId, name, availableAt) {
        const existing = this.queue.find(q => q.villageId === villageId);
        if (existing) {
            existing.availableAt = availableAt;
            existing.name = name;
        } else {
            this.queue.push({ villageId, name, availableAt });
        }
    }

    sortQueue() {
        this.queue.sort((a, b) => a.availableAt - b.availableAt);
    }

    // 다음 실행 예약
    scheduleNext() {
        if (this.stopped || this.timer) return;
        if (this.queue.length === 0) {
            log.info('[큐] 비어있음');
            return;
        }

        const now = Date.now();
        const next = this.queue[0];
        const delay = Math.max(0, next.availableAt - now);

        if (delay > 0) {
            log.info(`[큐] 다음: ${next.name} — ${Math.round(delay / 60000)}분 후`);
        }

        this.timer = setTimeout(() => {
            this.timer = null;
            this.tick().catch(e => log.err(`[큐] tick 에러: ${e.message}`));
        }, delay + randInt(5000, 15000)); // 복귀 후 5~15초 여유
    }

    // 준비된 마을들 순차 처리
    async tick() {
        if (this.stopped || this.running) return;

        // 스케줄러(공격/예약/노블) 임박 → 대기
        if (this.scheduler && this.scheduler.isBusy()) {
            const wait = Math.max(60000, this.scheduler.nextFireInMs() + 60000);
            log.info(`[큐] 스케줄러 작업 임박 → ${Math.round(wait / 1000)}초 후 재시도`);
            this.timer = setTimeout(() => {
                this.timer = null;
                this.tick().catch(e => log.err(`[큐] tick 에러: ${e.message}`));
            }, wait);
            return;
        }

        // 봇 락 획득 (다른 작업 끝날 때까지 대기)
        if (this.botLock) {
            try {
                await this.botLock.acquire('scavenge');
            } catch (e) {
                log.warn(`[큐] 락 획득 실패: ${e.message}`);
                this.scheduleNext();
                return;
            }
        }
        if (this.stopped) {
            if (this.botLock) this.botLock.release('scavenge');
            return;
        }

        this.running = true;
        const now = Date.now();

        // 지금 준비된 마을들 (availableAt <= now)
        const ready = this.queue.filter(q => q.availableAt <= now);
        log.info(`[큐] 처리 시작 — 준비된 마을 ${ready.length}개`);

        for (const item of ready) {
            if (this.stopped) break;

            // 처리 직전 선택 상태 재확인 (UI에서 해제됐을 수 있음)
            if (!this.villageIds.has(item.villageId)) {
                log.info(`[큐] ${item.name} 선택 해제됨 → 스킵`);
                continue;
            }

            // 실행 중 스케줄러 급한 작업 들어오면 중단
            if (this.scheduler && this.scheduler.isBusy()) {
                log.warn('[큐] 스케줄러 작업 감지 → 중단, 나머지는 다음 기회에');
                break;
            }

            try {
                log.info(`[큐] ${item.name} 처리 중...`);
                const result = await scavengeVillage(this.cdp, this.sessionId, this.baseUrl, item.villageId);

                if (result.status === 'ok') {
                    // 전송된 옵션들의 최대 duration으로 다음 가능 시간 계산
                    const maxDuration = result.squads.reduce((max, s) => Math.max(max, s.duration || 0), 0);
                    item.availableAt = Date.now() + maxDuration * 1000;
                    log.ok(`[큐] ${item.name} 완료 — ${Math.round(maxDuration / 60)}분 후 재실행`);
                } else if (result.status === 'skip') {
                    // scavengeVillage가 실제 return_time 반환하면 그 시각 사용
                    if (result.nextAvailableAt) {
                        item.availableAt = result.nextAvailableAt;
                        const waitMin = Math.round((result.nextAvailableAt - Date.now()) / 60000);
                        log.info(`[큐] ${item.name} 스킵 (${result.reason}) — ${waitMin}분 후 (실제 복귀)`);
                    } else {
                        // 복귀 시간 알 수 없는 경우 (병력 부족, 잠금 등)
                        // 병력 부족은 생산 시간 고려 30분, 잠금/기타는 10분
                        const reason = result.reason || '';
                        const retryMin = reason.includes('병력') ? 30 : 10;
                        item.availableAt = Date.now() + retryMin * 60000;
                        log.info(`[큐] ${item.name} 스킵 (${reason}) — ${retryMin}분 후 재확인`);
                    }
                } else {
                    // 에러 → 5분 후 재시도
                    item.availableAt = Date.now() + 300000;
                    log.warn(`[큐] ${item.name} 에러 — 5분 후 재시도`);
                }

                // 마을 간 대기 (사람처럼)
                await sleep(randInt(3000, 7000));
            } catch (e) {
                if (e instanceof BotProtectionError) {
                    log.err(`🛑 [큐] 봇 프로텍션 감지: ${e.detail.type} — 정지`);
                    this.stopped = true;
                    if (this.onBotProtection) this.onBotProtection(e.detail);
                    break;
                }
                log.err(`[큐] ${item.name} 예외: ${e.message}`);
                item.availableAt = Date.now() + 300000;
            }
        }

        this.sortQueue();
        this.running = false;
        if (this.botLock) this.botLock.release('scavenge');
        if (!this.stopped) this.scheduleNext();
    }

    // 큐 상태 조회 (UI용)
    status() {
        const now = Date.now();
        return {
            running: this.running,
            stopped: this.stopped,
            size: this.queue.length,
            items: this.queue.map(q => ({
                villageId: q.villageId,
                name: q.name,
                availableAt: q.availableAt,
                readyIn: Math.max(0, q.availableAt - now),
            })),
        };
    }
}

module.exports = ScavengeQueue;
