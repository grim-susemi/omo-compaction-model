# omo-compaction-model

senpi(OMO) 자동 요약(compaction)이 `settings.json`의 `compaction.model`을 **실제로** 쓰게 만드는 모드식 확장.
설치된 senpi 파일은 고치지 않고, 실행 중 메모리에서만 요약 모델 선택을 바꾼다. 파일을 지우고 다시 불러오면 원래대로 돌아간다.

## 왜 필요한가

senpi 2026.10.16 `dist/core/agent-session.js`:

```js
getCompactionModel: () => this.model && this._retryFallback.isProviderSpent(this.model.provider)
    ? this._resolveCompactionModel(this.model)
    : this.model,
```

내장 요약 확장(`<builtin:compaction>`)은 이 함수로 모델을 고른다. 대화 모델의 사용량이 다 찼을 때만 설정 모델을 쓰고, 평소에는 늘 대화 모델로 요약한다.

## 하는 일

| 기능 | 내용 |
| --- | --- |
| 요약 모델 교체 | `ExtensionRunner.bindCore`를 감싸 runner의 `getCompactionModelFn`이 설정 모델을 돌려주게 함(모델이 있고 인증될 때만) |
| 같은 시도 안 대체 | 설정 모델 요약이 취소·오류·빈 결과(결정적 체크포인트)·멈춤이면 `<builtin:compaction>`만 대화 모델로 1번 다시 실행. 다른 훅은 1번만 실행 |
| 멈춤 감시 | 요약 글자가 120초 동안 안 오거나 총 300초를 넘기면 끊음 (`OMO_COMPACTION_MODEL_IDLE_MS`, `OMO_COMPACTION_MODEL_MAX_MS`) |
| 도구 호출 방지 | Anthropic이 아닌 설정 모델로 가는 요약 요청에서 작업 도구 목록 제거(일부 OpenAI 호환 중계가 tool_choice none을 무시하고 도구를 호출하던 문제) |
| 쿨다운 | 설정 모델이 실패하면 30분 동안 대화 모델 사용 |
| 구조 확인 | senpi 내부(`bindCore`, `dispatchEmit`, runner 필드)가 바뀌었으면 패치하지 않음 = 원래 동작 |
| 끄기 | 환경변수 `OMO_COMPACTION_MODEL_PATCH=0` |
| 기록 | `<agent>/logs/omo-compaction-model.jsonl` (`override-summary`, `override-failed-retry-session-model` 등) |

## 설치 / 되돌리기

- 설치: `src/omo-compaction-model.ts`를 `<agent-dir>/extensions/omo-compaction-model.ts`로 복사(`<agent-dir>` = `SENPI_CODING_AGENT_DIR`). 열린 대화는 자동으로 다시 불러온다.
- 되돌리기: 그 파일을 지우고 다시 불러오거나 재시작.
- 실사용 설치: 2026-10-17, sha256 `f5bbe48a2b30afc3f3303365ad4b98717f344343c8e540ff8080826ead48fb48`.

## 격리 시험

```
OMO_TEST_SOURCE_AGENT_DIR=<인증·모델목록을 복사해 올 에이전트 폴더> \
SENPI_CLI=<senpi dist/bundle/cli.js 경로> \
node test/run-isolated.mjs <세션모델> <증거폴더> <확장파일> <요약모델>
```

임시 에이전트 폴더(인증·모델 목록 사본, 끝나면 삭제)에서 RPC 세션으로 대화 2턴과 `/compact` 1회를 실행한다.
요약모델에 `omo-test-dead/dead`(연결 거부) 또는 `omo-test-hang/hang`(응답 없음, 임시 포트)을 주면 실패 경로를 시험한다.
결과: `docs/TEST-RECEIPT.md`.

## senpi 업데이트 때 확인할 것

1. 위 `getCompactionModel`이 그대로인지 확인한다. 상류가 고쳐서 평소에도 설정 모델을 쓰면 이 확장은 은퇴 후보다.
2. `ExtensionRunner.prototype.bindCore`·`dispatchEmit`, runner의 `extensions`·`createContext`·`emitError`·`getCompactionModelFn`·`updateCompactionFn`·`modelRegistry`가 남아 있는지 확인한다(없으면 확장은 스스로 꺼진다).
3. 격리 시험 정상·멈춤·실패 3종을 다시 돌리고, 새 실행에서 `session-start` 기록의 `compactionModelNow`가 설정 모델인지 확인한다.
