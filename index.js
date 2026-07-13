/**
 * 📷 Polaroid - SillyTavern Extension
 * Vertex AI Express (연결 프로필 or 직접 키) 방식으로 이미지 생성
 */

import { getContext, extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced, eventSource, event_types } from '../../../../script.js';

// ── style.css 로드 (fetch 후 <style> 태그로 직접 주입) ─────────
// <link rel="stylesheet">를 안 쓰는 이유: 일부 환경(Termux 서버 등)에서 .css를
// text/plain으로 내려주면 브라우저가 스타일시트로 인식하지 않고 막아버리는 경우가
// 있었음. fetch로 텍스트만 받아서 <style>에 넣으면 Content-Type과 무관하게 항상 적용됨.
// (예전에는 이 CSS를 index.js 안에 통째로 복사해서 하드코딩했었는데, 그러면 style.css
//  파일을 아무리 고쳐도 화면엔 반영되지 않는 상태가 됨 — 지금은 style.css가 유일한
//  진짜 스타일 소스이고, 여기서 그 파일을 그대로 읽어와서 적용함)
async function injectStyles() {
    if (document.getElementById('pol-injected-css')) return;
    try {
        const cssUrl = new URL('./style.css', import.meta.url).href;
        const res = await fetch(cssUrl, { cache: 'no-cache' });
        if (!res.ok) throw new Error(`style.css fetch 실패 [${res.status}]`);
        const cssText = await res.text();
        const style = document.createElement('style');
        style.id = 'pol-injected-css';
        style.textContent = cssText;
        document.head.appendChild(style);
    } catch (e) {
        console.warn('[Polaroid] style.css 로드 실패, 최소 폴백 스타일 사용:', e);
        ensureFallbackStyles();
    }
}

const EXT = 'polaroid';

// ── CSRF 토큰 자체 조달 ───────────────────────────────────
// script.js의 getRequestHeaders()를 import하는 방식은 ST 버전에 따라 그런 이름의
// export가 없을 수 있고, 그 경우 모듈 전체가 깨져서 확장이 통째로 로드 안 됨
// (카메라 버튼/마법봉 메뉴가 전부 사라지는 사고가 실제로 이래서 발생함).
// 그래서 ST 표준 엔드포인트(/csrf-token)에서 직접 토큰을 받아와 캐시해두는 방식으로 대체.
let _csrfTokenCache = null;
async function getCsrfToken() {
    if (_csrfTokenCache) return _csrfTokenCache;
    try {
        const res = await fetch('/csrf-token', { credentials: 'include' });
        if (res.ok) {
            const data = await res.json();
            _csrfTokenCache = data?.token || '';
        }
    } catch (e) {
        console.warn('[Polaroid] CSRF 토큰 조회 실패:', e);
    }
    return _csrfTokenCache || '';
}

// ── 모델 목록 ─────────────────────────────────────────────
const IMAGE_MODELS = [
    { value: 'gemini-3.1-flash-image',  label: '🍌 Gemini 3.1 Flash Image (Nano Banana 2, GA)' },
    { value: 'gemini-3-pro-image',      label: 'Gemini 3 Pro Image (Nano Banana Pro, GA)' },
    { value: 'gemini-3.5-flash',        label: '✨ Gemini 3.5 Flash (이미지+텍스트)' },
    { value: 'gemini-2.5-flash-image',  label: 'Gemini 2.5 Flash Image (Nano Banana)' },
];

const PROMPT_MODELS = [
    { value: 'gemini-3.5-flash',     label: '✨ Gemini 3.5 Flash' },
    { value: 'gemini-3.1-flash-lite',label: 'Gemini 3.1 Flash Lite' },
    { value: 'gemini-2.5-flash',     label: 'Gemini 2.5 Flash' },
    { value: 'gemini-2.5-flash-lite',label: 'Gemini 2.5 Flash Lite' },
];

const DEFAULTS = {
    api_mode: 'direct',          // 'profile' = 서버 플러그인 경유(키 자동) | 'direct' = 직접 입력
    profile_provider: 'aistudio', // 'aistudio' = Google AI Studio 키 | 'vertex' = Vertex AI Express 키
    project_id: '',
    region: 'global',
    direct_api_key: '',
    direct_project_id: '',
    direct_region: 'global',
    image_model: 'gemini-3.1-flash-image',
    prompt_model: 'gemini-3.5-flash',
    image_style: 'shot on iPhone, candid photo, casual selfie aesthetic, natural ambient lighting, slight film grain, authentic skin texture with visible pores, imperfect asymmetric framing, unposed candid moment, soft window light or golden hour light, realistic depth of field, sharp jawline, defined bone structure, clear healthy skin, effortlessly styled hair, confident relaxed expression, striking eyes, model-like facial proportions, attractive masculine features, good lighting on face highlighting bone structure',
    negative_prompt: 'overly smooth skin, airbrushed, plastic skin, symmetric studio lighting, posed stiff smile, generic AI face, waxy skin, over-sharpened, distorted, text, watermark',
};

function getExtSettings() {
    try {
        const ctx = (typeof getContext === 'function' ? getContext : SillyTavern.getContext)();
        if (!ctx.extensionSettings) return null;
        if (!ctx.extensionSettings[EXT]) ctx.extensionSettings[EXT] = {};
        return ctx.extensionSettings[EXT];
    } catch(e) {
        return extension_settings[EXT] || null;
    }
}

function cfg() {
    const s = getExtSettings();
    if (!s) return { ...DEFAULTS };
    return Object.assign({}, DEFAULTS, s);
}

// ── 프로필 모드: 서버 플러그인(polaroid-proxy) 경유 호출 ──────────
// 왜 필요한가: 브라우저(확장 JS)에서 /api/secrets/view를 호출하면 최신 ST는
// 보안상 403을 돌려줘서 원본 키를 프론트로 절대 못 가져온다. 반면 서버 플러그인은
// ST 서버 프로세스 안에서 동작하므로 secrets.json을 직접 읽을 수 있다.
//
// ST의 secrets.json은 카테고리(api_key_makersuite/api_key_vertexai/api_key_custom)별로
// { id, value, label, active } 배열을 저장하고, 연결 프로필의 secret-id가 그 id와 매칭된다.
// 그래서 프로필의 secret-id만 넘기면, 서버 플러그인이 어느 카테고리에서 찾았는지로
// provider(aistudio/vertex)까지 자동으로 판별해서 호출해준다. 사람이 직접 고를 필요 없음.
// 필요 조건: plugins/polaroid-proxy 서버 플러그인이 설치되어 있고
// config.yaml의 enableServerPlugins: true 여야 함. (README.md 참고)
async function proxyGenerate(model, body) {
    const c = cfg();
    const profileId = c.profile_id || '';
    if (!profileId) {
        throw new Error('설정 패널에서 연결 프로필을 먼저 선택하고 저장해주세요.');
    }

    const svc = SillyTavern.getContext().ConnectionManagerRequestService;
    const profile = svc.getSupportedProfiles().find(p => p.id === profileId);
    if (!profile) throw new Error('선택한 연결 프로필을 찾을 수 없습니다. 설정에서 다시 선택해주세요.');

    const secretId = profile['secret-id'];
    if (!secretId) {
        throw new Error('이 프로필에는 secret-id가 없습니다 (키가 필요 없는 백엔드이거나 지원되지 않는 프로필 형식입니다).');
    }

    const res = await fetch('/api/plugins/polaroid-proxy/generate', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': await getCsrfToken(), // ST가 요구하는 CSRF 토큰 (이게 빠지면 403)
        },
        credentials: 'include',
        body: JSON.stringify({ secretId, model, body }),
    });

    if (!res.ok) {
        let detail = '';
        try { detail = JSON.stringify(await res.json()); } catch (_) { detail = await res.text().catch(() => ''); }
        throw new Error(
            `polaroid-proxy 서버 플러그인 호출 실패 [${res.status}]: ${detail.slice(0, 300)}\n` +
            `서버 플러그인이 설치/활성화 되어있는지 확인해주세요 (plugins/polaroid-proxy, config.yaml enableServerPlugins: true).`
        );
    }
    return await res.json();
}

// ── Vertex AI Express 직접 호출 ───────────────────────────
async function vertexPost(apiKey, projectId, region, model, body) {
    const regions = region === 'global' ? ['global', 'us-central1'] : [region];
    let lastErr;

    for (const r of regions) {
        const isLast = r === regions[regions.length - 1];
        const base = r === 'global'
            ? 'https://aiplatform.googleapis.com/v1'
            : `https://${r}-aiplatform.googleapis.com/v1`;
        const url = `${base}/projects/${projectId}/locations/${r}/publishers/google/models/${model}:generateContent`;

        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-goog-api-key': apiKey,
                },
                body: JSON.stringify(body),
            });

            if (!res.ok) {
                const err = await res.text();
                lastErr = new Error(`Vertex API [${res.status}] (${r}/${model}): ${err.slice(0, 300)}`);
                // 404/400은 "이 리전/모델 조합이 안 맞음"일 가능성이 높으니 다음 리전으로 폴백
                if ((res.status === 404 || res.status === 400) && !isLast) continue;
                throw lastErr;
            }
            return await res.json();
        } catch (e) {
            lastErr = e;
            if (!isLast) continue;
            throw e;
        }
    }
    throw lastErr || new Error('Vertex API 호출 실패');
}

// ── 통합 API 호출 ─────────────────────────────────────────
async function apiPost(model, body) {
    const c = cfg();
    let apiKey = '';
    let projectId = c.project_id || '';
    let region = c.region || 'global';

    if (c.api_mode === 'profile') {
        // 프로필 모드: 키를 브라우저로 가져오지 않고, 서버 플러그인에 위임해서 호출한다
        return proxyGenerate(model, body);
    } else {
        apiKey = c.direct_api_key || '';
        projectId = c.direct_project_id || '';
        region = c.direct_region || 'global';
        if (!apiKey) throw new Error('API 키가 없습니다. 설정 패널에서 Vertex AI Express 키(AIza...)를 입력해주세요.');
    }

    return vertexPost(apiKey, projectId, region, model, body);
}

// ── 최근 채팅 맥락 수집 (버튼 누른 메시지 + 직전 N개) ────
function getRecentChatContext(mesEl, maxMessages = 6) {
    // 버튼이 달린 메시지의 mesid
    const targetId = parseInt(mesEl.getAttribute('mesid') || '-1', 10);

    // 채팅창에 보이는 모든 .mes 수집
    const allMes = Array.from(document.querySelectorAll('.mes'));

    // 대상 메시지 인덱스 찾기
    const targetIdx = allMes.findIndex(el => parseInt(el.getAttribute('mesid') || '-1', 10) === targetId);
    const endIdx = targetIdx >= 0 ? targetIdx : allMes.length - 1;

    // 대상 포함해서 최대 maxMessages개 소급
    const slice = allMes.slice(Math.max(0, endIdx - maxMessages + 1), endIdx + 1);

    const lines = slice.map(el => {
        const isUser = el.getAttribute('is_user') === 'true' || el.classList.contains('is_user');
        const name = el.querySelector('.name_text')?.innerText?.trim() || (isUser ? 'User' : 'Character');
        const text = el.querySelector('.mes_text')?.innerText?.trim() || '';
        if (!text) return null;
        return `[${isUser ? 'USER' : 'CHARACTER'} — ${name}]: ${text}`;
    }).filter(Boolean);

    return lines.join('\n\n');
}

// ── ST 연결 프로필 응답에서 텍스트 추출 (응답 형태가 provider마다 다를 수 있어 방어적으로 처리) ──
function extractProfileText(result) {
    if (result == null) return '';
    if (typeof result === 'string') return result.trim();
    if (typeof result.content === 'string') return result.content.trim();
    if (typeof result.text === 'string') return result.text.trim();
    if (result.message && typeof result.message.content === 'string') return result.message.content.trim();
    if (Array.isArray(result.choices) && result.choices[0]?.message?.content) {
        return String(result.choices[0].message.content).trim();
    }
    console.warn('[Polaroid] 프로필 응답 형식을 인식하지 못함, 원문:', JSON.stringify(result)?.slice(0, 500));
    return '';
}

// ── 텍스트 생성 (장면 → 이미지 프롬프트) ──────────────────
async function summarizeSceneCore(sceneText, chatContext, promptModel) {
    const c = cfg();
    console.log('[Polaroid] sceneText 길이/내용:', sceneText?.length, sceneText?.slice(0, 200));
    console.log('[Polaroid] chatContext 길이/내용:', chatContext?.length, chatContext?.slice(0, 300));
    // 오래된 대화부터 잘리지 않도록 "뒤(최근)"에서부터 잘라서 사용 (2만자)
    const ctx = (chatContext || sceneText);
    const recentCtx = ctx.length > 100000 ? '...' + ctx.slice(-100000) : ctx;

    const summaryPrompt = `Below is a roleplay chat (oldest to newest). Focus ONLY on the LAST message — that is the current moment to capture.
Summarize the CURRENT physical scene in ONE short sentence (under 25 words).
Only describe: who is doing what, where, with what objects/clothing — concrete and literal, taken from the LAST message.
Earlier messages are background only — use them solely to clarify pronouns/location if the last message is ambiguous. Do NOT pull the scene from earlier messages if the last message describes something different.

CHAT (oldest → newest):
${recentCtx}

THE LAST MESSAGE IS THE SCENE TO CAPTURE:
${sceneText.slice(0, 10000)}

Return ONLY the one-sentence summary. No explanation.`;

    // ── 프로필 모드: ST에 이미 연결된 프로필로 바로 요청 (키 직접 입력 불필요) ──
    if (c.api_mode === 'profile' && c.profile_id) {
        const svc = SillyTavern.getContext().ConnectionManagerRequestService;
        const result = await svc.sendRequest(c.profile_id, summaryPrompt, 300, { extractData: true });
        const text = extractProfileText(result);
        console.log('[Polaroid] (프로필모드) 요약 결과:', text);
        return text;
    }

    const data = await apiPost(promptModel, {
        contents: [{ role: 'user', parts: [{ text: summaryPrompt }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 20000 },
        safetySettings: [
            { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'OFF' },
            { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'OFF' },
            { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'OFF' },
            { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'OFF' },
            { category: 'HARM_CATEGORY_CIVIC_INTEGRITY', threshold: 'OFF' },
        ],
    });
    console.log('[Polaroid] 요약 finishReason:', data?.candidates?.[0]?.finishReason, '| raw text:', JSON.stringify(data?.candidates?.[0]?.content?.parts?.[0]?.text));
    if (!data?.candidates?.[0]?.content?.parts?.[0]?.text) {
        console.warn('[Polaroid] 요약 응답 비정상:', JSON.stringify(data?.candidates?.[0] || data));
    }
    return data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
}

async function generatePrompt(sceneText, charInfo, userDirection, chatContext) {
    const c = cfg();
    const charDesc = [
        charInfo.name && `Name: ${charInfo.name}`,
        charInfo.description && `Appearance: ${charInfo.description.slice(0, 5000)}`,
        charInfo.personaName && `User persona name: ${charInfo.personaName}`,
        charInfo.personaDescription && `User persona appearance: ${charInfo.personaDescription.slice(0, 5000)}`,
    ].filter(Boolean).join('\n');

    // 프로필 모드면 프로필의 모델 사용, 아니면 prompt_model 사용
    let promptModel = c.prompt_model || 'gemini-3.5-flash';
    if (c.api_mode === 'profile' && c.profile_id) {
        try {
            const svc = SillyTavern.getContext().ConnectionManagerRequestService;
            const profile = svc.getSupportedProfiles().find(p => p.id === c.profile_id);
            if (profile?.model) promptModel = profile.model;
        } catch(_) {}
    }

    let sceneSummary = '';
    if (!userDirection) {
        try {
            sceneSummary = await summarizeSceneCore(sceneText, chatContext, promptModel);
            console.log('[Polaroid] scene summary:', sceneSummary);
        } catch (_) {}
    }

    // 캐릭터/페르소나 프사가 있으면, 직접 모드에서는 이미지 레퍼런스로 함께 전달
    const refNote = (charInfo.avatarBase64 || charInfo.personaAvatarBase64)
        ? '\n\nReference images are attached below — they show the actual face/hair/body of the character and/or user persona. Use them to keep appearance accurate and consistent with the description above.'
        : '';

    const promptText = userDirection
        ? `Generate an image prompt for this character:
${charDesc}${refNote}

SCENE TO DRAW: "${userDirection}"

Write a short English image generation prompt (under 120 words) showing exactly that scene with this character. Describe the scene, character appearance, setting, and lighting ONLY — do NOT write any style/quality/photography keywords (those will be appended separately).
Return ONLY the scene description. No explanation, no style tags.`
        : `Generate an image prompt for this character:
${charDesc}${refNote}

SCENE TO DRAW (literal, concrete — follow exactly): "${sceneSummary || sceneText.slice(0, 200)}"

Write a single English image generation prompt (under 180 words) showing exactly that scene/action/location with this character. Add setting and lighting details consistent with the scene above. Do NOT replace the scene with a generic or unrelated situation. Describe the scene, character appearance, setting, and lighting ONLY — do NOT write any style/quality/photography keywords (those will be appended separately).
Return ONLY the scene description. No explanation, no style tags.`;

    let sceneDescription = '';

    if (c.api_mode === 'profile' && c.profile_id) {
        // ── 프로필 모드: ST 연결 프로필로 바로 요청 (키 직접 입력 불필요) ──
        // 주의: 이 경로는 텍스트 전용이라 캐릭터/페르소나 "프사 이미지"는 함께 보낼 수 없고
        // 이름 + 설명 텍스트(위 charDesc, 5000자)만 반영됩니다. 프사까지 참고시키려면 "직접 입력" 모드를 사용하세요.
        try {
            const svc = SillyTavern.getContext().ConnectionManagerRequestService;
            const result = await svc.sendRequest(c.profile_id, promptText, 20000, { extractData: true });
            sceneDescription = extractProfileText(result);
            console.log('[Polaroid] (프로필모드) 프롬프트 생성 결과:', sceneDescription);
        } catch (e) {
            console.warn('[Polaroid] 프로필 모드 프롬프트 생성 실패:', e);
            throw new Error('연결 프로필로 요청 실패: ' + (e.message || e));
        }
    } else {
        // ── 직접 입력 모드: 캐릭터/페르소나 프사를 레퍼런스로 함께 전달 (외모 일치도 향상) ──
        const parts = [];
        if (charInfo.avatarBase64) {
            parts.push({ text: `Reference image of ${charInfo.name || 'the character'} — FACE AND HAIR ONLY. Body proportions/physique will be specified separately in text.` });
            parts.push({ inlineData: { mimeType: 'image/jpeg', data: charInfo.avatarBase64 } });
        }
        if (charInfo.personaAvatarBase64) {
            parts.push({ text: `Reference image of user persona ${charInfo.personaName || ''} — FACE AND HAIR ONLY. Body proportions/physique will be specified separately in text.` });
            parts.push({ inlineData: { mimeType: 'image/jpeg', data: charInfo.personaAvatarBase64 } });
        }
        parts.push({ text: promptText });

        const data = await apiPost(promptModel, {
            contents: [{ role: 'user', parts }],
            generationConfig: { temperature: 0.7, maxOutputTokens: 20000 },
            safetySettings: [
                { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'OFF' },
                { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'OFF' },
                { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'OFF' },
                { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'OFF' },
                { category: 'HARM_CATEGORY_CIVIC_INTEGRITY', threshold: 'OFF' },
            ],
        });
        console.log('[Polaroid] 프롬프트 finishReason:', data?.candidates?.[0]?.finishReason);
        sceneDescription = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
    }

    if (!sceneDescription) return '';

    // 등록된 스타일/네거티브 문구는 AI가 줄이지 못하도록 코드에서 그대로(토씨 하나 안 틀리고) 이어붙임
    const styleSuffix = c.image_style ? `\nStyle: ${c.image_style}` : '';
    const negativeSuffix = c.negative_prompt ? `\nNegative: ${c.negative_prompt}` : '';
    return sceneDescription + styleSuffix + negativeSuffix;
}

// ── 이미지 생성 ────────────────────────────────────────────
// ── 외형 관련 문장 자동 추출 ──────────────────────────────────────
// 캐릭터 설명에서 얼굴/신체 외형 관련 문장만 뽑아서 텍스트 참조로 추가한다.
// 이미지 참조 하나만으론 모델이 디테일을 놓치는 경우가 있어서, 텍스트로도 재확인시킴.

// ── 성적으로 노골적인 섹션(킹크·성기·성적취향 등)을 통째로 제거 ──────────────
// extractFace/BodyDescription의 키워드 매칭이 문장 단위라서, "Kinks: ...armpits...
// face sitting..." 같은 문장은 신체 키워드(armpit, face)가 우연히 섞여있다는 이유로
// 킹크 리스트 전체가 그대로 딸려 들어오는 문제가 있었다. 이미지 생성 API에 그런 텍스트가
// 통째로 전달되면 세이프티 필터(PROHIBITED_CONTENT)에 걸려 생성 자체가 막혀버린다.
// 그래서 신체/얼굴 추출을 하기 "전에" 노골적인 섹션 자체를 아예 잘라낸다.
function stripExplicitSections(description) {
    if (!description) return '';

    // 매칭시킬 섹션 헤더 키워드 (대괄호 헤더 "[[Sexual Behavior]]" 형태 + 인라인 "- Kinks:" 형태 둘 다 대응)
    const explicitHeaderRe = /kink|genitalia|sexual\s*behavio(u)?r|fetish|nsfw|intimacy|libido|partner\s*preference|vocalizations?\s*\(?during sex|experience:\s*(whore|slut)|hard\s*turn[- ]?on|hard\s*turn[- ]?off|turn[- ]?on|turn[- ]?off|성적\s*취향|성기|킹크|야한|성적\s*행동/i;
    const bracketHeaderRe = /^\s*\[\[.*\]\]\s*$/;

    const lines = description.split('\n');
    const kept = [];
    let skipping = false;

    for (const line of lines) {
        if (bracketHeaderRe.test(line)) {
            // 새로운 [[섹션]] 헤더를 만나면, 그 섹션이 노골적인 섹션인지에 따라 skip 상태 갱신
            skipping = explicitHeaderRe.test(line);
            if (skipping) continue; // 헤더 자체도 버림
        } else if (!skipping && /^\s*[-*]?\s*(kinks?|genitalia|fetish(es)?|libido|partner preferences?|experience|hard turn[- ]?ons?|hard turn[- ]?offs?)\s*:/i.test(line)) {
            // 대괄호 섹션 없이 인라인 라벨("- Kinks: ...")로만 오는 경우도 그 줄 자체를 버림
            continue;
        }
        if (skipping) continue;
        kept.push(line);
    }

    return kept.join('\n');
}

// ── 얼굴/헤어 관련 문장만 추출 (아바타 이미지의 face reference 텍스트 보강용) ──
// 1순위: "Hair:", "Eyes:" 같은 라벨이 붙은 필드가 있으면 그 줄만 정확히 뽑는다.
//   (라벨 없는 문장 전체를 훑는 기존 방식은, 배경 서사/성격/트라우마 서술 등에서
//    얼굴 관련 단어(face, eye 등)가 우연히 섞인 문장을 통째로 끌고 오는 문제가 있었음 —
//    예: "sexually abused... at 12" 같은 트라우마 서술이 신체 정보로 오인식되어
//    이미지 생성 프롬프트에 그대로 들어가 세이프티 필터에 걸리는 사고가 실제로 발생함)
// 2순위 폴백: 라벨 형식이 없는 자유서술형 카드는 기존 키워드 문장 매칭 사용
function extractFaceDescription(description) {
    if (!description) return '';
    const cleaned = stripExplicitSections(description);

    const FACE_LABEL_RE = /^[-*\s]*(hair|skin|eyes?|face|nose|mouth|lips?|eyebrows?|complexion)\s*:/i;
    const labeledLines = cleaned.split('\n')
        .map(l => l.trim())
        .filter(l => l.length > 8 && FACE_LABEL_RE.test(l));
    if (labeledLines.length) {
        return labeledLines.slice(0, 15).join('. ').trim().slice(0, 5000);
    }

    const faceKeywords = /\bhair\b|eye|skin|face|nose|mouth|lip|chin|jaw|cheek|brow|forehead|complexion|pupil|lash|freckle|pale|dark|tan|blond|brunette|redhead|silver|white hair|black hair|blue eye|green eye|brown eye|gray eye|눈|머리|피부|얼굴|코|입|턱|이목구비|눈썹|속눈썹|주근깨|창백|금발|흑발|은발/i;
    return cleaned.split(/[.。\n]+/)
        .filter(l => faceKeywords.test(l) && l.trim().length > 8)
        .slice(0, 30)
        .join('. ')
        .trim()
        .slice(0, 5000);
}

// ── 신체/체형 관련 문장만 추출 (텍스트 디스크립션에서 키·체중·문신 등 뽑기) ──
// 아바타 프사는 얼굴 클로즈업인 경우가 많아서 몸 정보를 이미지에서 읽히기 어렵다.
// 키·몸무게·문신·체형 같은 정보는 디스크립션 텍스트로 명시적으로 전달하는 게 더 정확함.
// 위 extractFaceDescription과 동일한 이유로 라벨 기반 추출을 1순위로 사용.
function extractBodyDescription(description) {
    if (!description) return '';
    const cleaned = stripExplicitSections(description);

    const BODY_LABEL_RE = /^[-*\s]*(body|height|weight|build|physique|piercings?|tattoos?)\s*:/i;
    const labeledLines = cleaned.split('\n')
        .map(l => l.trim())
        .filter(l => l.length > 8 && BODY_LABEL_RE.test(l));
    if (labeledLines.length) {
        return labeledLines.slice(0, 15).join('. ').trim().slice(0, 5000);
    }

    const bodyKeywords = /height|tall|short|weight|build|slim|thin|thick|muscle|athletic|curvy|tattoo|scar|piercing|chest|waist|hip|leg|arm|shoulder|stomach|abs|키|몸무게|문신|흉터|피어싱|체형|근육|허리|가슴|다리|팔|어깨|복근|날씬|마른|통통|뚱|체중|신장/i;
    return cleaned.split(/[.。\n]+/)
        .filter(l => bodyKeywords.test(l) && l.trim().length > 8)
        .slice(0, 30)
        .join('. ')
        .trim()
        .slice(0, 5000);
}


async function generateImage(imagePrompt, charInfo) {
    const c = cfg();
    const parts = [];

    const hasCharRef = !!charInfo.avatarBase64;
    const hasPersonaRef = !!charInfo.personaAvatarBase64;

    // ── 이미지를 "먼저" 보낸 뒤 설명 — Gemini는 이미지→텍스트 순서일 때 참조를 훨씬 잘 따름
    // ── 아바타는 얼굴·헤어 전용 레퍼런스로만 사용. 신체(키·문신·체형 등)는 텍스트 디스크립션에서 따로 전달.
    // (프사는 대부분 클로즈업이라 몸 정보를 이미지에서 읽히는 것 자체가 unreliable함)
    if (hasCharRef) {
        parts.push({ inlineData: { mimeType: 'image/jpeg', data: charInfo.avatarBase64 } });
        parts.push({ text: `↑ FACE & HAIR REFERENCE ONLY for "${charInfo.name || 'the character'}". This image is used exclusively to lock in facial features and hair — NOT body proportions (body info comes from text below). Reproduce without any change: eye shape and color (iris pattern, pupil), eyelid fold, brow shape and arch, nose bridge width and tip shape, philtrum, lip shape (upper bow and lower lip volume), chin contour, jawline angle, cheekbone position, hairline, hair color (exact hue and tone — not approximate), hair texture and curl pattern, skin tone. ANY facial deviation — smoother skin, different eye shape, altered nose, different jaw, different hair color — is a critical failure.` });

        // 얼굴·헤어 관련 텍스트 보강 (이미지가 저해상도일 때 디테일 보완)
        const faceDesc = extractFaceDescription(charInfo.description);
        if (faceDesc) {
            parts.push({ text: `Confirmed face/hair traits of ${charInfo.name || 'the character'} (secondary check — image above takes priority): ${faceDesc}` });
        }
    }

    if (hasPersonaRef) {
        parts.push({ inlineData: { mimeType: 'image/jpeg', data: charInfo.personaAvatarBase64 } });
        parts.push({ text: `↑ FACE & HAIR REFERENCE ONLY${charInfo.personaName ? ` for "${charInfo.personaName}"` : ' (user persona)'}. Same rule: face and hair only — NOT body proportions. Reproduce exact eyes, exact nose, exact mouth, exact hair color and texture. Do NOT smooth features, do NOT drift toward a generic face. The viewer must immediately recognize this as the same person from the reference photo.` });

        const personaFaceDesc = extractFaceDescription(charInfo.personaDescription);
        if (personaFaceDesc) {
            parts.push({ text: `Confirmed face/hair traits of ${charInfo.personaName || 'user persona'} (secondary check): ${personaFaceDesc}` });
        }
    }

    // ── 신체/체형 정보는 텍스트 디스크립션에서만 추출해서 전달
    // (키·몸무게·문신·흉터·체형 같은 정보는 아바타 프사에 담기지 않는 경우가 대부분)
    const bodyDesc = extractBodyDescription(charInfo.description);
    if (bodyDesc) {
        parts.push({ text: `Body/physique traits of ${charInfo.name || 'the character'} (from description — the reference image above does NOT contain this info, so follow the text): ${bodyDesc}` });
    }
    if (charInfo.personaDescription) {
        const personaBodyDesc = extractBodyDescription(charInfo.personaDescription);
        if (personaBodyDesc) {
            parts.push({ text: `Body/physique traits of ${charInfo.personaName || 'user persona'} (from description): ${personaBodyDesc}` });
        }
    }

    // ── 장면 생성 지시 — 얼굴 일관성 규칙을 앞뒤에서 샌드위치처럼 강조
    const faceRule = (hasCharRef || hasPersonaRef)
        ? `🔒 ABSOLUTE FACE LOCK — this overrides everything else:\nThe reference image(s) above show specific real individuals. Your top priority is to output those EXACT faces.\n- Same eye shape, eyelid fold, iris color and pattern\n- Same nose (bridge width, tip shape, nostril shape)\n- Same mouth (lip bow, lip thickness, corner position)\n- Same jawline, chin, cheekbones\n- Same hair: exact color tone, texture, curl/wave, hairline\n- Same skin tone (exact warmth and depth)\nDO NOT improve, idealize, or smooth the face. DO NOT drift toward a generic beauty standard. DO NOT change hair color even slightly. The viewer must look at the output and immediately recognize the same person from the reference.\n\n`
        : '';

    const finalCheck = (hasCharRef || hasPersonaRef)
        ? `\n\n🔒 FINAL FACE CHECK before output:\n□ Same eye shape and iris color?\n□ Same nose bridge and tip?\n□ Same lip shape?\n□ Same jawline and chin?\n□ Same exact hair color (tone and depth) and texture?\n□ Same skin tone?\nAll must match the reference photo. If any fails, correct before generating.`
        : '';

    parts.push({ text: faceRule + `Generate this scene:\n\n${imagePrompt}` + (c.negative_prompt ? `\n\nDo NOT include: ${c.negative_prompt}` : '') + finalCheck });

    // ── 진단용 로그: 실제로 이미지 모델에 전송되는 텍스트 전체를 콘솔에 남긴다 ──────
    // PROHIBITED_CONTENT 등으로 막혔을 때, API가 "어느 부분이 걸렸는지"는 안 알려주기
    // 때문에, 최종적으로 뭘 보냈는지 눈으로 직접 확인하고 의심 구간을 추측할 수 있게 함.
    // (base64 이미지 데이터는 용량이 커서 제외하고 텍스트만 남김)
    const sentTextsOnly = parts.filter(p => p.text).map((p, i) => `--- 텍스트 파트 #${i + 1} ---\n${p.text}`).join('\n\n');
    console.log(`[Polaroid] 📤 이미지 생성 요청 전송 텍스트 (전체 ${parts.filter(p => p.text).length}개 텍스트 파트, 이미지 ${parts.filter(p => p.inlineData).length}장):\n\n${sentTextsOnly}`);

    const data = await apiPost(c.image_model, {
        contents: [{ role: 'user', parts }],
        generationConfig: { responseModalities: ['IMAGE', 'TEXT'] },
        safetySettings: [
            { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'OFF' },
            { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'OFF' },
            { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'OFF' },
            { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'OFF' },
            { category: 'HARM_CATEGORY_CIVIC_INTEGRITY', threshold: 'OFF' },
        ],
    });

    const outParts = data?.candidates?.[0]?.content?.parts || [];
    const imgPart = outParts.find(p => p.inlineData);

    if (!imgPart) {
        // ── 실패 원인 진단용 상세 로그 ──────────────────────────
        // "이미지가 없다"는 결과만 보고는 원인(세이프티 필터/allowlist 미승인/모델이
        // 텍스트로만 답함 등)을 알 수 없어서, 응답 원문을 최대한 그대로 콘솔에 남긴다.
        const candidate = data?.candidates?.[0];
        const finishReason = candidate?.finishReason || '(없음)';
        const safetyRatings = candidate?.safetyRatings || [];
        const blockedSafety = safetyRatings.filter(r => r.blocked || r.probability === 'HIGH' || r.probability === 'MEDIUM');
        const textParts = outParts.filter(p => p.text).map(p => p.text).join(' / ');
        const promptFeedback = data?.promptFeedback || null;

        console.error('[Polaroid] ❌ 이미지 생성 실패 — 상세 진단:', {
            finishReason,
            blockedSafetyCategories: blockedSafety.map(r => `${r.category}:${r.probability}`),
            모델이_텍스트로만_답함: textParts || '(텍스트 응답 없음)',
            promptFeedback,
            candidatesCount: data?.candidates?.length ?? 0,
            원본응답: JSON.stringify(data)?.slice(0, 2000),
        });

        // 사용자에게 보여줄 에러 메시지도 원인별로 구체화
        // promptFeedback.blockReason이 있으면 이게 제일 정확한 원인이라 최우선으로 확인
        let hint = '이미지 생성 결과가 없습니다.';
        if (promptFeedback?.blockReason) {
            const reasonMap = {
                PROHIBITED_CONTENT: '금지된 콘텐츠로 판단되어 프롬프트 자체가 차단됨 (세이프티 하드 블록 — threshold 설정으로 우회 불가)',
                SAFETY: '세이프티 필터에 걸림',
                OTHER: '기타 사유로 차단됨',
                BLOCKLIST: '금칙어 목록에 걸림',
            };
            const readable = reasonMap[promptFeedback.blockReason] || promptFeedback.blockReason;
            hint += ` (${readable}${promptFeedback.blockReasonMessage ? ` — ${promptFeedback.blockReasonMessage}` : ''})`;
        } else if (finishReason === 'SAFETY' || blockedSafety.length) {
            hint += ' (세이프티 필터에 걸린 것으로 보입니다 — 콘솔 로그의 blockedSafetyCategories 확인)';
        } else if (textParts) {
            hint += ` (모델이 이미지 대신 텍스트로만 응답함: "${textParts.slice(0, 150)}")`;
        } else if (finishReason === '(없음)' || !data?.candidates?.length) {
            hint += ' (응답 자체가 비정상 — 모델명/리전 또는 API 접근 권한(allowlist) 문제일 수 있음)';
        } else {
            hint += ` (finishReason: ${finishReason})`;
        }
        throw new Error(hint);
    }

    return imgPart.inlineData;
}

// ── 이미지 가져오기 helpers ────────────────────────────────
async function fetchImageAsBase64(url, fallbackUrl) {
    try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`image fetch ${res.status}`);
        const blob = await res.blob();
        return await blobToBase64(blob);
    } catch (err) {
        if (fallbackUrl) {
            console.warn('[Polaroid] 원본 화질 아바타 로드 실패, 썸네일로 폴백:', url, err);
            const res2 = await fetch(fallbackUrl);
            if (!res2.ok) throw new Error(`fallback image fetch ${res2.status}`);
            const blob2 = await res2.blob();
            return await blobToBase64(blob2);
        }
        throw err;
    }
}

function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result.split(',')[1]);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}

async function getCharacterInfo() {
    const ctx = getContext();
    const info = {
        name: '', description: '', personality: '',
        avatarBase64: null,
        personaName: '', personaDescription: '',
        personaAvatarBase64: null,
    };

    if (ctx.characters && ctx.characterId !== undefined) {
        const ch = ctx.characters[ctx.characterId];
        if (ch) {
            info.name = ch.name || '';
            info.description = ch.description || '';
            info.personality = ch.personality || '';
            if (ch.avatar && ch.avatar !== 'none') {
                try {
                    info.avatarBase64 = await fetchImageAsBase64(
                        `/characters/${encodeURIComponent(ch.avatar)}`,
                        `/thumbnail?type=avatar&file=${encodeURIComponent(ch.avatar)}`
                    );
                } catch (_) {}
            }
        }
    }

    // 페르소나 우선순위 (ST persona 잠금 시스템 구조에 따름):
    // 1. 캐릭터 고정(Character Lock) — power_user.persona_descriptions[avatarId].connections 에
    //    {type:'character', id: 현재캐릭터아바타} 가 들어있는 persona. "이 캐릭터엔 항상 이 페르소나" 라는 의도가
    //    가장 명확하게 드러나는 곳이라 최우선.
    // 2. 채팅 고정(Chat Lock) — chat_metadata.persona. persona_auto_lock 켜져있으면 수동 전환 시
    //    조용히 여기에 재기록되므로 캐릭터 고정보다 후순위로 둠 (의도치 않은 덮어쓰기 방지).
    // 3. DOM에서 현재 선택된 페르소나 / pus.default_persona
    // 4. ctx.name1 (ST가 {{user}} 치환에 실제로 쓰는 값) — 위에서 아무것도 못 찾았을 때 마지막 보험
    try {
        const pus = ctx.powerUserSettings || {};
        const personas = pus.personas || {};
        const personaDescriptions = pus.persona_descriptions || {};

        const currentCharAvatar = (ctx.characters && ctx.characterId !== undefined)
            ? ctx.characters[ctx.characterId]?.avatar
            : '';

        // 1) 캐릭터 고정: connections 배열에서 현재 캐릭터와 매칭되는 persona 키 찾기
        let lockedAvatarKey = '';
        if (currentCharAvatar) {
            for (const [avatarId, desc] of Object.entries(personaDescriptions)) {
                const conns = desc?.connections || [];
                if (conns.some(c => c?.type === 'character' && c.id === currentCharAvatar)) {
                    lockedAvatarKey = avatarId;
                    break;
                }
            }
        }

        let activeKey = '';
        let p = null;

        if (lockedAvatarKey) {
            activeKey = lockedAvatarKey;
            p = personas[activeKey];
        }

        // 2) 채팅 고정 (chat_metadata.persona)
        if (!p) {
            const chatLockedKey = ctx.chatMetadata?.persona;
            if (chatLockedKey && personas[chatLockedKey]) {
                activeKey = chatLockedKey;
                p = personas[activeKey];
            }
        }

        // 3) DOM: 현재 선택된 persona 항목
        if (!p) {
            const personaSelectEl = document.querySelector('#persona_select');
            if (personaSelectEl?.value) {
                activeKey = personaSelectEl.value;
                p = personas[activeKey];
            }
        }
        if (!p) {
            const selectedEl = document.querySelector('.persona_select_item.selected, [data-persona].selected');
            if (selectedEl) {
                activeKey = selectedEl.dataset?.persona || selectedEl.value || '';
                p = personas[activeKey];
            }
        }
        if (!p && pus.default_persona) {
            activeKey = pus.default_persona;
            p = personas[activeKey];
        }

        // persona_description에서 이름 파싱 (혜담은 같은 경우)
        let personaNameFromDesc = '';
        if (pus.persona_description) {
            const nameMatch = pus.persona_description.match(/이름[^\n]*?([가-힣a-zA-Z]+)/);
            if (nameMatch) personaNameFromDesc = nameMatch[1].trim();
        }

        const name1 = ctx.name1 || '';

        console.log('[Polaroid] 페르소나 디버그:', {
            currentCharAvatar,
            lockedAvatarKey,
            chat_persona_lock: ctx.chatMetadata?.persona,
            activeKey,
            'personas[activeKey]': p,
            name1,
        });

        if (p) {
            // power_user.personas[key]는 ST 기본 구조상 이름 문자열이지만,
            // 혹시 모를 포크/구버전 대응으로 객체 형태도 같이 처리
            const isStringPersona = typeof p === 'string';
            const pName = isStringPersona ? p : p.name;
            const descObj = personaDescriptions[activeKey];
            const pDesc = descObj?.description || (isStringPersona ? '' : p.description);
            const pAvatar = isStringPersona ? '' : (p.avatar || p.filename);

            // 캐릭터 고정으로 찾은 거면 그 이름이 절대 우선 (name1보다도 위)
            info.personaName = (lockedAvatarKey ? pName : (name1 || pName))
                || personaNameFromDesc || activeKey || '';
            info.personaDescription = pDesc || pus.persona_description || '';
            // 키 자체가 파일명 (예: '1782536480473-Adalovelace.png')
            const avatarFile = pAvatar || activeKey || '';
            if (avatarFile && avatarFile !== 'none') {
                try {
                    info.personaAvatarBase64 = await fetchImageAsBase64(
                        `/User Avatars/${encodeURIComponent(avatarFile)}`,
                        `/thumbnail?type=persona&file=${encodeURIComponent(avatarFile)}`
                    );
                } catch (_) {}
            }
        } else {
            // 페르소나 객체 못 찾아도 이름은 name1 → description파싱 → activeKey(파일명보단 낫음) → name2 순으로
            info.personaName = name1 || personaNameFromDesc || activeKey || pus.name2 || '';
            info.personaDescription = pus.persona_description || '';
            // user-default.png가 activeKey면 아바타 시도
            if (!activeKey) activeKey = 'user-default.png';
            try {
                info.personaAvatarBase64 = await fetchImageAsBase64(
                    `/User Avatars/${encodeURIComponent(activeKey)}`,
                    `/thumbnail?type=persona&file=${encodeURIComponent(activeKey)}`
                );
            } catch (_) {}
        }
    } catch(e) {
        console.warn('[Polaroid] 페르소나 읽기 실패:', e);
    }

    console.log('[Polaroid] charInfo:', {
        char: info.name,
        persona: info.personaName,
        hasCharAvatar: !!info.avatarBase64,
        hasPersonaAvatar: !!info.personaAvatarBase64,
    });
    return info;
}

// ── 갤러리 저장/불러오기 (ST 서버 저장 — 기기 간 동기화) ──────
// ST의 /api/userdata 엔드포인트 사용 (확장에서 접근 가능한 공식 경로).
// 인덱스 파일(user/polaroid/index.json)에 id 목록을 관리하고,
// 각 사진은 user/polaroid/photos/{id}.json 으로 저장.
// → 컴·폰 모두 같은 ST 서버를 바라보므로 갤러리가 자동으로 동기화됨.

const GALLERY_PREFIX = 'polaroid_v1_'; // 구버전 localStorage 마이그레이션용
// ── 갤러리 저장소: extension_settings 사용 ──────────────────────
// 예전엔 /api/userdata 라는, 실제로는 존재하지 않는 엔드포인트를 불렀었음 (항상 실패
// → 매번 IndexedDB로 폴백). extension_settings + saveSettingsDebounced()는 이 확장의
// API 키/스타일 설정을 저장할 때 이미 검증된, ST 코어가 보장하는 진짜 저장 경로라서
// 이걸로 통일함. settings.json에 이미지까지 통째로 들어가 용량이 커지고 ST 로딩이
// 느려질 수 있다는 점을 사용자가 인지하고 감수하기로 함(요청에 따름).
function getGalleryStore() {
    if (!extension_settings[EXT]) extension_settings[EXT] = {};
    if (!extension_settings[EXT].gallery) extension_settings[EXT].gallery = {};
    return extension_settings[EXT].gallery; // { [캐릭터명]: [ {id, image, timestamp, snippet, prompt}, ... ] }
}

// ── IndexedDB 폴백 ────────────────────────────────────────
const DB_NAME = 'PolaroidGallery';
const DB_VERSION = 2;
const STORE_NAME = 'photos';
let _dbPromise = null;
function openDB() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
                store.createIndex('character', 'character', { unique: false });
            }
        };
        req.onsuccess = () => {
            const db = req.result;
            // ── 스토어가 여전히 없는 비정상 상태여도 절대 DB를 삭제하지 않는다 ──────
            // (예전에 자동 삭제 로직이 있었는데, 오작동 시 저장된 사진을 통째로
            //  날려버리는 파괴적인 동작이라 위험했음. 사용자 데이터를 다루는 코드는
            //  실패해도 조용히 실패하거나 사용자에게 알리기만 해야지, 임의로 지우면 안 됨)
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                console.error('[Polaroid] ⚠️ IndexedDB에 photos 스토어가 없습니다. DB_VERSION을 올렸는데도 없다면 브라우저 저장공간 문제일 수 있습니다. (데이터 보호를 위해 자동 삭제하지 않음)');
                reject(new Error('갤러리 저장소(photos 스토어)를 찾을 수 없습니다. 기존 사진 데이터 보호를 위해 자동으로 삭제하지 않았습니다 — 문의 바랍니다.'));
                return;
            }
            resolve(db);
        };
        req.onerror = () => reject(req.error);
    });
    return _dbPromise;
}

async function saveToGallery(charName, base64Image, meta) {
    const gallery = getGalleryStore();
    if (!gallery[charName]) gallery[charName] = [];
    const id = Date.now() + '_' + Math.floor(Math.random() * 1e6);
    gallery[charName].unshift({ id, character: charName, image: base64Image, ...meta });
    saveSettingsDebounced();
    console.log('[Polaroid] extension_settings 저장 완료:', id);
}

async function loadGallery(charName) {
    const gallery = getGalleryStore();
    return (gallery[charName] || []).slice(); // 원본 배열 변형 방지용 복사본
}

// ── 갤러리 백업(다운로드) ────────────────────────────────────
// 서버/IndexedDB 어느 쪽이든, 실수로 데이터가 날아가는 사고에 대비해 사용자가
// 직접 폰 다운로드 폴더에 원본 사진을 백업해둘 수 있게 하는 기능.
async function exportGalleryPhotos(charName) {
    if (!charName) { toastr.warning('📷 먼저 캐릭터를 선택하세요'); return; }
    try {
        const items = await loadGallery(charName);
        if (!items.length) { toastr.info('📷 백업할 사진이 없습니다'); return; }

        toastr.info(`📷 ${items.length}장 다운로드 중...`);
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            const ts = item.timestamp ? new Date(item.timestamp).toISOString().replace(/[:.]/g, '-') : `${i}`;
            const a = document.createElement('a');
            a.href = item.image; // 이미 "data:image/jpeg;base64,..." 형태로 저장돼있음
            a.download = `polaroid_${charName}_${ts}.jpg`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            // 브라우저가 연속 다운로드를 팝업 차단으로 씹지 않도록 살짝 간격을 둠
            await new Promise(r => setTimeout(r, 300));
        }
        toastr.success(`📷 ${items.length}장 다운로드 완료`);
    } catch (e) {
        console.error('[Polaroid] 백업 실패:', e);
        toastr.error(`📷 백업 실패: ${e.message}`);
    }
}

async function deleteFromGallery(charName, id) {
    const gallery = getGalleryStore();
    if (!gallery[charName]) return;
    gallery[charName] = gallery[charName].filter(e => e.id !== id);
    saveSettingsDebounced();
}

async function allGalleryChars() {
    const gallery = getGalleryStore();
    return Object.entries(gallery)
        .filter(([, items]) => items && items.length)
        .map(([name, items]) => ({ name, count: items.length }));
}

// IndexedDB / localStorage → 서버로 1회 마이그레이션
async function migrateLocalStorageGallery() {
    // ① 구버전 localStorage (polaroid_v1_*) 마이그레이션
    try {
        const keys = [];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k?.startsWith(GALLERY_PREFIX)) keys.push(k);
        }
        if (keys.length) {
            for (const key of keys) {
                let arr = [];
                try { arr = JSON.parse(localStorage.getItem(key) || '[]'); } catch (_) {}
                for (const item of arr) {
                    if (!item?.image || !item?.character) continue;
                    await saveToGallery(item.character, item.image, {
                        timestamp: item.timestamp || new Date().toISOString(),
                        snippet: item.snippet || '',
                        prompt: item.prompt || '',
                    });
                }
                localStorage.removeItem(key);
            }
            console.log(`[Polaroid] localStorage → 서버 마이그레이션 완료 (${keys.length}개 키)`);
        }
    } catch (e) {
        console.warn('[Polaroid] localStorage 마이그레이션 실패:', e);
    }

    // ② IndexedDB (PolaroidGallery) 마이그레이션
    try {
        const gallery = getGalleryStore();
        const hasExisting = Object.values(gallery).some(items => items && items.length > 0);
        if (hasExisting) return; // 이미 새 저장소에 데이터 있음 (중복 마이그레이션 방지)

        const dbReq = indexedDB.open('PolaroidGallery', 1);
        await new Promise((resolve) => {
            dbReq.onsuccess = async () => {
                try {
                    const db = dbReq.result;
                    if (!db.objectStoreNames.contains('photos')) { resolve(); return; }
                    const tx = db.transaction('photos', 'readonly');
                    const req = tx.objectStore('photos').getAll();
                    req.onsuccess = async () => {
                        const all = req.result || [];
                        if (!all.length) { resolve(); return; }
                        for (const item of all) {
                            if (!item?.image || !item?.character) continue;
                            await saveToGallery(item.character, item.image, {
                                timestamp: item.timestamp || new Date().toISOString(),
                                snippet: item.snippet || '',
                                prompt: item.prompt || '',
                            });
                        }
                        console.log(`[Polaroid] IndexedDB → 서버 마이그레이션 완료 (${all.length}장)`);
                        resolve();
                    };
                    req.onerror = () => resolve();
                } catch (err) { resolve(); }
            };
            dbReq.onerror = () => resolve();
            dbReq.onblocked = () => resolve();
        });
    } catch (e) {
        console.warn('[Polaroid] IndexedDB 마이그레이션 실패:', e);
    }
}

// ── 생성 전 "한 줄 지시" 팝업 ─────────────────────────────
// 취소하면 null, 확인하면 문자열(빈 문자열 포함) 반환
function showDirectionPopup() {
    return new Promise((resolve) => {
        if (document.getElementById('pol-direction-popup')) {
            unlockBodyScroll();
            document.getElementById('pol-direction-popup')?.remove();
        }

        const overlay = document.createElement('div');
        overlay.id = 'pol-direction-popup';
        overlay.className = 'pol-dir-overlay';
        overlay.innerHTML = `
            <div class="pol-dir-box">
                <div class="pol-dir-title"><i class="fa-solid fa-camera"></i> 📷 Polaroid 생성</div>
                <div class="pol-dir-desc">원하는 자세나 장면을 한 줄로 지시해주세요.<br><span class="pol-dir-sub">비워두면 채팅 내용만으로 자동 생성합니다.</span></div>
                <input id="pol-dir-input" class="pol-dir-input" type="text" placeholder="예: 창문 앞에서 뒤돌아보는 모습, 환하게 웃으며 손 흔드는 장면…" maxlength="200" />
                <div class="pol-dir-btns">
                    <button id="pol-dir-cancel" class="pol-dir-btn pol-dir-btn-cancel">취소</button>
                    <button id="pol-dir-ok" class="pol-dir-btn pol-dir-btn-ok"><i class="fa-solid fa-camera"></i> 생성</button>
                </div>
            </div>`;

        document.body.appendChild(overlay);
        lockBodyScroll();

        const input = overlay.querySelector('#pol-dir-input');
        const btnOk = overlay.querySelector('#pol-dir-ok');
        const btnCancel = overlay.querySelector('#pol-dir-cancel');

        // 포커스 (모바일에서 키보드 올라오도록)
        setTimeout(() => { try { input.focus(); } catch(_) {} }, 80);

        const confirm = () => {
            const val = input.value.trim();
            unlockBodyScroll();
            overlay.remove();
            resolve(val);
        };
        const cancel = () => {
            unlockBodyScroll();
            overlay.remove();
            resolve(null);
        };

        bindTap(btnOk, confirm);
        bindTap(btnCancel, cancel);
        input.addEventListener('keydown', e => {
            if (e.key === 'Enter') confirm();
            if (e.key === 'Escape') cancel();
        });
        bindTap(overlay, e => { if (e.target === overlay) cancel(); });
    });
}

// ── 핵심: 버튼 클릭 → 이미지 생성 ────────────────────────
async function runGenerate(messageText, btn, mesEl) {
    // 생성 전 방향 지시 팝업
    const userDirection = await showDirectionPopup();
    if (userDirection === null) return; // 취소

    btn.disabled = true;
    const orig = btn.innerHTML;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';

    try {
        toastr.info('📷 캐릭터 정보 수집 중...', '', { timeOut: 2000 });
        const charInfo = await getCharacterInfo();

        // 직전 대화 맥락 수집 (버튼 메시지 포함 최대 6턴)
        const chatContext = mesEl ? getRecentChatContext(mesEl, 6) : messageText;

        toastr.info('📷 장면 분석 중...', '', { timeOut: 3000 });
        const imgPrompt = await generatePrompt(messageText, charInfo, userDirection, chatContext);
        if (!imgPrompt) throw new Error('프롬프트 생성 실패');
        console.log('[Polaroid] prompt:', imgPrompt);

        toastr.info('📷 이미지 생성 중...', '', { timeOut: 8000 });
        const imgData = await generateImage(imgPrompt, charInfo);

        const base64Full = `data:${imgData.mimeType};base64,${imgData.data}`;
        const charName = charInfo.name || 'unknown';

        await saveToGallery(charName, base64Full, {
            character: charName,
            timestamp: new Date().toISOString(),
            snippet: messageText.slice(0, 120),
            prompt: imgPrompt,
        });

        showPolaroid(btn, base64Full, charName, imgPrompt);
        toastr.success('📷 Polaroid 생성 완료!');

    } catch (err) {
        console.error('[Polaroid]', err);
        toastr.error(`📷 Polaroid: ${err.message}`);
    } finally {
        btn.disabled = false;
        btn.innerHTML = orig;
    }
}

// ── 인라인 폴라로이드 표시 ────────────────────────────────
function showPolaroid(btn, src, charName, prompt) {
    const mes = btn.closest('.mes');
    if (!mes) return;
    mes.querySelector('.polaroid-wrap')?.remove();

    const wrap = document.createElement('div');
    wrap.className = 'polaroid-wrap';
    wrap.innerHTML = `
        <div class="pol-frame">
            <img src="${src}" class="pol-img" />
            <div class="pol-name">${charName}</div>
            <div class="pol-actions">
                <button class="pol-btn pol-dl" title="저장"><i class="fa-solid fa-download"></i></button>
                <button class="pol-btn pol-close" title="닫기"><i class="fa-solid fa-xmark"></i></button>
            </div>
            <div class="pol-hint">${prompt.slice(0, 70)}…</div>
        </div>`;

    wrap.querySelector('.pol-dl').onclick = () => {
        const a = document.createElement('a');
        a.href = src;
        a.download = `polaroid_${charName}_${Date.now()}.png`;
        a.click();
    };
    wrap.querySelector('.pol-close').onclick = () => wrap.remove();

    // mes_text 다음 또는 mes 블록 끝에 붙임 (ST 1.18 호환)
    const mesBlock = mes.querySelector('.mes_block') || mes.querySelector('.mes_text')?.parentElement || mes;
    mesBlock.appendChild(wrap);
}

// ── 모바일에서 전체화면 오버레이(갤러리/풀뷰어/지시 팝업) 열려있는 동안
//    배경 스크롤 잠그기 ────────────────────────────────────
// 모바일 브라우저(특히 iOS Safari)는 채팅창을 스크롤해둔 상태에서
// position:fixed 오버레이를 새로 붙이면, 오버레이가 뷰포트 정중앙이 아니라
// "스크롤되기 전 문서 좌표" 기준으로 붙어버려서 화면 위쪽으로 쏠려 보이는 경우가 있음.
// 오버레이를 여는 동안 body 자체를 fixed로 고정해두면 이 문제가 사라짐.
// (카운터를 쓰는 이유: 오버레이가 겹쳐 열릴 가능성에 대비해 중첩 lock/unlock 허용)
let _scrollLockY = 0;
let _scrollLockCount = 0;
function lockBodyScroll() {
    if (_scrollLockCount === 0) {
        _scrollLockY = window.scrollY || window.pageYOffset || 0;
        document.body.style.position = 'fixed';
        document.body.style.top = `-${_scrollLockY}px`;
        document.body.style.left = '0';
        document.body.style.right = '0';
        document.body.style.width = '100%';
    }
    _scrollLockCount++;
}
function unlockBodyScroll() {
    _scrollLockCount = Math.max(0, _scrollLockCount - 1);
    if (_scrollLockCount === 0) {
        document.body.style.position = '';
        document.body.style.top = '';
        document.body.style.left = '';
        document.body.style.right = '';
        document.body.style.width = '';
        window.scrollTo(0, _scrollLockY);
    }
}

// ── 갤러리 모달 (macOS 스타일) ────────────────────────────
// 모바일(삼성인터넷 등)에서 동적으로 생성된 요소에 click만 걸어두면
// 터치가 씹히는 경우가 있어서, PointerEvent를 우선 쓰고 없으면 touchend+click을 같이 건다.
// (touchend에서 preventDefault → 뒤따라오는 합성 click이 취소되므로 중복 실행 안 됨)
function bindTap(el, handler) {
    if (!el) return;
    if (window.PointerEvent) {
        el.addEventListener('pointerup', handler);
    } else {
        el.addEventListener('click', handler);
        el.addEventListener('touchend', (e) => { e.preventDefault(); handler(e); }, { passive: false });
    }
}

function openGallery() {
    if (document.getElementById('pol-gallery-modal')) {
        unlockBodyScroll();
        document.getElementById('pol-gallery-modal')?.remove();
    }

    (async () => {
    try {
        const ctx = getContext();
        const curChar = ctx.characters?.[ctx.characterId]?.name || '';
        const chars = await allGalleryChars();

        const modal = document.createElement('div');
        modal.id = 'pol-gallery-modal';
        modal.className = 'pol-modal';
        modal.innerHTML = `
            <div class="pol-modal-box">
                <div class="pol-modal-head">
                    <div class="pol-modal-title">
                        <i class="fa-solid fa-camera"></i> Polaroid Album
                    </div>
                    <select id="pol-char-sel" class="pol-char-select">
                        <option value="">캐릭터 선택…</option>
                        ${chars.map(c => `<option value="${c.name}" ${c.name === curChar ? 'selected' : ''}>${c.name} (${c.count})</option>`).join('')}
                    </select>
                    <button id="pol-backup-btn" class="pol-modal-close-btn" title="현재 캐릭터 사진 전체 백업(다운로드)"><i class="fa-solid fa-download"></i></button>
                    <button id="pol-modal-close" class="pol-modal-close-btn" title="닫기"><i class="fa-solid fa-xmark"></i></button>
                </div>
                <div id="pol-grid" class="pol-grid"><div class="pol-empty">📷 캐릭터를 선택하세요</div></div>
            </div>`;

        document.body.appendChild(modal);
        lockBodyScroll();
        const closeModal = () => { unlockBodyScroll(); modal.remove(); };
        bindTap(modal, e => { if (e.target === modal) closeModal(); });
        bindTap(modal.querySelector('#pol-modal-close'), closeModal);

        const sel = modal.querySelector('#pol-char-sel');
        sel.onchange = () => renderGrid(modal.querySelector('#pol-grid'), sel.value);

        bindTap(modal.querySelector('#pol-backup-btn'), () => exportGalleryPhotos(sel.value));

        // 현재 캐릭터가 갤러리에 있으면 바로 표시, 없으면 select 첫 항목으로
        if (curChar && chars.find(c => c.name === curChar)) {
            sel.value = curChar;
            renderGrid(modal.querySelector('#pol-grid'), curChar);
        } else if (chars.length > 0) {
            sel.value = chars[0].name;
            renderGrid(modal.querySelector('#pol-grid'), chars[0].name);
        }
    } catch (e) {
        console.error('[Polaroid] 갤러리 열기 실패:', e);
        toastr.error(`📷 갤러리를 열 수 없습니다: ${e.message}`);
    }
    })();
}

async function renderGrid(gridEl, charName) {
    if (!charName) { gridEl.innerHTML = '<div class="pol-empty">📷 캐릭터를 선택하세요</div>'; return; }
    const items = await loadGallery(charName);
    if (!items.length) { gridEl.innerHTML = '<div class="pol-empty">아직 사진이 없어요 📷</div>'; return; }

    gridEl.innerHTML = '';
    items.forEach(item => {
        const card = document.createElement('div');
        card.className = 'pol-card';
        card.innerHTML = `
            <div class="pol-frame pol-frame-sm">
                <img src="${item.image}" class="pol-img pol-img-thumb" loading="lazy" />
                <div class="pol-name">${item.character}</div>
                <div class="pol-date">${new Date(item.timestamp).toLocaleDateString('ko-KR')}</div>
                <div class="pol-actions">
                    <button class="pol-btn pol-dl" title="다운로드"><i class="fa-solid fa-download"></i></button>
                    <button class="pol-btn pol-del" title="삭제"><i class="fa-solid fa-trash"></i></button>
                </div>
            </div>`;

        bindTap(card.querySelector('.pol-img-thumb'), () => openFull(item.image, item.character, item.timestamp));
        bindTap(card.querySelector('.pol-dl'), () => {
            const a = document.createElement('a');
            a.href = item.image;
            a.download = `polaroid_${item.character}_${item.id}.png`;
            a.click();
        });
        bindTap(card.querySelector('.pol-del'), async () => {
            if (confirm('이 사진을 삭제할까요?')) {
                await deleteFromGallery(charName, item.id);
                renderGrid(gridEl, charName);
            }
        });
        gridEl.appendChild(card);
    });
}

function openFull(src, name, timestamp) {
    if (document.getElementById('pol-full')) {
        unlockBodyScroll();
        document.getElementById('pol-full')?.remove();
    }
    const el = document.createElement('div');
    el.id = 'pol-full';
    el.className = 'pol-full';
    const dateStr = timestamp ? new Date(timestamp).toLocaleDateString('ko-KR') : '';
    el.innerHTML = `
        <div class="pol-full-inner">
            <img src="${src}" />
            <div class="pol-full-info">
                <strong>${name}</strong>
                <p>${dateStr}</p>
            </div>
            <button class="pol-full-close"><i class="fa-solid fa-xmark"></i></button>
        </div>`;
    const closeFull = () => { unlockBodyScroll(); el.remove(); };
    bindTap(el.querySelector('.pol-full-close'), closeFull);
    bindTap(el, e => { if (e.target === el) closeFull(); });
    document.body.appendChild(el);
    lockBodyScroll();
}

// ── 메시지 버튼 추가 ──────────────────────────────────────
// .extraMesButtons 안에 넣되, 아직 없으면 .extraMesButtonsHint 앞(바깥)에 폴백 삽입.
// 모바일에서 .extraMesButtons가 pointer-events:none이거나 touch를 흡수하는 부모가 있어
// click이 씹히는 문제를 pointerup + touchend 이중 위임으로 해결.
function addBtn(mesEl) {
    if (mesEl.getAttribute('is_user') === 'true' || mesEl.classList.contains('is_user')) return;
    if (mesEl.querySelector('.pol-msg-btn')) return;

    const btn = document.createElement('div');
    btn.className = 'pol-msg-btn mes_button';
    btn.setAttribute('title', '📷 Polaroid');
    btn.innerHTML = '<i class="fa-solid fa-camera"></i>';
    // 터치 환경에서 부모가 포인터 이벤트를 먹는 경우 대비: touch-action 명시
    btn.style.cssText += 'touch-action:manipulation;cursor:pointer;';

    // ① .extraMesButtons 안에 삽입 (Edit 버튼과 나란히)
    const extraBtns = mesEl.querySelector('.extraMesButtons');
    if (extraBtns) {
        extraBtns.appendChild(btn);
        return;
    }

    // ② 폴백: .extraMesButtonsHint 앞
    const hint = mesEl.querySelector('.extraMesButtonsHint');
    if (hint) {
        hint.insertAdjacentElement('beforebegin', btn);
        return;
    }

    // ③ 폴백2: mes_buttons 블록 끝
    const mesButtons = mesEl.querySelector('.mes_buttons');
    if (mesButtons) mesButtons.appendChild(btn);
}

// 버튼별로 잠금 (예전엔 잠금 변수가 전역 하나뿐이라, A 메시지 버튼을 누른 직후
// 0.6초 안에 B 메시지 버튼을 눌러도 그냥 씹혀버리는 문제가 있었음)
const _tapLocks = new WeakSet();
async function handlePolMsgBtnTap(e) {
    const btn = e.currentTarget || e.target?.closest?.('.pol-msg-btn');
    if (!btn) return;

    // pointerup + touchend + click이 같은 탭 하나에 대해 중복 실행되는 것만 막기 위한 잠금
    if (_tapLocks.has(btn)) { e.preventDefault(); e.stopPropagation(); return; }
    _tapLocks.add(btn);
    setTimeout(() => _tapLocks.delete(btn), 600);

    e.stopImmediatePropagation();
    e.stopPropagation();
    e.preventDefault();

    const mesEl = btn.closest('.mes');
    if (!mesEl) return;
    const text = mesEl.querySelector('.mes_text')?.innerText?.trim() || '';
    await runGenerate(text, btn, mesEl);
}

// pointerup: 모던 브라우저 / 삼성인터넷 등 PointerEvent 지원 환경
$(document).on('pointerup', '.pol-msg-btn', handlePolMsgBtnTap);
// touchend: PointerEvent 없는 구형 환경 + iOS Safari 특정 버전 대비
$(document).on('touchend', '.pol-msg-btn', handlePolMsgBtnTap);
// click: 데스크톱 폴백
$(document).on('click', '.pol-msg-btn', handlePolMsgBtnTap);

function addBtnsAll() {
    document.querySelectorAll('.mes').forEach(addBtn);
}

// ── 설정 패널 ─────────────────────────────────────────────
async function setupSettings() {
    const c = cfg();
    const isDirect = c.api_mode !== 'profile';

    const imgModelOpts = IMAGE_MODELS.map(m =>
        `<option value="${m.value}" ${c.image_model === m.value ? 'selected' : ''}>${m.label}</option>`
    ).join('');

    const txtModelOpts = PROMPT_MODELS.map(m =>
        `<option value="${m.value}" ${c.prompt_model === m.value ? 'selected' : ''}>${m.label}</option>`
    ).join('');

    const html = `
        <div id="pol-settings-panel" class="extension_block">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>📷 Polaroid</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <div class="pol-settings">

                        <label>API 연결 방식</label>
                        <select id="pol-api-mode" class="text_pole">
                            <option value="profile" ${!isDirect ? 'selected' : ''}>ST 연결 프로필 사용</option>
                            <option value="direct"  ${isDirect  ? 'selected' : ''}>직접 API 키 입력</option>
                        </select>

                        <div id="pol-profile-info" style="display:${isDirect ? 'none' : 'block'};margin-top:4px;">
                            <label style="margin-top:6px;">연결 프로필</label>
                            <select id="pol-profile-select" class="text_pole">
                                <option value="">-- 프로필 선택 --</option>
                            </select>
                            <small id="pol-profile-model-info" style="color:#aaa;font-size:11px;margin-top:3px;display:block;">
                                프로필을 선택하면 모델이 자동으로 설정됩니다.
                            </small>

                            <small style="color:#8fae8f;font-size:11px;margin-top:4px;display:block;line-height:1.5;">
                                ✓ polaroid-proxy 서버 플러그인이 설치되어 있으면, SillyTavern의
                                API 연결 설정에 이미 등록해둔 키로 이미지 생성까지 자동 처리됩니다.
                                키 종류(Google AI Studio / Vertex)도 서버가 알아서 판별하니 따로
                                고르실 필요 없어요. (서버 플러그인 미설치 시 아래 "직접 API 키 입력" 모드를 쓰세요.)
                            </small>
                        </div>

                        <div id="pol-direct-fields" style="display:${isDirect ? 'flex' : 'none'};flex-direction:column;gap:7px;margin-top:4px;">
                            <label>API Key</label>
                            <input type="password" id="pol-direct-key" class="text_pole" placeholder="Vertex AI Express API Key" value="${c.direct_api_key || ''}" />
                            <label>Project ID</label>
                            <input type="text" id="pol-direct-project" class="text_pole" value="${c.direct_project_id || ''}" placeholder="your-project-id" />
                            <label>Region</label>
                            <input type="text" id="pol-direct-region" class="text_pole" value="${c.direct_region || 'global'}" placeholder="global 또는 us-central1" />
                        </div>

                        <label style="margin-top:6px;">이미지 생성 모델</label>
                        <select id="pol-img-model" class="text_pole">${imgModelOpts}</select>

                        <label>이미지 스타일</label>
                        <input type="text" id="pol-style" class="text_pole" value="${c.image_style}" />
                        <label>네거티브 프롬프트</label>
                        <input type="text" id="pol-neg" class="text_pole" value="${c.negative_prompt}" />

                        <div style="display:flex;gap:8px;margin-top:8px;">
                            <button id="pol-save-btn" class="menu_button menu_button_active">
                                <i class="fa-solid fa-floppy-disk"></i> 저장
                            </button>
                            <button id="pol-gallery-open-btn" class="menu_button">
                                <i class="fa-solid fa-images"></i> 갤러리 열기
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </div>`;

    // ST 버전별 설정 패널 ID 대응
    const $settingsContainer = $('#extensions_settings2').length
        ? $('#extensions_settings2')
        : $('#extensions_settings');
    $settingsContainer.append(html);

    // 프로필 드롭다운 채우기
    try {
        const svc = SillyTavern.getContext().ConnectionManagerRequestService;
        const profiles = svc.getSupportedProfiles();
        const $sel = $('#pol-profile-select');
        profiles.forEach(p => {
            const selected = p.id === c.profile_id ? 'selected' : '';
            $sel.append(`<option value="${p.id}" ${selected}>${p.name} (${p.model})</option>`);
        });
        const cur = profiles.find(p => p.id === c.profile_id);
        if (cur) $('#pol-profile-model-info').text('모델: ' + cur.model);
        $sel.on('change', function() {
            const sel = profiles.find(p => p.id === $(this).val());
            if (sel) $('#pol-profile-model-info').text('모델: ' + sel.model);
        });
    } catch(e) {
        $('#pol-profile-model-info').text('프로필 목록을 불러올 수 없습니다.');
    }

    $('#pol-api-mode').on('change', function () {
        const v = $(this).val();
        $('#pol-profile-info').toggle(v === 'profile');
        $('#pol-direct-fields').toggle(v === 'direct');
    });

    $('#pol-save-btn').on('click', () => {
        const vals = {
            api_mode:          $('#pol-api-mode').val(),
            profile_id:        $('#pol-profile-select').val() || '',
            direct_api_key:    ($('#pol-direct-key').val() || '').trim(),
            direct_project_id: ($('#pol-direct-project').val() || '').trim(),
            direct_region:     ($('#pol-direct-region').val() || 'global').trim(),
            image_model:       $('#pol-img-model').val(),
            image_style:       ($('#pol-style').val() || '').trim(),
            negative_prompt:   ($('#pol-neg').val() || '').trim(),
        };
        // import된 extension_settings에 저장
        if (!extension_settings[EXT]) extension_settings[EXT] = {};
        Object.assign(extension_settings[EXT], vals);
        // getContext().extensionSettings에도 동기화
        const ctx = getContext();
        if (ctx.extensionSettings) {
            if (!ctx.extensionSettings[EXT]) ctx.extensionSettings[EXT] = {};
            Object.assign(ctx.extensionSettings[EXT], vals);
        }
        saveSettingsDebounced();
        toastr.success('Polaroid 설정 저장됨 ✓');
        console.log('[Polaroid] 설정 저장:', vals);
    });

    $('#pol-gallery-open-btn').on('click', openGallery);
}

// ── Wand 메뉴에 항목 주입 ─────────────────────────────────
function injectWandMenu() {
    // ST의 wand 메뉴 #extensionsMenu li 리스트 안에 추가
    // 메뉴가 열릴 때마다 재렌더되는 경우가 있으므로 MutationObserver 사용
    const injectItem = () => {
        const menu = document.getElementById('extensionsMenu');
        if (!menu) return false;
        if (menu.querySelector('#pol-wand-item')) return true;

        const li = document.createElement('div');
        li.id = 'pol-wand-item';
        li.classList.add('list-group-item', 'flex-container', 'flexGap5', 'interactable');
        li.tabIndex = 0;
        li.innerHTML = `<i class="fa-solid fa-camera"></i><span>Polaroid</span>`;
        bindTap(li, (e) => {
            e.stopPropagation();
            // 메뉴 닫기
            document.getElementById('extensionsMenu')?.classList.remove('open');
            openGallery();
        });

        // 메뉴 첫 항목 앞에 삽입
        const firstItem = menu.querySelector('li');
        if (firstItem) {
            menu.insertBefore(li, firstItem);
        } else {
            menu.appendChild(li);
        }
        return true;
    };

    // 최초 시도 (이 시점엔 #extensionsMenu가 아직 DOM에 없을 수 있음 — 그래도 일단 시도)
    injectItem();

    // ── 모바일 터치 안 되는 문제의 원인: #extensionsMenu/#extensionsMenuButton가
    //    init 시점에 DOM에 없으면 기존 코드는 옵저버/리스너 등록 자체를 건너뛰어서
    //    그 뒤로 영영 재시도할 방법이 없어짐 (느린 로딩 환경, 특히 모바일에서 잘 걸림)
    //    → document.body 전체를 감시해서 #extensionsMenu가 "나중에" 생기는 것도 잡아냄
    const bodyObserver = new MutationObserver(() => injectItem());
    bodyObserver.observe(document.body, { childList: true, subtree: true });

    // wand 버튼 클릭 시 메뉴가 열릴 때 재주입 (버튼이 init 시점에 없어도 동작하도록 document에 위임)
    document.addEventListener('click', (e) => {
        if (e.target?.closest?.('#extensionsMenuButton')) {
            setTimeout(injectItem, 50);
        }
    });

    // 안전망: 초기 로딩이 유난히 느린 경우 대비 10초간 폴링 후 정리
    let tries = 0;
    const pollId = setInterval(() => {
        tries++;
        if (injectItem() || tries > 20) clearInterval(pollId);
    }, 500);
}

// ── style.css를 fetch로 못 가져왔을 때만 쓰는 최소 안전장치 ─────
// (injectStyles()의 catch에서만 호출됨. 예전엔 <link> 태그가 실제로 로드됐는지를
//  매번 폴링해서 "로드 안 됨"으로 잘못 판정하고 이 폴백을 계속 겹쳐 주입하던 버그가
//  있었는데, 지금은 fetch 실패라는 확실한 신호가 있을 때만 호출됨)
function ensureFallbackStyles() {
    try {
        if (document.getElementById('pol-fallback-css')) return;
        const style = document.createElement('style');
        style.id = 'pol-fallback-css';
        style.textContent = `
.pol-modal{position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:2147483647;display:flex;align-items:center;justify-content:center;padding:20px;}
.pol-modal-box{background:#fafaf8;color:#2c2c2c;border-radius:16px;max-width:920px;width:100%;max-height:90vh;max-height:90dvh;display:flex;flex-direction:column;overflow:hidden;}
.pol-modal-head{display:flex;align-items:center;gap:10px;padding:14px 18px;background:#fff;border-bottom:1px solid #e8e5df;}
.pol-modal-close-btn{width:32px;height:32px;border-radius:50%;border:none;background:#f0ede7;color:#666;cursor:pointer;display:flex;align-items:center;justify-content:center;}
.pol-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:16px;padding:16px;overflow-y:auto;flex:1;}
.pol-full{position:fixed;inset:0;background:rgba(0,0,0,.78);z-index:2147483647;display:flex;align-items:center;justify-content:center;padding:20px;}
.polaroid-wrap{display:flex;justify-content:center;margin-top:14px;}
.pol-frame,.pol-frame-sm{background:#fff;color:#222;padding:10px 10px 36px;max-width:260px;width:100%;}
.pol-msg-btn{cursor:pointer;touch-action:manipulation;}
.pol-dir-overlay{position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:2147483647;display:flex;align-items:center;justify-content:center;padding:20px;}
.pol-dir-box{background:#fff;border-radius:16px;padding:24px;width:100%;max-width:420px;display:flex;flex-direction:column;gap:14px;}
`;
        document.head.appendChild(style);
    } catch (e) {
        console.error('[Polaroid] 폴백 스타일 체크 실패:', e);
    }
}
// ── 초기화 ────────────────────────────────────────────────
jQuery(async () => {
    await injectStyles();
    const ctx = getContext();
    if (ctx.extensionSettings) {
        if (!ctx.extensionSettings[EXT]) ctx.extensionSettings[EXT] = {};
        ctx.extensionSettings[EXT] = Object.assign({}, DEFAULTS, ctx.extensionSettings[EXT]);
    }
    // fallback: import된 extension_settings도 초기화
    if (!extension_settings[EXT]) extension_settings[EXT] = {};
    extension_settings[EXT] = Object.assign({}, DEFAULTS, extension_settings[EXT]);

    await migrateLocalStorageGallery();
    await setupSettings();
    injectWandMenu();

    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, mesId => {
        const el = document.querySelector(`.mes[mesid="${mesId}"]`);
        if (el) addBtn(el);
    });

    eventSource.on(event_types.CHAT_CHANGED, () => {
        setTimeout(addBtnsAll, 300);
    });

    addBtnsAll();
    console.log('[Polaroid] 📷 로드 완료');
});
