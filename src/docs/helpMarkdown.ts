import type { Locale } from '@/i18n';

export const helpMarkdown: Record<Locale, string> = {
  zh: `# App 配置说明：DeepSeek API Key 与 GitHub Gist

本 App 需要你自己提供：

\`\`\`text
DeepSeek API Key
GitHub Token
GitHub Gist ID
\`\`\`

DeepSeek API Key 用来调用 AI 翻译能力。

GitHub Gist 用来同步订阅源、Prompt、已读状态和收藏状态。

DeepSeek API Key 和 GitHub Token 保存在本机安全存储中，不会写入 Gist。所有 Key 和 Token 请自己保管，不要发给别人，不要截图公开。

## 1. 配置 DeepSeek API Key

打开 DeepSeek 开放平台：

[DeepSeek Platform](https://platform.deepseek.com)

登录账号，进入 API Keys，创建新的 API Key。

复制生成的 API Key。

回到 App，打开设置页，填写：

\`\`\`text
DeepSeek Key
\`\`\`

填写后会自动保存。

注意：

\`\`\`text
API Key 只会完整显示一次。
不要把 API Key 发给别人。
不要把 API Key 放到 GitHub、Gist、博客、截图里。
如果怀疑泄露，请立刻删除旧 Key，重新创建一个。
\`\`\`

## 2. 创建 GitHub Token

打开 GitHub：

[GitHub](https://github.com)

登录账号，进入 Settings，打开 Developer settings，进入 Personal access tokens。

建议选择 Fine-grained tokens，点击 Generate new token。

填写 Token 名称，例如：

\`\`\`text
FeedMind Sync Token
\`\`\`

设置过期时间。建议不要选择永久有效，可以选择 90 天、180 天或 1 年。

在权限里找到 Gists，设置为 Read and write，其他权限不要打开。

创建 Token，复制生成的 Token。

回到 App，打开设置页，填写：

\`\`\`text
GitHub Token
\`\`\`

填写后点击「立即同步」，App 会保存 Token 并开始同步。

官方说明：

[GitHub Personal Access Tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)

注意：

\`\`\`text
Token 只会完整显示一次。
不要把 Token 发给别人。
不要把 Token 写进 Gist。
不要把 Token 上传到 GitHub。
如果怀疑泄露，请立刻删除旧 Token，重新创建一个。
\`\`\`

## 3. 创建 GitHub Gist

打开：

[GitHub Gist](https://gist.github.com)

点击右上角 +。

填写描述，例如：

\`\`\`text
FeedMind Sync Data
\`\`\`

填写文件名：

\`\`\`text
rss-ai-reader-sync.json
\`\`\`

文件内容可以先填：

\`\`\`json
{
  "version": 1,
  "updatedAt": "",
  "feeds": [],
  "articleStates": [],
  "prompts": []
}
\`\`\`

点击 Create secret gist。

建议创建 secret gist。不要创建 public gist，除非你明确知道自己在公开这些数据。

注意：secret gist 不是严格私有。只要别人拿到链接，仍然可以访问。

官方说明：

[GitHub Gist API](https://docs.github.com/en/rest/gists/gists)

## 4. 获取 Gist ID

创建 Gist 后，浏览器地址栏会变成类似：

\`\`\`text
https://gist.github.com/yourname/1234567890abcdef1234567890abcdef
\`\`\`

最后这一段就是 Gist ID：

\`\`\`text
1234567890abcdef1234567890abcdef
\`\`\`

复制它。

回到 App，打开设置页，填写：

\`\`\`text
Gist ID
\`\`\`

填写后会自动保存。

## 5. App 内配置示例

在 App 设置页填写：

\`\`\`text
DeepSeek Key:
sk-xxxxxxxxxxxxxxxx

GitHub Token:
github_pat_xxxxxxxxxxxxxxxx

Gist ID:
1234567890abcdef1234567890abcdef
\`\`\`

然后点击：

\`\`\`text
立即同步
\`\`\`

如果提示同步完成，说明配置可用。

## 6. 常见错误

### DeepSeek API Key 无效

可能原因：

\`\`\`text
API Key 填错
API Key 多复制了空格
API Key 已被删除
DeepSeek 账号余额不足
\`\`\`

处理方式：

\`\`\`text
重新复制 API Key
删除前后空格
检查 DeepSeek 控制台
重新创建 API Key
\`\`\`

### GitHub Token 无效

可能原因：

\`\`\`text
Token 填错
Token 已过期
Token 权限没有选择 Gists Read and write
Token 被删除
\`\`\`

处理方式：

\`\`\`text
重新创建 GitHub Token
确认权限只需要 Gists Read and write
重新填写到 App
\`\`\`

### Gist ID 无效

可能原因：

\`\`\`text
复制了完整链接，而不是 Gist ID
Gist 被删除
Gist 不是当前账号创建的
Token 没有权限访问这个 Gist
\`\`\`

正确格式：

\`\`\`text
1234567890abcdef1234567890abcdef
\`\`\`

错误格式：

\`\`\`text
https://gist.github.com/yourname/1234567890abcdef1234567890abcdef
\`\`\`

### 同步失败

可能原因：

\`\`\`text
网络无法访问 GitHub
GitHub Token 过期
Gist ID 填错
Gist 文件内容不是合法 JSON
\`\`\`

处理方式：

\`\`\`text
检查网络
重新生成 Token
重新复制 Gist ID
打开 Gist 检查 JSON 格式
\`\`\`

## 7. 安全建议

不要公开 DeepSeek API Key。

不要公开 GitHub Token。

不要把 Token 填到别人给你的网页里。

不要把 Token 写进 Gist 内容。

不要把 Token 发给 AI、客服、群聊或论坛。

如果你怀疑 Key 或 Token 泄露：

\`\`\`text
1. 删除旧 DeepSeek API Key
2. 创建新的 DeepSeek API Key
3. 删除旧 GitHub Token
4. 创建新的 GitHub Token
5. 回到 App 重新填写
\`\`\`

## 8. 推荐权限

GitHub Token 只需要：

\`\`\`text
Gists: Read and write
\`\`\`

不需要：

\`\`\`text
Repository
Workflow
Packages
Organization
Admin
Delete repo
\`\`\`

不要给多余权限。
`,
  en: `# App Configuration: DeepSeek API Key and GitHub Gist

This app requires your own:

\`\`\`text
DeepSeek API Key
GitHub Token
GitHub Gist ID
\`\`\`

The DeepSeek API Key is used for AI translation.

GitHub Gist is used to sync feeds, prompts, read status, and starred status.

DeepSeek API Key and GitHub Token are stored in secure local storage and are not written to Gist. Keep all keys and tokens private. Do not share them or publish screenshots.

## 1. Configure DeepSeek API Key

Open the DeepSeek platform:

[DeepSeek Platform](https://platform.deepseek.com)

Sign in, open API Keys, and create a new API key.

Copy the generated API key.

Go back to the app, open Settings, and fill in:

\`\`\`text
DeepSeek Key
\`\`\`

The value is saved automatically after you enter it.

Notes:

\`\`\`text
The API key is shown in full only once.
Do not send the API key to others.
Do not put the API key in GitHub, Gist, blogs, or screenshots.
If you suspect a leak, delete the old key and create a new one immediately.
\`\`\`

## 2. Create a GitHub Token

Open GitHub:

[GitHub](https://github.com)

Sign in, open Settings, open Developer settings, then open Personal access tokens.

Fine-grained tokens are recommended. Click Generate new token.

Enter a token name, for example:

\`\`\`text
FeedMind Sync Token
\`\`\`

Set an expiration date. Avoid tokens that never expire. You can choose 90 days, 180 days, or 1 year.

Find Gists in permissions, set it to Read and write, and do not enable other permissions.

Create the token and copy it.

Go back to the app, open Settings, and fill in:

\`\`\`text
GitHub Token
\`\`\`

After entering it, tap Sync Now. The app will save the token and start syncing.

Official docs:

[GitHub Personal Access Tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)

Notes:

\`\`\`text
The token is shown in full only once.
Do not send the token to others.
Do not write the token into Gist.
Do not upload the token to GitHub.
If you suspect a leak, delete the old token and create a new one immediately.
\`\`\`

## 3. Create a GitHub Gist

Open:

[GitHub Gist](https://gist.github.com)

Click + in the top-right corner.

Enter a description, for example:

\`\`\`text
FeedMind Sync Data
\`\`\`

Enter the file name:

\`\`\`text
rss-ai-reader-sync.json
\`\`\`

You can use this initial file content:

\`\`\`json
{
  "version": 1,
  "updatedAt": "",
  "feeds": [],
  "articleStates": [],
  "prompts": []
}
\`\`\`

Click Create secret gist.

A secret gist is recommended. Do not create a public gist unless you intentionally want to expose the data.

Note: a secret gist is not strictly private. Anyone with the link can still access it.

Official docs:

[GitHub Gist API](https://docs.github.com/en/rest/gists/gists)

## 4. Get the Gist ID

After creating the Gist, the browser URL will look like:

\`\`\`text
https://gist.github.com/yourname/1234567890abcdef1234567890abcdef
\`\`\`

The last segment is the Gist ID:

\`\`\`text
1234567890abcdef1234567890abcdef
\`\`\`

Copy it.

Go back to the app, open Settings, and fill in:

\`\`\`text
Gist ID
\`\`\`

The value is saved automatically after you enter it.

## 5. In-App Example

Fill in Settings:

\`\`\`text
DeepSeek Key:
sk-xxxxxxxxxxxxxxxx

GitHub Token:
github_pat_xxxxxxxxxxxxxxxx

Gist ID:
1234567890abcdef1234567890abcdef
\`\`\`

Then tap:

\`\`\`text
Sync Now
\`\`\`

If sync completes, the configuration is valid.

## 6. Common Errors

### Invalid DeepSeek API Key

Possible causes:

\`\`\`text
The API key is wrong
Extra spaces were copied
The API key was deleted
The DeepSeek account has insufficient balance
\`\`\`

Fixes:

\`\`\`text
Copy the API key again
Remove leading and trailing spaces
Check the DeepSeek console
Create a new API key
\`\`\`

### Invalid GitHub Token

Possible causes:

\`\`\`text
The token is wrong
The token expired
The token does not have Gists Read and write permission
The token was deleted
\`\`\`

Fixes:

\`\`\`text
Create a new GitHub token
Confirm only Gists Read and write is required
Enter it in the app again
\`\`\`

### Invalid Gist ID

Possible causes:

\`\`\`text
You copied the full URL instead of the Gist ID
The Gist was deleted
The Gist was created by another account
The token cannot access this Gist
\`\`\`

Correct format:

\`\`\`text
1234567890abcdef1234567890abcdef
\`\`\`

Wrong format:

\`\`\`text
https://gist.github.com/yourname/1234567890abcdef1234567890abcdef
\`\`\`

### Sync Failed

Possible causes:

\`\`\`text
The network cannot access GitHub
The GitHub token expired
The Gist ID is wrong
The Gist file content is not valid JSON
\`\`\`

Fixes:

\`\`\`text
Check the network
Generate a new token
Copy the Gist ID again
Open the Gist and check the JSON format
\`\`\`

## 7. Security Tips

Do not publish your DeepSeek API Key.

Do not publish your GitHub Token.

Do not enter the token into websites you do not trust.

Do not write the token into Gist content.

Do not send the token to AI, support, chats, or forums.

If you suspect a key or token leaked:

\`\`\`text
1. Delete the old DeepSeek API Key
2. Create a new DeepSeek API Key
3. Delete the old GitHub Token
4. Create a new GitHub Token
5. Enter the new values in the app
\`\`\`

## 8. Recommended Permissions

The GitHub Token only needs:

\`\`\`text
Gists: Read and write
\`\`\`

It does not need:

\`\`\`text
Repository
Workflow
Packages
Organization
Admin
Delete repo
\`\`\`

Do not grant extra permissions.
`,
  ja: `# アプリ設定説明：DeepSeek API Key と GitHub Gist

このアプリでは、次の情報を自分で用意する必要があります。

\`\`\`text
DeepSeek API Key
GitHub Token
GitHub Gist ID
\`\`\`

DeepSeek API Key は AI 翻訳に使われます。

GitHub Gist はフィード、Prompt、既読状態、スター状態の同期に使われます。

DeepSeek API Key と GitHub Token は端末の安全なストレージに保存され、Gist には書き込まれません。Key と Token は自分で管理し、他人に送ったりスクリーンショットで公開したりしないでください。

## 1. DeepSeek API Key を設定する

DeepSeek プラットフォームを開きます。

[DeepSeek Platform](https://platform.deepseek.com)

ログインして API Keys を開き、新しい API Key を作成します。

生成された API Key をコピーします。

アプリに戻り、設定画面で次を入力します。

\`\`\`text
DeepSeek Key
\`\`\`

入力後、自動で保存されます。

注意：

\`\`\`text
API Key が完全に表示されるのは一度だけです。
API Key を他人に送らないでください。
API Key を GitHub、Gist、ブログ、スクリーンショットに載せないでください。
漏えいが疑われる場合は、古い Key を削除して新しい Key を作成してください。
\`\`\`

## 2. GitHub Token を作成する

GitHub を開きます。

[GitHub](https://github.com)

ログインして Settings を開き、Developer settings から Personal access tokens に進みます。

Fine-grained tokens を推奨します。Generate new token をクリックします。

Token 名を入力します。例：

\`\`\`text
FeedMind Sync Token
\`\`\`

有効期限を設定します。無期限は避け、90 日、180 日、1 年などを選んでください。

権限で Gists を探し、Read and write に設定します。他の権限は有効にしないでください。

Token を作成し、生成された Token をコピーします。

アプリに戻り、設定画面で次を入力します。

\`\`\`text
GitHub Token
\`\`\`

入力後、「今すぐ同期」をタップすると、アプリが Token を保存して同期を開始します。

公式ドキュメント：

[GitHub Personal Access Tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)

注意：

\`\`\`text
Token が完全に表示されるのは一度だけです。
Token を他人に送らないでください。
Token を Gist に書かないでください。
Token を GitHub にアップロードしないでください。
漏えいが疑われる場合は、古い Token を削除して新しい Token を作成してください。
\`\`\`

## 3. GitHub Gist を作成する

次を開きます。

[GitHub Gist](https://gist.github.com)

右上の + をクリックします。

説明を入力します。例：

\`\`\`text
FeedMind Sync Data
\`\`\`

ファイル名を入力します。

\`\`\`text
rss-ai-reader-sync.json
\`\`\`

ファイル内容は最初に次のようにできます。

\`\`\`json
{
  "version": 1,
  "updatedAt": "",
  "feeds": [],
  "articleStates": [],
  "prompts": []
}
\`\`\`

Create secret gist をクリックします。

secret gist の作成を推奨します。データを公開する意図がない限り、public gist は作成しないでください。

注意：secret gist は完全な非公開ではありません。リンクを知っている人はアクセスできます。

公式ドキュメント：

[GitHub Gist API](https://docs.github.com/en/rest/gists/gists)

## 4. Gist ID を取得する

Gist 作成後、ブラウザの URL は次のようになります。

\`\`\`text
https://gist.github.com/yourname/1234567890abcdef1234567890abcdef
\`\`\`

最後の部分が Gist ID です。

\`\`\`text
1234567890abcdef1234567890abcdef
\`\`\`

コピーします。

アプリに戻り、設定画面で次を入力します。

\`\`\`text
Gist ID
\`\`\`

入力後、自動で保存されます。

## 5. アプリ内の設定例

設定画面で入力します。

\`\`\`text
DeepSeek Key:
sk-xxxxxxxxxxxxxxxx

GitHub Token:
github_pat_xxxxxxxxxxxxxxxx

Gist ID:
1234567890abcdef1234567890abcdef
\`\`\`

その後、次をタップします。

\`\`\`text
今すぐ同期
\`\`\`

同期完了と表示されれば、設定は有効です。

## 6. よくあるエラー

### DeepSeek API Key が無効

考えられる原因：

\`\`\`text
API Key が間違っている
余分な空白をコピーした
API Key が削除された
DeepSeek アカウントの残高が不足している
\`\`\`

対処：

\`\`\`text
API Key をコピーし直す
前後の空白を削除する
DeepSeek コンソールを確認する
新しい API Key を作成する
\`\`\`

### GitHub Token が無効

考えられる原因：

\`\`\`text
Token が間違っている
Token の期限が切れている
Gists Read and write 権限がない
Token が削除された
\`\`\`

対処：

\`\`\`text
GitHub Token を作成し直す
必要な権限が Gists Read and write だけであることを確認する
アプリに入力し直す
\`\`\`

### Gist ID が無効

考えられる原因：

\`\`\`text
Gist ID ではなく完全な URL をコピーした
Gist が削除された
Gist が現在のアカウントで作成されたものではない
Token でこの Gist にアクセスできない
\`\`\`

正しい形式：

\`\`\`text
1234567890abcdef1234567890abcdef
\`\`\`

間違った形式：

\`\`\`text
https://gist.github.com/yourname/1234567890abcdef1234567890abcdef
\`\`\`

### 同期に失敗する

考えられる原因：

\`\`\`text
ネットワークから GitHub にアクセスできない
GitHub Token の期限が切れている
Gist ID が間違っている
Gist ファイルの内容が正しい JSON ではない
\`\`\`

対処：

\`\`\`text
ネットワークを確認する
Token を作成し直す
Gist ID をコピーし直す
Gist を開いて JSON 形式を確認する
\`\`\`

## 7. セキュリティ推奨事項

DeepSeek API Key を公開しないでください。

GitHub Token を公開しないでください。

信頼できない Web ページに Token を入力しないでください。

Token を Gist 内容に書かないでください。

Token を AI、サポート、チャット、フォーラムに送らないでください。

Key または Token の漏えいが疑われる場合：

\`\`\`text
1. 古い DeepSeek API Key を削除する
2. 新しい DeepSeek API Key を作成する
3. 古い GitHub Token を削除する
4. 新しい GitHub Token を作成する
5. アプリに入力し直す
\`\`\`

## 8. 推奨権限

GitHub Token に必要なのは次だけです。

\`\`\`text
Gists: Read and write
\`\`\`

不要な権限：

\`\`\`text
Repository
Workflow
Packages
Organization
Admin
Delete repo
\`\`\`

余分な権限を付与しないでください。
`,
};
