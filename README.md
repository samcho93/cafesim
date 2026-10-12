# cafeSim: M400 무인카페 3D 하드웨어 시뮬레이터

커피머신(3 투출구, 터치스크린, 카드 단말기), 제빙기, 컵 디스펜서로 구성된 **M400 무인카페 스테이션**을
3D로 재현한 가상 하드웨어 플랫폼입니다. 실기와 **같은 시리얼 프로토콜**로 동작하기 때문에 다음이 가능합니다.

- 3D 화면에서 장비 동작을 직접 시뮬레이션: 결제 → 컵 배출 → 제빙 → 음료 추출 → 픽업
- 기존 키오스크 앱을 코드 수정 없이 가상 하드웨어에 연결
- 다른 시스템에서 장비 동작, 키오스크 UI, 결제를 직접 프로그래밍
- 이 플랫폼을 바탕으로 새 매장 구성(플랫폼) 만들기

**웹 데모:** https://samcho93.github.io/cafesim/ (설치 없이 브라우저에서 실행)

![M400 시뮬레이터](docs/screenshot.jpg)

| 터치스크린 키오스크 | 투출구 추출 |
|---|---|
| ![kiosk](docs/screenshot-kiosk.jpg) | ![outlet](docs/screenshot-outlet.jpg) |

---

## 빠른 시작

```bash
git clone https://github.com/samcho93/cafesim.git
cd cafesim
npm install
npm run dev          # 3D 시뮬레이터: http://localhost:5173
```

1. 터치스크린에서 메뉴를 고르고 **결제하기**를 누릅니다.
2. 커피머신의 **카드 단말기를 클릭**해 카드를 넣습니다.
3. 상단 안내를 따라 **컵 클릭 → 파란 원 클릭**으로 컵을 옮깁니다 (컵 디스펜서 → 제빙기 → 투출구 → 픽업대).
   - 상단 **자동 진행**을 켜면 고객 동작을 자동으로 수행하고, 안내창의 **대신 하기**는 한 단계만 수행합니다.
4. **내부 보기**를 켜면 그라인더, 브루 유닛(브로멕), 보일러, 펌프, 파우더 캐니스터가 동작하는 모습이 보입니다.

오른쪽 패널

| 탭 | 내용 |
|---|---|
| 상태 | 보일러 온도, 브로멕 위치, 동작 중인 명령, 구동부, 에러, 재고 |
| 제어 | 빠른 주문, 컵·카드 조작, 수동 액추에이터(펌프/밸브/그라인더), 재고 채우기, **장애 주입** |
| 레지스터 | 메인보드·컵 디스펜서 S/M 영역 실시간 덤프 (변경 시 강조) |
| 통신 | 호스트 ⇄ 장치 사이의 실제 바이트 프레임 로그 |
| 스크립트 | 브라우저에서 바로 실행하는 JS 콘솔 + 예제 7종 |
| 연동 | 외부 프로그램 연결 방법 |

---

## 구성

```mermaid
flowchart LR
  subgraph Hosts["호스트 프로그램 (무엇이든)"]
    K["원본 키오스크 앱<br/>(serialport-shim)"]
    P["내 프로그램<br/>Node SDK / Python / 다른 언어"]
    V["3D 뷰어 안의<br/>키오스크 UI · 스크립트"]
  end
  subgraph Sim["@cafesim/core 가상 하드웨어"]
    MB["메인보드<br/>S/M 레지스터"]
    ICE["제빙기"]
    CUP["컵 디스펜서"]
    PAY["KSCAT 단말기"]
    W["물리 월드<br/>컵 · 액체 · 안내"]
  end
  K -- "COM1/2/3 → TCP 7001-7003" --> MB & ICE & CUP
  K -- "HTTP :27098" --> PAY
  P -- "TCP / COM / REST" --> Sim
  V -- "in-browser 또는 WebSocket" --> Sim
  MB & ICE & CUP & PAY --> W
  W --> R["3D 뷰어 (Three.js)"]
```

| 패키지 | 역할 |
|---|---|
| [`packages/core`](packages/core) | 의존성 없는 시뮬레이션 엔진: 프로토콜 코덱, 가상 장치, 물리 월드, 고객 안내, **호스트 SDK**(`Machine`, `MainBoardClient` …). Node·브라우저 공용 |
| [`packages/server`](packages/server) | `cafesim` CLI: 장치별 TCP 포트, 가상/실제 COM 포트, KSCAT HTTP 에뮬레이터, REST, WebSocket, 빌드된 뷰어 제공 |
| [`packages/serialport-shim`](packages/serialport-shim) | `require('serialport')`를 가로채 COM 포트를 시뮬레이터 TCP로 연결 (기존 앱 무수정 연동) |
| [`packages/viewer`](packages/viewer) | Three.js 3D 뷰어, 운영 패널, 스크립트 콘솔, 기본 키오스크 UI, 키오스크 SDK |
| [`platforms/m400`](platforms/m400/platform.js) | M400 정의: 장치, 배관 라우팅, 제조 시퀀스, 메뉴, 3D 배치 |
| [`docs/`](docs) | [프로토콜](docs/PROTOCOL.md), [플랫폼 확장](docs/PLATFORM.md), [하드웨어 분석](docs/HARDWARE.md) |

---

## 사용 방법

### 1. 직접 시뮬레이션 (브라우저만)

`npm run dev`, 또는 위 웹 데모를 엽니다. 시뮬레이터 전체가 브라우저 안에서 돌아갑니다.

### 2. 소스를 고치면 시뮬레이션에 바로 반영

`npm run dev` 상태에서 아래 파일을 저장하면 뷰어가 즉시 다시 로드됩니다.

| 바꾸고 싶은 것 | 파일 |
|---|---|
| 메뉴, 레시피(cc·초), 제조 순서, 투출구 라우팅, 3D 배치 | `platforms/m400/platform.js` |
| 장비 동작 (유량, 가열 속도, 에러 조건 …) | `packages/core/src/devices/*.js` |
| 고객 안내 규칙 | `packages/core/src/world/Guide.js` |
| 3D 모델 | `packages/viewer/src/scene/models.js` |
| 키오스크 화면 | `packages/viewer/src/kiosk/*` |

서버 모드에서는 `npm run sim:watch`가 core/platform 변경 시 서버를 재시작합니다.
**스크립트** 탭에서는 저장 없이 코드를 바로 실행할 수 있습니다.

### 3. 가상 하드웨어로 설치해서 다른 시스템에서 프로그래밍

```bash
npm run build      # 뷰어 빌드 (서버가 함께 제공)
npm run sim        # http://localhost:8700  ← 3D 뷰어가 서버 상태를 미러링
```

```
[cafesim] viewer / REST / WebSocket : http://localhost:8700
[cafesim] device main  TCP 127.0.0.1:7001     ← 메인보드 (실기 COM1 38400)
[cafesim] device ice   TCP 127.0.0.1:7002     ← 제빙기   (실기 COM2 9600)
[cafesim] device cup   TCP 127.0.0.1:7003     ← 컵       (실기 COM3 9600)
[cafesim] KSCAT emulator http://127.0.0.1:27098
```

**a) 기존 키오스크 앱을 수정 없이 연결** (Windows)

```bat
set NODE_OPTIONS=--require D:\path\to\cafesim\packages\serialport-shim\register.cjs
set CAFESIM_PORTS=COM1=7001,COM2=7002,COM3=7003
npm start
```

또는 [com0com](https://sourceforge.net/projects/com0com/)으로 가상 COM 쌍(COM1↔COM11 …)을 만들고
`npm run sim -- --serial main=COM11,ice=COM12,cup=COM13`를 실행하면, 앱은 평소처럼 COM1/2/3을 엽니다.
카드 결제는 서버의 KSCAT 에뮬레이터(27098)가 받습니다.

원본 앱의 시리얼 코드를 그대로 돌려 보는 검증 스크립트:
`node --require ./packages/serialport-shim/register.cjs examples/legacy-app-check.cjs <원본 소스 폴더>`

**b) Node SDK** ([examples/node-order.js](examples/node-order.js))

```js
import { connectMachine, loadPlatform } from '@cafesim/server';
const definition = await loadPlatform('m400');
const machine = await connectMachine({ definition });                  // 시뮬레이터
// const machine = await connectMachine({ definition, serial: { main: 'COM1', ice: 'COM2', cup: 'COM3' } }); // 실제 M400
machine.on('step', (s) => console.log(s.text));
await machine.init();
await machine.pay(2000);
await machine.order(definition.menu[0], { temp: 'ice' });   // 컵 → 얼음 → 투출구 → 추출 → 픽업
```

저수준 제어도 됩니다. `machine.main.command('coffee')`, `machine.main.actuator('mainPump', true)`,
`machine.ice.dispense(5, 0.5)`, `machine.cup.dispense('hot')`, `machine.main.status()` …

**c) 다른 언어**: TCP로 바이트 프로토콜을 직접 보내거나 ([examples/python_client.py](examples/python_client.py)) REST를 씁니다.

```
GET  /api/state                 전체 상태 (장치, 컵, 안내)
POST /api/interact              {"type":"moveCup","cup":"cup1","to":"ice:tray"}
                                {"type":"device","device":"pay","action":{"type":"insertCard"}}
                                {"type":"autoAssist","on":true}  {"type":"speed","value":4}
```

**d) 키오스크 UI 프로그래밍**: 터치스크린에는 어떤 웹 페이지든 띄울 수 있습니다.

```html
<script src="http://localhost:5173/cafesim-kiosk-sdk.js"></script>
<script>
  CafeSim.on('guide', (g) => show(g[0]?.text));     // "컵을 제빙기에 대 주세요" …
  await CafeSim.pay(2000);                          // 카드 결제 (KSCAT)
  await CafeSim.order('americano', 'ice');
</script>
```

뷰어 주소에 `?kiosk=http://localhost:3000`을 붙이면 표시됩니다 ([examples/custom-kiosk](examples/custom-kiosk/index.html)).

### 4. 새 플랫폼 만들기

```bash
npm run create-platform my-cafe -- --title "우리 매장"
npm run dev     # http://localhost:5173/?platform=my-cafe
```

장치를 빼거나 더하고, 투출구 라우팅·메뉴·시퀀스·3D 배치를 바꿉니다. 새 장치 타입과 3D 모델을 등록하는 방법은
[docs/PLATFORM.md](docs/PLATFORM.md)에 있습니다.

### 5. 제조 과정 시뮬레이션과 고객 안내

고객 안내는 장치를 누가 구동하든 **물리 상태만 보고** 계산합니다.

| 상황 | 안내 | 고객 동작 |
|---|---|---|
| 결제 요청 | 카드를 단말기에 넣어 주세요 | 카드 단말기 클릭 |
| ICE 컵 배출됨 | ICE 컵을 꺼내 제빙기에 대 주세요 | 컵 → 제빙기 (레버가 눌려 출빙 시작) |
| 출빙 중 | 얼음이 나오는 중입니다. 컵을 떼지 마세요 | (떼면 출빙 중단) |
| 투출구 램프 깜빡임 | N번 투출구에 컵을 놓아 주세요 | 컵 → 투출구 (컵 센서 감지 → 추출 시작) |
| 추출 완료 | 음료가 완성되었습니다. 컵을 가져가세요 | 컵 → 픽업대 |

컵이 없는 투출구에 추출하면 흘린 양(spill)으로 기록되고, 컵 용량을 넘으면 넘침 경고가 뜹니다.
**제어** 탭에서 물 부족, 컵 걸림, 제빙기 에러, 카드 승인 거절 같은 장애를 주입해 예외 처리를 테스트할 수 있습니다.

---

## 개발

```bash
npm test             # 프로토콜·제조 흐름·서버 통합 테스트
npm run build        # packages/viewer/dist
npm run sim -- --help
```

`main`에 push하면 GitHub Actions가 테스트하고 3D 뷰어를 GitHub Pages에 배포합니다.

> 원본 키오스크 앱 소스(`source/`)는 저장소에 포함하지 않습니다. 프로토콜과 장치 동작은 원본 코드를 분석해 재구성했으며,
> 실기에 따라 다를 수 있는 부분(배관 라우팅, 유량, 타이밍)은 `platforms/m400/platform.js`와 장치 옵션으로 조정할 수 있습니다.

## License

MIT
