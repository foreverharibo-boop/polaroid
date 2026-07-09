# 📷 Polaroid — SillyTavern Extension

AI 응답 장면을 이미지로 생성하고 캐릭터별 폴라로이드 앨범에 저장하는 SillyTavern 확장입니다.

이 저장소에는 두 부분이 있습니다.

- **루트 (`index.js`, `style.css`, `manifest.json`)** — SillyTavern **확장**. `extensions` 폴더에 설치합니다.
- **`server-plugin/`** — 선택 사항인 SillyTavern **서버 플러그인**. "ST 연결 프로필 사용" 모드에서
  이미지 생성까지 프로필의 키로 자동 처리하려면 필요합니다. (없어도 "직접 API 키 입력" 모드로는
  확장이 정상 동작합니다.)

## 1. 확장 설치

SillyTavern의 확장 관리자에서:
1. `확장(Extensions)` → `설치(Install Extension)`
2. 이 저장소 URL을 붙여넣기: `https://github.com/<본인계정>/<저장소이름>`
3. 설치 후 ST 새로고침

또는 수동 설치:
```bash
cd SillyTavern/data/default-user/extensions
git clone https://github.com/<본인계정>/<저장소이름>.git polaroid
```

## 2. (선택) 서버 플러그인 설치 — 프로필 모드로 이미지까지 자동 생성하려면

```bash
cd SillyTavern/plugins
git clone https://github.com/<본인계정>/<저장소이름>.git polaroid-repo
cp -r polaroid-repo/server-plugin polaroid-proxy
rm -rf polaroid-repo
```

`SillyTavern/config.yaml`에서 `enableServerPlugins: true` 설정 후 ST 재시작.

자세한 설정/트러블슈팅은 [`server-plugin/README.md`](./server-plugin/README.md) 참고.

## 사용법

1. 확장 설정 패널에서 API 연결 방식 선택 (연결 프로필 / 직접 키 입력)
2. 캐릭터 메시지 아래 📷 버튼 클릭 → 장면을 사진으로 생성
3. 지팡이(wand) 메뉴 → Polaroid → 캐릭터별 갤러리 열람
