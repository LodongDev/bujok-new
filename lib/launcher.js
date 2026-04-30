// Chrome 자동 실행 + TW 로그인 + 서버 감지
const { execSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const log = require('./log');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function rand(min, max) { return min + Math.random() * (max - min); }

const CHROME_PATHS = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    (process.env.LOCALAPPDATA || '') + '\\Google\\Chrome\\Application\\chrome.exe',
];

function findChrome() {
    for (const p of CHROME_PATHS) {
        try { if (fs.existsSync(p)) return p; } catch {}
    }
    return null;
}

function killAllChrome() {
    try {
        execSync('taskkill /IM chrome.exe /F 2>nul', { stdio: 'ignore', timeout: 10000 });
        log.info('기존 Chrome 종료 완료');
    } catch { log.debug('Chrome 프로세스 없음'); }
}

function launchChrome(cdpPort = 9222) {
    const chromePath = findChrome();
    if (!chromePath) throw new Error('Chrome을 찾을 수 없습니다');
    const userDataDir = path.join(__dirname, '..', '.chrome-data');
    if (!fs.existsSync(userDataDir)) fs.mkdirSync(userDataDir, { recursive: true });

    log.info('Chrome 실행...');
    const child = spawn(chromePath, [
        `--remote-debugging-port=${cdpPort}`,
        `--user-data-dir=${userDataDir}`,
        '--no-first-run', '--no-default-browser-check', '--disable-default-apps',
        '--start-maximized',
    ], { detached: true, stdio: 'ignore' });
    child.unref();
    return child;
}

async function waitForCDP(host = '127.0.0.1', port = 9222, timeoutMs = 30000) {
    log.info('CDP 대기...');
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const r = await new Promise((resolve, reject) => {
                const req = http.get(`http://${host}:${port}/json/version`, res => {
                    let d = ''; res.on('data', c => d += c);
                    res.on('end', () => resolve(JSON.parse(d)));
                });
                req.on('error', reject);
                req.setTimeout(2000, () => { req.destroy(); reject(new Error('timeout')); });
            });
            log.ok('CDP 연결됨');
            return r;
        } catch { await sleep(500); }
    }
    throw new Error('CDP 타임아웃');
}

// ==========================================
// 로그인 + 서버 감지 (전체 흐름)
// ==========================================
async function loginAndDetectServers(cdp, sessionId, username, password) {
    const { evaluate } = require('./runtime');
    const { navigate, waitForLoad } = require('./page');
    const { moveAndClick } = require('./mouse');
    const { typeText, clearField } = require('./keyboard');

    // 1. TW 메인 페이지
    log.info('TW 메인 페이지 접속...');
    await navigate(cdp, sessionId, 'https://www.tribalwars.net');
    await waitForLoad(cdp, sessionId);
    await sleep(2000);

    // 2. 현재 페이지 상태 판단 (리다이렉트 대기 포함)
    // www.tribalwars.net → 이미 로그인이면 서버 페이지로 리다이렉트될 수 있음
    let currentState = 'unknown';
    for (let check = 0; check < 5; check++) {
        currentState = await evaluate(cdp, sessionId, `
            (() => {
                const url = location.href;
                // 게임 안 (서버에 접속됨)
                if (url.includes('game.php') || document.querySelector('#menu_row')) return 'in_game';
                // 로그인 폼
                if (document.querySelector('input[name="username"]')) return 'login_page';
                // 서버 목록 (이미 로그인됨 — play 버튼/서버 링크)
                const playLinks = document.querySelectorAll('a[href*=".tribalwars.net/page/play"], a[href*="game.php"]');
                if (playLinks.length > 0) return 'world_select';
                // 게임 서버 링크 (en154, ens1, enc2 같은 패턴만 — www/forum/help 제외)
                const serverLinks = document.querySelectorAll('a[href*=".tribalwars.net"]');
                const exclude = ['www','forum','help','portal','static','dsen','hcaptcha'];
                let serverCount = 0;
                for (const a of serverLinks) {
                    const m = a.href.match(/https:\\/\\/([a-z]{2}[a-z0-9]{1,5})\\.tribalwars\\.net/);
                    if (m && !exclude.includes(m[1]) && m[1].match(/\\d/)) serverCount++;
                }
                if (serverCount > 0) return 'world_select';
                return 'unknown';
            })()
        `);
        log.debug(`상태 체크 ${check + 1}: ${currentState}`);
        if (currentState !== 'unknown') break;
        await sleep(1500);
    }

    if (currentState === 'in_game') {
        log.ok('이미 게임 접속됨');
        return await detectServersFromGame(cdp, sessionId);
    }

    if (currentState === 'world_select') {
        log.ok('이미 로그인됨 → 서버 목록 감지');
        return await detectServersFromWorldSelect(cdp, sessionId);
    }

    if (currentState !== 'login_page') {
        log.info('로그인 페이지로 이동 시도...');
        await evaluate(cdp, sessionId, `
            (() => {
                const loginLink = document.querySelector('a[href*="page/login"], a[href*="page/auth"], .login-link, a.btn-login');
                if (loginLink) { loginLink.click(); return; }
                // 직접 이동
                location.href = 'https://www.tribalwars.net';
            })()
        `);
        await sleep(3000);
        await waitForLoad(cdp, sessionId);
        await sleep(1000);
    }

    // 빈 자격증명이면 타이핑/제출 안 함 — 단순 상태 확인 호출용
    // (Chrome 자동완성이 잘못된 값 채워서 로그인 시도하는 버그 방지)
    if (!username || !password) {
        return { success: false, error: 'no_credentials', currentState, servers: [] };
    }

    // 3. 로그인 폼 필드 좌표 가져오기
    const fields = await evaluate(cdp, sessionId, `
        (() => {
            const u = document.querySelector('input[name="username"]');
            const p = document.querySelector('input[name="password"]');
            const btn = document.querySelector('.btn-login')
                || document.querySelector('input[type="submit"]')
                || document.querySelector('button[type="submit"]');
            const rem = document.querySelector('input[name="remember"], label[for="remember"]');
            if (!u || !p || !btn) return null;
            function rect(el) {
                el.scrollIntoView({ block: 'center' });
                const r = el.getBoundingClientRect();
                return { x: r.x + r.width/2, y: r.y + r.height/2 };
            }
            return {
                username: rect(u),
                password: rect(p),
                button: rect(btn),
                remember: rem ? rect(rem) : null,
            };
        })()
    `);

    if (!fields) {
        return { success: false, error: '로그인 폼을 찾을 수 없음', servers: [] };
    }

    let lastMouse = { x: 300, y: 200 };

    // 직접 값 설정 + input/change 이벤트 발화 (Chrome 자동완성 회피)
    // 캐릭터별 타이핑 시 자동완성이 첫 글자 'h' 후 가로채서 'hhhhhh' 같은 비정상 입력 발생하던 버그 수정
    async function setLoginField(name, value) {
        return await evaluate(cdp, sessionId, `
            (() => {
                const el = document.querySelector('input[name=${JSON.stringify(name)}]');
                if (!el) return false;
                el.focus();
                const proto = Object.getPrototypeOf(el);
                const desc = Object.getOwnPropertyDescriptor(proto, 'value');
                if (desc && desc.set) desc.set.call(el, ${JSON.stringify(value)});
                else el.value = ${JSON.stringify(value)};
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
                el.blur();
                return true;
            })()
        `);
    }

    // 4. 아이디 직접 설정 (자동완성 회피)
    log.info('아이디 입력 중...');
    await moveAndClick(cdp, sessionId, lastMouse, fields.username);
    lastMouse = fields.username;
    await sleep(rand(200, 400));
    await setLoginField('username', username);

    // 5. 비밀번호 직접 설정
    await sleep(rand(300, 600));
    log.info('비밀번호 입력 중...');
    await moveAndClick(cdp, sessionId, lastMouse, fields.password);
    lastMouse = fields.password;
    await sleep(rand(200, 400));
    await setLoginField('password', password);

    // 6. Remember me 클릭 (있으면)
    if (fields.remember) {
        await sleep(rand(400, 800));
        await moveAndClick(cdp, sessionId, lastMouse, fields.remember);
        lastMouse = fields.remember;
    }

    // 7. 잠깐 대기 → 로그인 버튼 클릭
    await sleep(rand(600, 1500));
    log.info('로그인 버튼 클릭...');
    await moveAndClick(cdp, sessionId, lastMouse, fields.button);

    // 6. 로그인 결과 대기 (최대 40초 — 첫 로그인 시 콜드 Chrome + 느린 TW 페이지 로드 대비)
    log.info('로그인 응답 대기...');
    for (let i = 0; i < 40; i++) {
        await sleep(1000);
        const status = await evaluate(cdp, sessionId, `
            (() => {
                const iteration = ${i};
                if (location.href.includes('game.php')) return 'in_game';

                // 캡차 — 실제로 보이는 챌린지만 감지 (invisible hCaptcha는 무시)
                const captchaFrame = document.querySelector('iframe[src*="hcaptcha.com/challenge"]');
                const captchaOverlay = document.querySelector('div[class*="challenge-container"]');
                if (captchaFrame || (captchaOverlay && captchaOverlay.offsetHeight > 100)) return 'captcha';

                // 에러 메시지
                const errEl = document.querySelector('.error-msg, .login_error, .error');
                if (errEl) {
                    const text = (errEl.textContent || '').trim();
                    if (text.length > 3) return 'error:' + text.slice(0, 100);
                }

                // 월드 선택 / 서버 목록 (로그인 성공)
                if (document.querySelectorAll('a[href*=".tribalwars.net/page/play"]').length > 0) return 'world_select';
                if (document.querySelectorAll('a[href*=".tribalwars.net/game"]').length > 0) return 'world_select';

                // 아직 로그인 페이지 — 처음 5초는 hCaptcha invisible 처리 시간
                if (document.querySelector('input[name="username"]')) {
                    return iteration < 5 ? 'processing' : 'still_login';
                }

                return 'loading';
            })()
        `);

        log.debug(`로그인 상태: ${status}`);

        if (status === 'in_game') {
            log.ok('로그인 성공 → 게임 접속됨');
            return await detectServersFromGame(cdp, sessionId);
        }
        if (status === 'captcha') {
            log.warn('캡차 감지! 체크박스 자동 클릭 시도...');
            const clickResult = await tryClickHcaptchaCheckbox(cdp, sessionId);
            if (clickResult === 'checked') {
                log.ok('체크박스 클릭 완료 → 처리 대기');
                await sleep(2000);
                continue; // 루프 재시작해서 상태 재확인
            }
            if (clickResult === 'image_challenge') {
                log.warn('이미지 챌린지 발생 — 수동 해결 필요');
                return { success: false, error: 'captcha', servers: [], message: '이미지 캡차 — Chrome에서 직접 풀어주세요' };
            }
            log.warn('체크박스 못 찾음 — 수동 해결 필요');
            return { success: false, error: 'captcha', servers: [], message: 'Chrome에서 캡차를 풀어주세요' };
        }
        if (status.startsWith('error:')) {
            return { success: false, error: status.slice(6), servers: [] };
        }
        if (status === 'world_select') {
            log.ok('로그인 성공 → 서버 목록 감지');
            return await detectServersFromWorldSelect(cdp, sessionId);
        }
        if (status === 'processing') {
            log.debug('hCaptcha 처리 중...');
            continue;
        }
        if (status === 'still_login') {
            log.warn('로그인 페이지에 머물러 있음 — 아이디/비밀번호 또는 캡차 확인');
        }
    }

    // 타임아웃 직전 마지막 검증 — 이미 로그인 됐는데 검출 못한 케이스 (느린 페이지 로드)
    log.info('타임아웃 — 최종 상태 확인...');
    await sleep(3000);
    const finalState = await evaluate(cdp, sessionId, `
        (() => {
            if (location.href.includes('game.php')) return 'in_game';
            if (document.querySelector('a[href*="page/play"]')
                || document.querySelectorAll('a[href*=".tribalwars.net/game"]').length > 0) return 'world_select';
            return 'unknown';
        })()
    `);
    if (finalState === 'in_game') {
        log.ok('지연된 로그인 성공 → 게임 접속됨');
        return await detectServersFromGame(cdp, sessionId);
    }
    if (finalState === 'world_select') {
        log.ok('지연된 로그인 성공 → 서버 목록 감지');
        return await detectServersFromWorldSelect(cdp, sessionId);
    }

    return { success: false, error: '로그인 타임아웃', servers: [] };
}

// ==========================================
// hCaptcha 체크박스 자동 클릭 (invisible → 체크박스 단계)
// 이미지 챌린지 뜨면 포기하고 수동 요청
// ==========================================
async function tryClickHcaptchaCheckbox(cdp, sessionId) {
    const { moveAndClick } = require('./mouse');

    // 1. 체크박스 iframe 위치 찾기 (hcaptcha.com/captcha)
    //    이미지 챌린지 iframe (hcaptcha.com/challenge)은 클릭 안 함
    const iframeInfo = await evaluate(cdp, sessionId, `
        (() => {
            // 체크박스 iframe (captcha 경로)
            const checkboxFrame = document.querySelector('iframe[src*="hcaptcha.com/captcha"]');
            // 이미지 챌린지 iframe (challenge 경로)
            const challengeFrame = document.querySelector('iframe[src*="hcaptcha.com/challenge"]');
            const challengeVisible = challengeFrame && challengeFrame.offsetParent !== null
                && challengeFrame.getBoundingClientRect().height > 100;

            if (challengeVisible) return { type: 'image_challenge' };

            if (!checkboxFrame || checkboxFrame.offsetParent === null) return { type: 'not_found' };
            checkboxFrame.scrollIntoView({ block: 'center' });
            const r = checkboxFrame.getBoundingClientRect();
            return { type: 'checkbox', x: r.x, y: r.y, w: r.width, h: r.height };
        })()
    `);

    if (iframeInfo?.type === 'image_challenge') return 'image_challenge';
    if (iframeInfo?.type !== 'checkbox') return 'not_found';

    // 2. 체크박스 iframe 안의 체크박스 위치 추정
    //    표준 hCaptcha 체크박스 iframe: 약 300x78, 체크박스는 좌측 (약 x=30, y=38)
    const targetX = iframeInfo.x + 30;
    const targetY = iframeInfo.y + iframeInfo.h / 2;

    // 3. 사람처럼 마우스 이동 + 클릭
    const lastMouse = { x: targetX - 150 + Math.random() * 60, y: targetY - 80 + Math.random() * 60 };
    await moveAndClick(cdp, sessionId, lastMouse, { x: targetX, y: targetY });
    await sleep(1500);

    // 4. 결과 확인: 이미지 챌린지가 떴는지
    const afterClick = await evaluate(cdp, sessionId, `
        (() => {
            const challengeFrame = document.querySelector('iframe[src*="hcaptcha.com/challenge"]');
            if (challengeFrame && challengeFrame.offsetParent !== null) {
                const r = challengeFrame.getBoundingClientRect();
                if (r.height > 100) return 'image_challenge';
            }
            return 'ok';
        })()
    `);

    if (afterClick === 'image_challenge') return 'image_challenge';
    return 'checked';
}

// ==========================================
// 서버 감지: 게임 안에서 (api/world_switch)
// ==========================================
async function detectServersFromGame(cdp, sessionId) {
    const { evaluate } = require('./runtime');

    // 현재 서버
    const currentServer = await evaluate(cdp, sessionId, `
        location.hostname.match(/^([a-z0-9]+)\\.tribalwars\\.net$/)?.[1] || null
    `);

    // api/world_switch로 전체 서버 목록
    const servers = await evaluate(cdp, sessionId, `
        (async () => {
            try {
                const res = await fetch(location.origin + '/game.php?screen=api&ajax=world_switch', {
                    headers: { 'TribalWars-Ajax': '1', 'X-Requested-With': 'XMLHttpRequest' },
                });
                const json = await res.json();
                const html = json.html || '';
                const matches = [...html.matchAll(/submit_login\\('server_([a-z0-9]+)'\\)/gi)];
                return matches.map(m => m[1]);
            } catch { return []; }
        })()
    `);

    const result = [];
    if (currentServer) {
        result.push({ server: currentServer, label: currentServer + ' (현재)', current: true });
    }
    for (const s of (servers || [])) {
        if (s !== currentServer) {
            result.push({ server: s, label: s });
        }
    }

    // 서버 못 찾으면 현재 서버라도
    if (result.length === 0 && currentServer) {
        result.push({ server: currentServer, label: currentServer });
    }

    log.ok(`서버 ${result.length}개 감지: ${result.map(s => s.server).join(', ')}`);
    return { success: true, servers: result };
}

// ==========================================
// 서버 감지: 월드 선택 페이지에서
// ==========================================
// www 월드 선택 페이지에서 서버 목록 감지 (진입하지 않고 HTML에서 직접 파싱)
async function detectServersFromWorldSelect(cdp, sessionId) {
    const { evaluate } = require('./runtime');

    log.info('월드 선택 페이지에서 서버 목록 파싱...');
    const servers = await evaluate(cdp, sessionId, `
        (() => {
            const results = [];
            // 상대경로 /en-dk/page/play/xxx 와 절대경로 https://xxx.tribalwars.net/page/play 모두 처리
            const links = document.querySelectorAll('a[href*="page/play/"]');
            for (const a of links) {
                const m = a.href.match(/page\\/play\\/([a-z0-9]+)/);
                if (!m) continue;
                const server = m[1];
                const span = a.querySelector('span');
                const label = (span ? span.textContent : a.textContent).trim();
                const active = span ? span.className.includes('world_button_active') : true;
                // hidden 클래스로 숨겨진 서버도 포함
                const hidden = a.className.includes('hidden');
                results.push({ server, label, active, hidden });
            }
            // 중복 제거 (서버명 기준)
            const seen = new Set();
            return results.filter(r => {
                if (seen.has(r.server)) return false;
                seen.add(r.server);
                return true;
            });
        })()
    `);

    if (!servers || servers.length === 0) {
        log.warn('서버 목록을 찾을 수 없음 — 폴백 시도');
        return await detectServersFromWorldSelectFallback(cdp, sessionId);
    }

    const activeServers = servers.filter(s => s.active);
    const inactiveServers = servers.filter(s => !s.active);
    log.ok(`서버 ${servers.length}개 감지 (활성 ${activeServers.length}개, 비활성 ${inactiveServers.length}개)`);
    for (const s of servers) {
        log.info(`  ${s.active ? '●' : '○'} ${s.server.padEnd(8)} ${s.label}${s.hidden ? ' (숨김)' : ''}`);
    }

    return { success: true, servers };
}

// 폴백: DOM 파싱 실패 시 HTML 텍스트에서 서버 추출
async function detectServersFromWorldSelectFallback(cdp, sessionId) {
    const { evaluate } = require('./runtime');

    const servers = await evaluate(cdp, sessionId, `
        (() => {
            const html = document.documentElement.innerHTML;
            const results = [];
            // 상대경로 패턴
            const relMatches = html.matchAll(/page\\/play\\/([a-z0-9]+)/g);
            for (const m of relMatches) results.push(m[1]);
            // 절대경로 패턴
            const absMatches = html.matchAll(/https:\\/\\/([a-z]{2}[a-z0-9]{1,5})\\.tribalwars\\.net\\/game\\.php/g);
            for (const m of absMatches) results.push(m[1]);
            // 서버 서브도메인 (숫자 포함)
            const exclude = new Set(['www','forum','help','portal','static','dsen','hcaptcha','cdn']);
            const subMatches = html.matchAll(/https:\\/\\/([a-z]{2}[a-z0-9]{1,5})\\.tribalwars\\.net/g);
            for (const m of subMatches) {
                if (!exclude.has(m[1]) && m[1].match(/\\d/)) results.push(m[1]);
            }
            return [...new Set(results)];
        })()
    `);

    if (!servers || servers.length === 0) {
        return { success: false, error: '게임 서버를 찾을 수 없음', servers: [] };
    }

    log.ok(`폴백: 서버 ${servers.length}개 감지: ${servers.join(', ')}`);
    return {
        success: true,
        servers: servers.map(s => ({ server: s, label: s, active: true, hidden: false })),
    };
}

// ==========================================
// 특정 서버 접속
// ==========================================
async function enterServer(cdp, sessionId, serverName) {
    const { evaluate } = require('./runtime');
    const { navigate, waitForLoad } = require('./page');

    log.info(`${serverName} 서버 접속...`);
    await navigate(cdp, sessionId, `https://${serverName}.tribalwars.net/game.php`);
    await waitForLoad(cdp, sessionId);
    await sleep(2000);

    for (let i = 0; i < 10; i++) {
        const ok = await evaluate(cdp, sessionId, `
            location.href.includes('game.php') && !!document.querySelector('#menu_row, #menu_row2')
        `);
        if (ok) { log.ok(`${serverName} 접속 완료`); return true; }
        await sleep(1000);
    }
    log.warn(`${serverName} 접속 실패`);
    return false;
}

module.exports = { findChrome, killAllChrome, launchChrome, waitForCDP, loginAndDetectServers, enterServer };
