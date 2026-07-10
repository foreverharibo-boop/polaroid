# 📷 Polaroid — SillyTavern 확장

AI 응답 속 장면을 이미지로 생성하고, 캐릭터별 폴라로이드 앨범에 저장하는 SillyTavern 확장입니다.

---

## 설치 방법 (누구나, GitHub 계정 불필요)

1. SillyTavern 화면에서 퍼즐 아이콘 클릭
2. **Install Extension** 클릭
3. 아래 주소 붙여넣기:
   ```
   https://github.com/foreverharibo-boop/polaroid
   ```
4. 설치 완료 → SillyTavern 새로고침

---

## 첫 설정

설치 후 확장 설정 패널(퍼즐 아이콘 → Polaroid)을 열어주세요.

### 🟢 간단한 방법 (추천 — 서버 플러그인 불필요)

1. **API 연결 방식** → `직접 API 키 입력` 선택
2. **API Key** 칸에 Google AI Studio 키 입력
   - 키 발급: https://aistudio.google.com/apikey
3. **저장**

이걸로 끝이에요. 캐릭터 메시지 아래 📷 버튼을 눌러 이미지를 생성해보세요.

---

### 🔵 고급 방법 (ST에 이미 키를 등록해둔 사람용)

이미 SillyTavern 연결 프로필에 Gemini 키가 등록되어 있다면,
확장에 키를 따로 입력하지 않고 그 프로필을 그대로 사용할 수 있어요.
단, **서버 플러그인 별도 설치**가 필요합니다.

#### 서버 플러그인 설치

**PC (Windows/Mac/Linux)**
1. 이 저장소의 `server-plugin` 폴더 전체를 다운로드
2. SillyTavern 폴더 안 `plugins` 폴더에 `polaroid-proxy`라는 이름으로 복사
   → 결과: `SillyTavern/plugins/polaroid-proxy/index.js`
3. `SillyTavern/config.yaml` 에서 `enableServerPlugins: true` 확인
4. SillyTavern 서버 재시작

**Android (Termux)**
```bash
cd ~/SillyTavern/plugins
git clone https://github.com/foreverharibo-boop/polaroid.git polaroid-repo
cp -r polaroid-repo/server-plugin ./polaroid-proxy
rm -rf polaroid-repo
```
`config.yaml`에 `enableServerPlugins: true` 추가 후 서버 재시작.

#### 프로필 모드 설정

1. **API 연결 방식** → `ST 연결 프로필 사용` 선택
2. **연결 프로필** → 사용할 Gemini 프로필 선택
3. **저장**

---

## 업데이트 방법

ST 화면에서 퍼즐 아이콘 → **확장 업데이트(Update Extensions)** 클릭하면 자동으로 최신 버전이 적용됩니다.

> 서버 플러그인을 쓰고 있다면, 플러그인 파일도 직접 교체한 뒤 서버를 재시작해야 업데이트가 반영됩니다.

---

## 사용법

- **이미지 생성**: 캐릭터 메시지 아래 📷 버튼 클릭
- **갤러리**: 마법봉(Wand) 메뉴 → Polaroid → 캐릭터별 사진 모아보기
- **이미지 클릭**: 전체화면으로 감상

---

## 문제 해결

| 증상 | 해결 |
|---|---|
| 📷 버튼이 안 보임 | SillyTavern 강력 새로고침 (캐시 삭제 후 재접속) |
| 이미지 생성 실패 | 설정 패널에서 API 키 확인 |
| 서버 플러그인 404 | ST 서버 재시작 후 콘솔에서 `[polaroid-proxy] 플러그인 로드 완료` 확인 |
