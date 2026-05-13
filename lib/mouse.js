// 베지어 곡선 마우스 시뮬레이션 (CDP Input.dispatchMouseEvent)
// - 사용자의 OS 마우스를 안 건드림 (탭에만 가상 이벤트)
// - 8~22 스텝 베지어 곡선 + 가속도 + 떨림 + 클릭 down/up 간격

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

function rand(min, max) {
    return min + Math.random() * (max - min);
}

// 베지어 점 (3차)
function bezier(t, p0, p1, p2, p3) {
    const u = 1 - t;
    return {
        x: u*u*u*p0.x + 3*u*u*t*p1.x + 3*u*t*t*p2.x + t*t*t*p3.x,
        y: u*u*u*p0.y + 3*u*u*t*p1.y + 3*u*t*t*p2.y + t*t*t*p3.y,
    };
}

// ease-in-out (시작/끝 느리고 가운데 빠름)
function easeInOut(t) {
    return t < 0.5 ? 2*t*t : -1 + (4 - 2*t)*t;
}

async function dispatch(cdp, sessionId, type, x, y, button = 'none', clickCount = 0) {
    await cdp.send('Input.dispatchMouseEvent', {
        type,
        x: Math.round(x),
        y: Math.round(y),
        button,
        clickCount,
        buttons: button === 'left' ? 1 : 0,
    }, sessionId);
}

// 부드러운 마우스 이동 (베지어 + 가속 + 떨림)
async function moveTo(cdp, sessionId, fromX, fromY, toX, toY) {
    const dx = toX - fromX;
    const dy = toY - fromY;
    const dist = Math.sqrt(dx*dx + dy*dy);

    // 거리에 따라 스텝 (8~22)
    const steps = Math.max(8, Math.min(22, Math.round(dist / 10) + Math.floor(rand(0, 5))));

    // 베지어 컨트롤 포인트 — 직선 아닌 자연스러운 호
    const ctrl1 = {
        x: fromX + dx * 0.3 + rand(-1, 1) * dist * 0.3,
        y: fromY + dy * 0.3 + rand(-1, 1) * dist * 0.3,
    };
    const ctrl2 = {
        x: fromX + dx * 0.7 + rand(-1, 1) * dist * 0.3,
        y: fromY + dy * 0.7 + rand(-1, 1) * dist * 0.3,
    };
    const start = { x: fromX, y: fromY };
    const end = { x: toX, y: toY };

    // 매번 다른 속도 (0.6x ~ 1.6x)
    const speedFactor = rand(0.6, 1.6);

    for (let i = 1; i <= steps; i++) {
        const t = easeInOut(i / steps);
        const pt = bezier(t, start, ctrl1, ctrl2, end);
        // 미세 떨림 ±2px
        const jx = rand(-2, 2);
        const jy = rand(-2, 2);
        await dispatch(cdp, sessionId, 'mouseMoved', pt.x + jx, pt.y + jy);
        await sleep(rand(4, 16) * speedFactor);
    }

    // 최종 정확 좌표
    await dispatch(cdp, sessionId, 'mouseMoved', toX, toY);
}

// 클릭 (down → 30~150ms 대기 → up)
async function click(cdp, sessionId, x, y) {
    await dispatch(cdp, sessionId, 'mousePressed', x, y, 'left', 1);
    await sleep(rand(30, 150));
    await dispatch(cdp, sessionId, 'mouseReleased', x, y, 'left', 1);
}

// 한 동작: 시작 대기 → 이동 → 짧은 정지 → 클릭
// lastPos: 직전 마우스 위치 {x, y}
// targetPos: 타겟 좌표 {x, y}
async function moveAndClick(cdp, sessionId, lastPos, targetPos) {
    // 시작 전 200~700ms 대기 (마우스 찾는 시간)
    await sleep(rand(200, 700));

    await moveTo(cdp, sessionId, lastPos.x, lastPos.y, targetPos.x, targetPos.y);

    // 클릭 직전 짧은 정지
    await sleep(rand(20, 90));

    await click(cdp, sessionId, targetPos.x, targetPos.y);
}

// 가벼운 호버 (이동만, 클릭 없음)
async function hover(cdp, sessionId, lastPos, targetPos) {
    await sleep(rand(100, 400));
    await moveTo(cdp, sessionId, lastPos.x, lastPos.y, targetPos.x, targetPos.y);
}

// hCaptcha 등 봇 탐지 우회용 — 사람처럼 살펴보고 클릭
//   1. 시작점이 너무 멀거나 가까우면 자연스러운 거리로 보정
//   2. 타겟 근처(±15~30px) 호버 1단계
//   3. 1-3초 머무름 (페이지 보는 척)
//   4. 미세 흔들림 (≤5px 랜덤 이동 2~4회)
//   5. 정밀 타겟으로 천천히 이동
//   6. 클릭 직전 짧은 정지 + 클릭
//   7. 클릭 후 약간 이동 (사람은 마우스를 그대로 안 둠)
async function humanClick(cdp, sessionId, lastPos, targetPos) {
    // 1. 시작점 보정 — 너무 가깝거나 캡차 위에 있으면 멀리서 시작하는 척
    const dx = targetPos.x - lastPos.x, dy = targetPos.y - lastPos.y;
    const dist = Math.sqrt(dx*dx + dy*dy);
    let startPos = lastPos;
    if (dist < 50) {
        // 너무 가까움 — 페이지 어딘가 다른 곳에서 시작한 척
        startPos = {
            x: targetPos.x + rand(-200, 200),
            y: targetPos.y + rand(-150, 150),
        };
        // 그 위치까지 가는 척
        await moveTo(cdp, sessionId, lastPos.x, lastPos.y, startPos.x, startPos.y);
        await sleep(rand(300, 800));
    }

    // 2. 타겟 근처로 1차 이동 (15~30px 옆)
    const nearPos = {
        x: targetPos.x + rand(-30, 30),
        y: targetPos.y + rand(-25, 25),
    };
    await moveTo(cdp, sessionId, startPos.x, startPos.y, nearPos.x, nearPos.y);

    // 3. 살펴보는 척 (1-3초)
    await sleep(rand(1000, 3000));

    // 4. 미세 흔들림 (2~4회)
    let cur = nearPos;
    const wiggles = Math.floor(rand(2, 5));
    for (let i = 0; i < wiggles; i++) {
        const next = {
            x: targetPos.x + rand(-20, 20),
            y: targetPos.y + rand(-15, 15),
        };
        await moveTo(cdp, sessionId, cur.x, cur.y, next.x, next.y);
        cur = next;
        await sleep(rand(150, 500));
    }

    // 5. 정밀 타겟으로 이동
    await moveTo(cdp, sessionId, cur.x, cur.y, targetPos.x, targetPos.y);

    // 6. 클릭 직전 짧은 정지 (호버 인식 시간)
    await sleep(rand(80, 280));

    // 7. 클릭
    await click(cdp, sessionId, targetPos.x, targetPos.y);

    // 8. 클릭 후 살짝 이동 (마우스를 멈춰두지 않음)
    await sleep(rand(100, 400));
    const afterPos = {
        x: targetPos.x + rand(-40, 40),
        y: targetPos.y + rand(-30, 30),
    };
    await moveTo(cdp, sessionId, targetPos.x, targetPos.y, afterPos.x, afterPos.y);
    return afterPos;
}

module.exports = { moveTo, click, moveAndClick, hover, humanClick };
