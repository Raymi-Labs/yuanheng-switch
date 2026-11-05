const rows: [string, string, string, string, string][] = [
  [
    "通过 GitHub 登录",
    "Sign in via GitHub",
    "透過 GitHub 登入",
    "GitHub でログイン",
    "GitHub로 로그인",
  ],
  [
    "通过 Google 登录",
    "Sign in via Google",
    "透過 Google 登入",
    "Google でログイン",
    "Google로 로그인",
  ],
  [
    "使用网站账号登录，第三方密码仅在系统浏览器输入",
    "Use your website account. Enter third-party passwords only in your system browser.",
    "使用網站帳號登入，第三方密碼僅在系統瀏覽器輸入",
    "Web アカウントでログインします。外部サービスのパスワードはシステムブラウザーでのみ入力してください。",
    "웹사이트 계정으로 로그인합니다. 외부 서비스 비밀번호는 시스템 브라우저에서만 입력하세요.",
  ],
  [
    "请在浏览器核对账号与授权码，再批准本机登录。五分钟内有效。",
    "Check the account and code in your browser, then approve this login. Valid for five minutes.",
    "請在瀏覽器核對帳號與授權碼，再核准本機登入。五分鐘內有效。",
    "ブラウザーでアカウントとコードを確認してログインを承認してください。5分間有効です。",
    "브라우저에서 계정과 코드를 확인한 후 로그인을 승인하세요. 5분간 유효합니다.",
  ],
  [
    "正在准备浏览器授权…",
    "Preparing browser authorization…",
    "正在準備瀏覽器授權…",
    "ブラウザー認証を準備中…",
    "브라우저 인증 준비 중…",
  ],
  [
    "取消浏览器登录",
    "Cancel browser login",
    "取消瀏覽器登入",
    "ブラウザーログインをキャンセル",
    "브라우저 로그인 취소",
  ],
  [
    "浏览器授权已过期，请重新发起",
    "Browser authorization expired. Start again.",
    "瀏覽器授權已過期，請重新發起",
    "ブラウザー認証の有効期限が切れました。やり直してください。",
    "브라우저 인증이 만료되었습니다. 다시 시작하세요.",
  ],
  [
    "浏览器登录未完成，请重试",
    "Browser login did not complete. Try again.",
    "瀏覽器登入未完成，請重試",
    "ブラウザーログインが完了しませんでした。再試行してください。",
    "브라우저 로그인이 완료되지 않았습니다. 다시 시도하세요.",
  ],
  [
    "网站未开启此登录方式，或尚未部署客户端授权接口",
    "This sign-in method or the desktop authorization service is not enabled on the website.",
    "網站未啟用此登入方式，或尚未部署用戶端授權介面",
    "このログイン方法またはデスクトップ認証サービスがサイトで有効になっていません。",
    "웹사이트에서 이 로그인 방식 또는 데스크톱 인증 서비스가 활성화되지 않았습니다.",
  ],
  [
    "可使用 GitHub、Google 或账号密码登录。密码不会保存在本机，工具凭据按所选分组配置。",
    "Sign in with GitHub, Google, or your account password. Passwords are not saved locally; tool credentials follow the selected group.",
    "可使用 GitHub、Google 或帳號密碼登入。密碼不儲存在本機，工具憑證依所選群組設定。",
    "GitHub、Google またはアカウントのパスワードでログインできます。パスワードはローカルに保存せず、ツール認証情報は選択したグループに従います。",
    "GitHub, Google 또는 계정 비밀번호로 로그인할 수 있습니다. 비밀번호는 로컬에 저장하지 않으며 도구 인증 정보는 선택한 그룹을 따릅니다.",
  ],
];
const column = (i: number): Record<string, string> =>
  Object.fromEntries(rows.map((row) => [row[0], row[i]]));
export const BROWSER_LOGIN_EN = column(1),
  BROWSER_LOGIN_ZH_TW = column(2),
  BROWSER_LOGIN_JA = column(3),
  BROWSER_LOGIN_KO = column(4);
