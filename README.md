# 시디즈 평택 SCP 적정성 점검 앱

Streamlit Cloud에서 실행되는 SCP 목표재고 적정성 점검 도구입니다.

## 실행 방법

### Streamlit Cloud (운영)
1. 이 저장소를 GitHub에 push
2. [Streamlit Cloud](https://share.streamlit.io) → New app
3. Repository / Branch / Main file path: `sidiz_scp_app/app.py` 선택
4. Deploy 클릭 → 자동 배포

### 로컬 실행 (개발/테스트)
```bash
pip install streamlit
streamlit run sidiz_scp_app/app.py
```

---

## 앱 수정 방법 (Claude 없이)

### 파일 구조
```
sidiz_scp_app/
├── app.py          ← Streamlit 진입점 (거의 수정 불필요)
├── scp_app.jsx     ← 앱 전체 로직 (여기를 수정)
├── requirements.txt
└── README.md
```

### 주요 수정 포인트 (`scp_app.jsx`)

| 위치 | 수정 내용 |
|------|----------|
| `LINE_CAPA_DEFAULT` 상수 | 라인별 기본 일일 CAPA 값 |
| `BIZ_DEFAULT` 상수 | 기본 영업일 수 (현재 22) |
| `Z97` 상수 | 서비스율 Z값 (97% = 1.88) |
| `ASM_LT` 상수 | 조립 LT 영업일 (현재 2) |
| `judgeStock` 함수 | 목표재고 판정 기준 (%) |
| `judgeSell` 함수 | 판매예측 판정 기준 (%) |
| `TERMS` 상수 | 용어 설명 탭 내용 |

### 수정 절차
1. `scp_app.jsx` 파일을 텍스트 편집기(VS Code 등)로 열기
2. 원하는 부분 수정
3. GitHub에 push (`git add . && git commit -m "수정내용" && git push`)
4. Streamlit Cloud 자동 재배포 (1~2분 소요)

---

## 입력 파일 형식

| 파일 | 형식 | 설명 |
|------|------|------|
| ① 과소품목 목록 | XLSX | 시디즈평택_과소품목_vN.xlsx |
| ② 품목별 제조 LT | CSV/XLSX | CODE·리드타임 컬럼 포함 |
| ③ SCP 자료 | XLSX | 시디즈 의자 SCP 시트 포함 |
| ④ 과거 출고 내역 | CSV/XLSX | 평택의자 출고량 |
| ⑤ CAPA JSON (선택) | JSON | ⚙️ CAPA 설정 탭에서 저장한 파일 |

---

## CAPA 관리 워크플로

```
[연 1회]
Grid00 파일 업로드 → ⚡ CAPA 산출 → ✏️ 수동 보정 → 💾 JSON 저장

[매월]  
🔃 JSON 불러오기 → 4개 파일 업로드 → ▶ 분석 실행
```
