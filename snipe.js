#!/usr/bin/env node
// 스나이핑 CLI — bujok-new
//
// 사용법:
//   node snipe.js --server ens1                         # 인커밍 목록 조회
//   node snipe.js --server ens1 --cmd 12345 --source 5442 --troops spear:100,sword:50
//
// 동작:
//   1. CDP로 Chrome에 연결
//   2. 인커밍 목록 조회 (도착시간 표시)
//   3. 스나이핑 대상 지정 시 → 타이밍 계산 → 정밀 발사

const CDP = require('./lib/cdp');
const { getIncomingsWithDetails, fetchCommandDetails } = require('./lib/incoming');
const { executeSnipe } = require('./lib/snipe');
const { detectVillages } = require('./lib/farm');
const { sleep } = require('./lib/page');
const log = require('./lib/log');

function parseArgs() {
    const args = {
        server: 'ens1', port: 9222, host: '127.0.0.1',
        cmd: null,          // 인커밍 command ID (스나이핑 대상)
        source: null,       // 출발 마을 ID
        troops: null,       // 병력 (예: 'spear:100,sword:50')
        offsetMs: 500,      // 도착 오프셋 (인커밍 후 +Nms)
    };
    const argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--server' && argv[i+1]) args.server = argv[++i];
        else if (a === '--port' && argv[i+1]) args.port = parseInt(argv[++i]);
        else if (a === '--host' && argv[i+1]) args.host = argv[++i];
        else if (a === '--cmd' && argv[i+1]) args.cmd = argv[++i];
        else if (a === '--source' && argv[i+1]) args.source = parseInt(argv[++i]);
        else if (a === '--troops' && argv[i+1]) args.troops = argv[++i];
        else if (a === '--offset' && argv[i+1]) args.offsetMs = parseInt(argv[++i]);
        else if (a === '--help' || a === '-h') {
            console.log('사용법: node snipe.js [옵션]');
            console.log('');
            console.log('인커밍 목록 확인:');
            console.log('  node snipe.js --server ens1');
            console.log('');
            console.log('스나이핑 실행:');
            console.log('  node snipe.js --server ens1 --cmd 12345 --source 5442 --troops spear:100,sword:50');
            console.log('');
            console.log('옵션:');
            console.log('  --server <name>       서버 (기본 ens1)');
            console.log('  --cmd <commandId>     스나이핑 대상 인커밍 command ID');
            console.log('  --source <villageId>  출발 마을 ID');
            console.log('  --troops <units>      병력 (예: spear:100,sword:50,light:20)');
            console.log('  --offset <ms>         도착 오프셋 (기본 500 = 인커밍 후 +500ms)');
            console.log('  --port <port>         CDP 포트 (기본 9222)');
            process.exit(0);
        }
    }
    return args;
}

function parseTroops(str) {
    if (!str) return null;
    const troops = {};
    for (const part of str.split(',')) {
        const [unit, count] = part.split(':');
        if (unit && count) troops[unit.trim()] = parseInt(count.trim());
    }
    return troops;
}

function formatTime(ms) {
    const d = new Date(ms);
    return d.toISOString().slice(11, 23);
}

function formatRemaining(ms) {
    const sec = Math.round(ms / 1000);
    if (sec < 60) return `${sec}초`;
    const min = Math.floor(sec / 60);
    const s = sec % 60;
    if (min < 60) return `${min}분 ${s}초`;
    const h = Math.floor(min / 60);
    const m = min % 60;
    return `${h}시간 ${m}분`;
}

async function main() {
    const args = parseArgs();
    const baseUrl = `https://${args.server}.tribalwars.net`;

    log.info('============================================');
    log.info(' bujok-new snipe v0.1');
    log.info(` 서버: ${args.server}`);
    log.info('============================================');

    // CDP 연결
    const cdp = new CDP(args.host, args.port);
    try { await cdp.connect(); }
    catch (e) {
        log.err(`CDP 연결 실패: ${e.message}`);
        process.exit(1);
    }

    // 새 탭
    const { targetId, sessionId } = await cdp.createTab(`${baseUrl}/game.php?screen=overview`);
    await cdp.send('Page.enable', {}, sessionId).catch(() => {});
    await cdp.send('Runtime.enable', {}, sessionId).catch(() => {});

    // 종료 핸들러
    process.on('SIGINT', async () => {
        log.warn('종료 중...');
        try { await cdp.closeTab(targetId); } catch {}
        process.exit(0);
    });

    // 마을 목록 (출발지 후보용)
    const villages = await detectVillages(cdp, sessionId, baseUrl);

    // 인커밍 조회
    const villageId = args.source || villages[0]?.id;
    if (!villageId) {
        log.err('마을 없음');
        process.exit(1);
    }

    log.info(`인커밍 조회 중... (village=${villageId})`);
    const incomings = await getIncomingsWithDetails(cdp, sessionId, baseUrl, villageId);

    if (incomings.length === 0) {
        log.info('현재 인커밍 없음');
        await cdp.closeTab(targetId);
        process.exit(0);
    }

    // 인커밍 목록 표시
    console.log('');
    log.info(`=== 인커밍 ${incomings.length}건 ===`);
    for (const inc of incomings) {
        const remaining = inc.arrivalTimestamp - Date.now();
        const unitStr = Object.entries(inc.units).map(([u,c]) => `${u}:${c}`).join(' ') || '?';
        const tag = inc.type === 'attack' ? '⚔ 공격' : inc.type === 'support' ? '🛡 원군' : '? ' + inc.type;
        console.log(`  ${tag}  cmd=${inc.commandId}  도착 ${formatTime(inc.arrivalTimestamp)} (${remaining > 0 ? formatRemaining(remaining) + ' 후' : '이미 도착'})`);
        console.log(`         출발: ${inc.sourceVillageId}  →  타겟: ${inc.targetVillageId}`);
        console.log(`         유닛: ${unitStr}`);
        console.log('');
    }

    // --cmd 지정 안 됐으면 목록만 출력하고 종료
    if (!args.cmd) {
        log.info('스나이핑 하려면: node snipe.js --cmd <commandId> --source <villageId> --troops <units>');
        await cdp.closeTab(targetId);
        process.exit(0);
    }

    // 스나이핑 대상 찾기
    const target = incomings.find(inc => String(inc.commandId) === String(args.cmd));
    if (!target) {
        log.err(`command ID ${args.cmd}를 인커밍에서 못 찾음`);
        await cdp.closeTab(targetId);
        process.exit(1);
    }

    // 출발 마을 확인
    const sourceVillage = villages.find(v => v.id === args.source);
    if (!sourceVillage) {
        log.err(`출발 마을 ${args.source}를 못 찾음 (보유 마을: ${villages.map(v => v.id).join(', ')})`);
        await cdp.closeTab(targetId);
        process.exit(1);
    }

    // 타겟 좌표 — 인커밍 타겟 마을 좌표
    const targetVillageForSnipe = villages.find(v => v.id === target.targetVillageId);
    if (targetVillageForSnipe) {
        target.targetX = targetVillageForSnipe.x;
        target.targetY = targetVillageForSnipe.y;
    } else {
        log.err(`타겟 마을 ${target.targetVillageId}의 좌표를 못 찾음`);
        await cdp.closeTab(targetId);
        process.exit(1);
    }

    // 병력
    const troops = parseTroops(args.troops);
    if (!troops || Object.keys(troops).length === 0) {
        log.err('병력 지정 필요: --troops spear:100,sword:50');
        await cdp.closeTab(targetId);
        process.exit(1);
    }

    // 스나이핑 실행
    try {
        const result = await executeSnipe(cdp, sessionId, baseUrl, {
            incoming: target,
            source: { villageId: sourceVillage.id, x: sourceVillage.x, y: sourceVillage.y },
            troops,
            offsetMs: args.offsetMs,
        });

        log.ok('=== 스나이핑 완료 ===');
        log.ok(`발사 정확도: ${result.diffMs > 0 ? '+' : ''}${result.diffMs}ms`);
    } catch (e) {
        log.err(`스나이핑 실패: ${e.message}`);
    }

    await cdp.closeTab(targetId);
    process.exit(0);
}

main().catch(err => {
    log.err(`치명적 에러: ${err.message}`);
    console.error(err);
    process.exit(1);
});
