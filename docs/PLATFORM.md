# 플랫폼 만들기 / 확장하기

"플랫폼"은 하나의 무인 매장 구성(장치 + 배관 라우팅 + 제조 시퀀스 + 메뉴 + 3D 배치)입니다.
`platforms/<id>/platform.js` 하나가 전부이며, 뷰어·서버·SDK가 모두 이 파일을 읽습니다.

```bash
npm run create-platform my-cafe -- --title "우리 매장"
npm run dev                      # http://localhost:5173/?platform=my-cafe
npm run sim -- --platform my-cafe   # 가상 하드웨어 서비스
```

## 1. 구성 요소

```js
export default definePlatform({
  id: 'my-cafe',
  name: '우리 매장',
  devices: [                     // 가상 장치 (= 실기의 보드)
    { key: 'main', type: 'mailbean-mainboard', port: { path: 'COM1', baudRate: 38400, tcp: 7001 },
      options: { spouts: 3, routing: { coffee: [1, 2], hotWater: 1, ade: [2, 3, 3], powder: [2, 2, 2, 3, 3, 3] } } },
    { key: 'ice', type: 'ice-maker', port: { path: 'COM2', baudRate: 9600, tcp: 7002 } },
    { key: 'cup', type: 'cup-dispenser', port: { path: 'COM3', baudRate: 9600, tcp: 7003 } },
    { key: 'pay', type: 'kscat-terminal', port: { http: 27098 } },
  ],
  temperatures: { coffeeReady: 92, hotWaterReady: 85, ... },
  sequences: { americano: ['grinder1', 'brewUpper', 'preInfusion', 'coffee', 'hotWater', 'brewLower', 'brewMiddle'] },
  menu: [{ id: 'americano', name: '아메리카노', price: 2000, temps: ['ice', 'hot'], spout: 1, sequence: 'americano',
           recipe: { grinderTime1: 2.5, coffeeAmount: 40, hotWaterAmount: 150 },
           variants: { ice: { recipe: { hotWaterAmount: 110 }, ice: { ice: 5, water: 0 } } } }],
  layout: { counter: { width: 2.6 }, pickup: [-1.08, 0, 0.16],
            units: [{ model: 'm400-main', device: 'main', payment: 'pay', position: [-0.6, 0, -0.04] }, ...] },
  kiosk: 'https://my-kiosk.example.com',  // (선택) 터치스크린에 띄울 UI
});
```

| 항목 | 설명 |
|---|---|
| `devices[].type` | 등록된 장치 타입: `mailbean-mainboard`, `cup-dispenser`, `ice-maker`, `kscat-terminal`, 또는 직접 만든 타입 |
| `devices[].port` | `tcp`: 서버가 여는 TCP 포트, `path/baudRate`: 실기 포트 정보(문서/`--serial`용), `http`: KSCAT |
| `options.routing` | 각 액체 경로가 몇 번 투출구로 나오는지. 커피는 `[기본, S155 선택 시]` |
| `sequences` | 메뉴가 실행하는 메인보드 명령 목록. 문자열 = 명령 키, `{select:true}` = S155, `{wait:ms}`, `{actuator:'mainPump', on:true}` |
| `menu[].variants.ice` | 아이스 변형: 레시피 덮어쓰기, `ice: {ice: 초, water: 초}` 제빙기 출빙량 |
| `layout.units` | 3D 모델과 위치(m). `model`: `m400-main`, `ice-dispenser`, `cup-dispenser` 또는 등록한 모델 |

명령 키: `grinder1, grinder2, brewUpper, brewMiddle, brewLower, preInfusion, coffee, hotWater, powder1~6, ade1~3, steam, cake`

## 2. 새 장치 타입

`Device`를 상속하고 프로토콜 파서 + 응답 + 물리 시뮬레이션을 구현합니다. `create-platform`이 만들어 주는
`devices/SyrupStation.example.js`가 완전한 예제입니다.

```js
import { Device } from '@cafesim/core';

export class SyrupStation extends Device {
  static type = 'syrup-station';
  static label = '시럽 스테이션';
  static slots = () => ['nozzle'];          // 컵을 놓을 수 있는 자리 → "syrup:nozzle"

  createParser(onFrame) { ... }             // 바이트 스트림 → 프레임
  handleFrame(frame, reply) { reply(bytes) } // 요청에 응답
  update(dt) { this.world.pour(`${this.key}:nozzle`, 'ade', cc, 1) } // 시간 경과
  snapshot() { return {...} }               // 뷰어/REST에 보여줄 상태
}
```

플랫폼에 `{ key: 'syrup', type: 'syrup-station', class: SyrupStation, port: { tcp: 7010 } }` 로 추가하면

- 서버가 `127.0.0.1:7010` 을 열어 외부 프로그램이 접속할 수 있고
- 3D 뷰어에는 전용 모델이 없으면 라벨이 붙은 기본 박스로 표시됩니다.

## 3. 새 3D 모델

```js
import { registerModel } from '@cafesim/viewer/src/scene/models.js';
registerModel('syrup-station', () => ({
  group,                          // THREE.Group (카운터 상판 y=0, 정면 +Z)
  slots: { nozzle: new THREE.Vector3(0, 0.08, 0.15) },
  shells: [],                     // 내부 보기 시 투명해질 외장
  pickables: [],                  // 클릭 가능한 부품
  update(deviceSnapshot, paySnapshot, time) {},
}));
```

## 4. 안내(가이드) 규칙

고객에게 주는 "컵을 제빙기에 대 주세요" 같은 안내는 `packages/core/src/world/Guide.js` 가
**물리 상태만 보고** 계산합니다 (컵 위치, 제빙기 대기 상태, 투출구 램프 깜빡임, 결제 대기).
그래서 SDK든, 직접 작성한 프로그램이든, 원본 키오스크 앱이든 같은 안내가 나옵니다.
새 장치에 안내가 필요하면 이 파일에 규칙을 추가하세요.
