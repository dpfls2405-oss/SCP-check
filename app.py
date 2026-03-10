"""
시디즈 평택 SCP 적정성 점검 앱
Streamlit으로 React 앱을 서빙합니다.

수정 방법:
- 로직 변경: scp_app.jsx 수정 후 GitHub push
- Streamlit Cloud에서 자동 반영 (약 1~2분 소요)
"""
import streamlit as st
import pathlib

st.set_page_config(
    page_title="시디즈 평택 SCP 점검",
    page_icon="📊",
    layout="wide",
    initial_sidebar_state="collapsed",
)

# 사이드바 - 수정 가이드
with st.sidebar:
    st.markdown("## 📌 앱 수정 방법")
    st.markdown("""
**코드 수정 경로:**
```
sidiz_scp_app/
├── app.py          ← Streamlit 진입점
├── scp_app.jsx     ← React 앱 전체 로직
└── requirements.txt
```

**수정 순서:**
1. `scp_app.jsx` 파일 수정
2. GitHub에 push
3. Streamlit Cloud에서 자동 재배포 (1~2분)

**주요 수정 포인트:**
- 판정 기준 변경: `judgeStock`, `judgeSell` 함수
- CAPA 기본값: `LINE_CAPA_DEFAULT` 상수
- 라인LT 기본값: `ASM_LT` 상수 (현재 2영업일)
- 서비스율: `Z97` 상수 (현재 1.88 = 97%)
    """)
    st.divider()
    st.markdown("**배포 정보**")
    st.caption("Streamlit Cloud 무료 플랜")
    st.caption("GitHub 연동 자동 배포")

# React 앱 HTML 빌드 (CDN 기반 - 빌드 도구 불필요)
jsx_path = pathlib.Path(__file__).parent / "scp_app.jsx"
jsx_code = jsx_path.read_text(encoding="utf-8") if jsx_path.exists() else "// scp_app.jsx 파일을 찾을 수 없습니다"

html_template = f"""<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>SCP 점검</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/react/18.2.0/umd/react.production.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.2.0/umd/react-dom.production.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/babel-standalone/7.23.2/babel.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/PapaParse/5.4.1/papaparse.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/xlsx@0.19.3/dist/xlsx.full.min.js"></script>
<style>
  * {{ box-sizing: border-box; margin: 0; padding: 0; }}
  body {{ font-family: 'Malgun Gothic','Apple SD Gothic Neo',sans-serif; background: #F1F5F9; }}
</style>
</head>
<body>
<div id="root"></div>
<script type="text/babel" data-presets="react">
// ── React를 전역에서 사용 ──
const {{ useState, useMemo, useCallback }} = React;

{jsx_code.replace("import { useState, useMemo, useCallback } from \"react\";", "")
          .replace("import * as XLSX from \"xlsx\";", "")
          .replace("import * as Papa from \"papaparse\";", "")
          .replace("export default function App()", "function App()")
}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(React.createElement(App));
</script>
</body>
</html>"""

# Streamlit components로 HTML 렌더링
st.components.v1.html(html_template, height=900, scrolling=True)
