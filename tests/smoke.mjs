// bookmarks.html の動作確認(ブラウザで開いて、データを壊す変更が入っていないか確かめる)。
// 使い方: npm i --no-save playwright && npx playwright install chromium && node tests/smoke.mjs   (リポジトリ直下で実行。アプリ本体に依存は増えない)
import { chromium } from 'playwright';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const URL_ = pathToFileURL(resolve('bookmarks.html')).href;
const KEY = 'bookmarks_data';
let failed = 0;
function check(name, ok, detail) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  → ' + JSON.stringify(detail)));
  if (!ok) failed++;
}
const bm = (i, extra) => Object.assign({ id: 'i' + i, url: 'https://e' + i + '.example.com', title: 'T' + i, tags: [], loginId: null, loginPassword: null, memo: null, scheme: 'https', domain: 'e' + i + '.example.com', order: i }, extra);

const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();
async function open(p, data) {
  await p.goto(URL_);
  await p.evaluate(([k, d]) => { if (d !== undefined) localStorage.setItem(k, typeof d === 'string' ? d : JSON.stringify(d)); }, [KEY, data]);
  await p.reload();
  await p.evaluate(() => { window.confirm = () => true; window.alert = () => {}; });
}
const titles = (p) => p.$$eval('.card--list .card-title a', (els) => els.map((e) => e.textContent));
async function add(p, title, url) {
  await p.click('#toggle-add-btn');
  await p.fill('#new-url', url || 'https://' + title + '.example.com');
  await p.fill('#new-title', title);
  await p.click('#add-form button[type=submit]');
}

// 3: 削除のあとに追加した行が、末尾に入る
await open(page, Array.from({ length: 10 }, (_, i) => bm(i)));
for (let i = 0; i < 8; i++) await page.locator('.card--list [data-action="delete"]').first().click();
await add(page, 'NEWONE');
check('削除のあとに追加した行は末尾', JSON.stringify(await titles(page)) === JSON.stringify(['T8', 'T9', 'NEWONE']), await titles(page));

// 2: 壊れたデータは退避され、次の保存で上書きされても残る
const broken = '[null,{"url":"https://a.com"}]';
await open(page, broken);
await add(page, 'X');
check('壊れたデータの退避', (await page.evaluate(() => localStorage.getItem('bookmarks_data_broken'))) === broken);

// 1: 2つのタブで追加しても、両方残る
await open(page, []);
const tab2 = await ctx.newPage();
await open(tab2, undefined);
await add(page, 'tabA');
await add(tab2, 'tabB');
const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('bookmarks_data')).map((b) => b.title).sort());
check('2つのタブの追加が両方残る', JSON.stringify(stored) === JSON.stringify(['tabA', 'tabB']), stored);
await tab2.close();

// 4: 編集中の入力は、再描画(タグの絞り込み)で消えない
await open(page, [bm(0, { tags: ['t1'] })]);
await page.click('[data-action="edit"]');
await page.fill('#edit-memo', 'unsaved memo');
await page.click('.tag-tile[data-tag="t1"]');
check('編集中のメモが再描画で消えない', (await page.$eval('#edit-memo', (e) => e.value)) === 'unsaved memo');

// 自動タグ付けは無い: 既存のタグ名に当たる入力でも、追加フォームのタグは空のまま
await open(page, [bm(0, { tags: ['ai'] })]);
await page.click('#toggle-add-btn');
await page.fill('#new-url', 'https://ai.example.com');
await page.fill('#new-title', 'ai');
check('追加フォームのタグは自動で選ばれない', (await page.$eval('#new-tag-chips', (e) => e.textContent.trim())) === '');
check('自動タグ付けのボタンもモーダルも無い', (await page.$('#auto-tag-btn')) === null && (await page.$('#auto-tag-overlay')) === null);

// 旧形式(v1.x: group あり・tags なし)の読み込み
const oldFormat = bm(0, { group: '仕事' });
delete oldFormat.tags; // 旧形式には tags が無い(配列があると group は使われない)
await open(page, [oldFormat, bm(1)]);
const legacy = await page.$$eval('.row-tag', (els) => els.map((e) => e.textContent));
check('旧形式の group がタグになる', legacy.includes('仕事'), legacy);

// 5: 社内向けホストは、ファビコンを Google へ取りにいかない
const reqs = [];
page.on('request', (r) => reqs.push(r.url()));
await open(page, [bm(0, { url: 'http://intranet-hr/', domain: 'intranet-hr' }), bm(1)]);
await page.waitForTimeout(300);
check('単語だけのホスト名は Google に送らない', !reqs.some((u) => u.includes('favicons') && u.includes('intranet-hr')), reqs);

// 追加フォームの URL 欄への貼り付け: 「タイトル+改行+URL」の2行だけ、タイトルも受け取る
async function paste(p, text) {
  return p.$eval('#new-url', (el, t) => {
    const dt = new DataTransfer();
    dt.setData('text/plain', t);
    const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    el.dispatchEvent(ev);
    return ev.defaultPrevented;
  }, text);
}
async function freshAddForm(p, data) {
  await open(p, data || []);
  await p.click('#toggle-add-btn');
}
const fields = (p) => p.evaluate(() => ({ url: document.getElementById('new-url').value, title: document.getElementById('new-title').value }));

await freshAddForm(page);
let pr = await paste(page, 'Example Domain\r\nhttps://example.com/');
let f = await fields(page);
check('2行の貼り付けで URL とタイトルが入る', pr === true && f.url === 'https://example.com/' && f.title === 'Example Domain', { pr, f });

await freshAddForm(page);
await page.fill('#new-title', 'old');
await paste(page, 'Example Domain\r\nhttps://example.com/');
check('貼り付けはタイトル欄を上書きする', (await fields(page)).title === 'Example Domain');

await freshAddForm(page);
pr = await paste(page, '\n  T  \n\n https://a.example.com \n');
f = await fields(page);
check('前後の空白・空行・LF だけでも振り分ける', pr === true && f.title === 'T' && f.url === 'https://a.example.com', { pr, f });

for (const [name, text] of [
  ['URL が2行は振り分けない', 'https://a.com\nhttps://b.com'],
  ['URL だけは標準の貼り付け', 'https://a.com'],
  ['空のタイトルは標準の貼り付け', '\nhttps://a.com'],
  ['3行は標準の貼り付け', 'a\nb\nhttps://a.com'],
  ['2行目が URL でなければ標準(bar)', 'foo\nbar'],
  ['2行目が URL でなければ標準(javascript:)', 'foo\njavascript:alert(1)'],
]) {
  await freshAddForm(page);
  pr = await paste(page, text);
  check(name, pr === false && (await fields(page)).title === '', { pr });
}

await freshAddForm(page, [bm(0, { tags: ['ai'] })]);
await paste(page, 'ai の記事\nhttps://x.example.com/');
check('貼り付けでもタグは自動で選ばれない', (await page.$eval('#new-tag-chips', (e) => e.textContent.trim())) === '');

// コピー用ブックマークレットの登録リンク
await freshAddForm(page);
const href = await page.$eval('#bookmarklet-link', (e) => e.getAttribute('href')).catch(() => '');
check('登録用リンクは javascript: で始まる', href.startsWith('javascript:'), href);
const linkPrevented = await page.$eval('#bookmarklet-link', (el) => {
  const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
  el.dispatchEvent(ev);
  return ev.defaultPrevented;
}).catch(() => null);
check('登録用リンクのクリックは何も実行しない', linkPrevented === true, linkPrevented);
const shownCode = await page.$eval('#bookmarklet-code', (e) => e.value).catch(() => null);
check('表示用コードは javascript: で始まり、リンクと同じ', shownCode !== null && shownCode.startsWith('javascript:') && href === shownCode, { shownCode });

// 実際のページでコードを動かし、クリップボードの内容をアプリへ貼る(外部通信なし。ページは route で返す)
await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
await ctx.route('https://page.test/**', (r) => r.fulfill({ contentType: 'text/html', body: '<title>  Foo \n Bar </title><p>x</p>' }));
const src = await ctx.newPage();
await src.goto('https://page.test/');
await src.bringToFront();
// 表示されたコードを、そのままブックマークの URL にしたもの(手動登録)として押した場合
await src.evaluate((h) => { const a = document.createElement('a'); a.href = h; document.body.appendChild(a); a.click(); }, shownCode || '');
const clip = await src.evaluate(() => navigator.clipboard.readText()).catch((e) => String(e));
check('ブックマークレットは「タイトル+改行+URL」をコピーする', JSON.stringify(clip.split(/\r?\n/)) === JSON.stringify(['Foo Bar', 'https://page.test/']), clip);
await src.close();
await page.bringToFront();
await freshAddForm(page);
await paste(page, clip);
f = await fields(page);
check('コピーした内容を貼ると URL とタイトルが入る', f.url === 'https://page.test/' && f.title === 'Foo Bar', f);

// 保存でフォームがリセットされても、手動登録用のコード欄は空にならない
await open(page, []);
await add(page, 'SAVED');
check('保存後もコード欄が空でない', (await page.$eval('#bookmarklet-code', (e) => e.value)).length > 0);

// コード欄(手動登録用): フォームの外にあり、ラベルがあり、他の入力欄と同じ見た目
await freshAddForm(page);
await page.fill('#new-url', 'https://enter.example/');
await page.fill('#new-title', 'E');
await page.evaluate(() => { document.getElementById('bookmarklet-code').closest('details').open = true; });
await page.focus('#bookmarklet-code');
await page.keyboard.press('Enter');
const savedCount = await page.evaluate(() => JSON.parse(localStorage.getItem('bookmarks_data') || '[]').length);
check('コード欄で Enter を押しても保存されない', savedCount === 0 && (await page.$eval('#add-panel', (e) => !e.hidden)), { savedCount });
check('コード欄にラベルがある', await page.$eval('label[for="bookmarklet-code"]', (e) => e.textContent.trim().length > 0).catch(() => false));
const look = await page.evaluate(() => {
  const s = (id) => { const c = getComputedStyle(document.getElementById(id)); return [c.paddingLeft, c.borderTopColor, c.fontSize].join('|'); };
  return [s('bookmarklet-code'), s('new-url')];
});
check('コード欄の見た目が他の入力欄と同じ', look[0] === look[1], look);

// 実際の貼り付け(Ctrl+V)と、javascript: の href としての実行
async function realPaste(p, text) {
  await p.evaluate((t) => navigator.clipboard.writeText(t), text);
  await p.focus('#new-url');
  await p.keyboard.press('Control+V');
}
await freshAddForm(page);
await realPaste(page, 'Example Domain\r\nhttps://example.com/');
f = await fields(page);
check('Ctrl+V で、2行の貼り付けが URL とタイトルに入る', f.url === 'https://example.com/' && f.title === 'Example Domain', f);
await freshAddForm(page);
await realPaste(page, 'https://a.example.com/');
f = await fields(page);
check('Ctrl+V で、URL だけの貼り付けはホスト名がタイトルになる', f.url === 'https://a.example.com/' && f.title === 'a.example.com', f);

const linkHref = await page.$eval('#bookmarklet-link', (e) => e.getAttribute('href'));
const src2 = await ctx.newPage();
await src2.goto('https://page.test/');
await src2.bringToFront();
await src2.evaluate((h) => { const a = document.createElement('a'); a.href = h; document.body.appendChild(a); a.click(); }, linkHref);
await src2.waitForTimeout(300);
const clip2 = await src2.evaluate(() => navigator.clipboard.readText()).catch((e) => String(e));
check('登録用リンクの href としてコードを実行しても、タイトルと URL がコピーされる', JSON.stringify(clip2.split(/\r?\n/)) === JSON.stringify(['Foo Bar', 'https://page.test/']), clip2);
await src2.close();

// 行のボタンは、文字ではなくアイコン(名前は aria-label)
await open(page, [bm(0, { loginId: 'u', loginPassword: 'p' })]);
const idBtn = await page.$eval('.card--list [data-action="copy-login-id"]', (e) => ({ label: e.getAttribute('aria-label'), text: e.textContent.trim(), svg: !!e.querySelector('svg') }));
check('ID のボタンはアイコンで、名前が付く', idBtn.label === 'ログインIDをコピー' && idBtn.text === '' && idBtn.svg, idBtn);

// メモが無い行は、ホスト名を 2 行目に出す。メモがあればメモ
await open(page, [bm(0, { memo: null }), bm(1, { memo: 'M1' })]);
const subs = await page.$$eval('.card--list .row-memo-preview', (els) => els.map((e) => e.textContent));
check('メモが無い行はホスト名、あればメモ', JSON.stringify(subs) === JSON.stringify(['e0.example.com', 'M1']), subs);

// UNC の行(ドメインなし)は、2 行目が無くても崩れず、行が描画される
await open(page, [bm(0, { url: '\\\\srv\\share\\a', scheme: 'unc', domain: null, memo: null })]);
check('UNC の行が描画される', (await titles(page)).length === 1);
const secondLine = () => page.evaluate(() => { const e = document.querySelector('.card--list .row-memo-preview'); return e ? e.textContent : null; });
check('UNC の行は、2 行目にパスが出る', (await secondLine()) === '\\\\srv\\share\\a');
await open(page, [bm(0, { url: 'file:///C:/docs/a.txt', scheme: 'file', domain: null, memo: null })]);
check('file: の行は、2 行目にパスが出る', (await secondLine()) === 'file:///C:/docs/a.txt');

// 長いタグ 1 個でも、チップはカードの幅を使い、3 行に折れない(2 行以内)
await open(page, [bm(0, { tags: ['プロジェクト管理システム運用手順書(2026年度版)', 'a', 'b'], loginId: 'u', loginPassword: 'p' })]);
const chipH = await page.$eval('.card--list .row-tag', (e) => e.getBoundingClientRect().height);
check('長いタグのチップは 2 行以内', chipH < 50, chipH);

// 長いタグ名: 省略されず、チップが 3 行を超えるぶんだけ +N になる
const longTag = 'プロジェクト管理システム運用手順書(2026年度版)';
await open(page, [bm(0, { tags: [longTag].concat(Array.from({ length: 40 }, (_, i) => 'a' + (i + 1))) })]); // チップがカードの全幅を使うので、3 行を超えるだけの数を付ける
const chipInfo = await page.evaluate(() => {
  const card = document.querySelector('.card--list'); // 行は、付いているタグの区画ごとに出るので、最初の 1 枚だけを見る
  const hidden = card.querySelectorAll('.row-tags .row-tag[hidden]').length;
  const more = card.querySelector('.row-tags .row-tag-more');
  const first = card.querySelector('.row-tags .row-tag');
  return { hidden, more: more ? more.textContent : null, first: first.textContent, overflow: getComputedStyle(first).textOverflow };
});
check('長いタグ名は省略されない', chipInfo.first === longTag && chipInfo.overflow !== 'ellipsis', chipInfo);
check('チップは 3 行まで。残りは +N', chipInfo.hidden > 0 && chipInfo.more === '+' + chipInfo.hidden, chipInfo);
const tileInfo = await page.$eval('.tag-tile[data-tag] .tag-tile-name', (e) => ({ text: e.textContent, overflow: getComputedStyle(e).textOverflow }));
check('タグのタイルは名前を省略しない', tileInfo.overflow !== 'ellipsis' && tileInfo.text.length > 0, tileInfo);

// 編集フォームが区画の中で出て、入力中の内容が、グリッドの再描画で消えない
await open(page, [bm(0, { tags: ['t1'] }), bm(1, { tags: ['t1'] })]);
await page.click('.card--list [data-action="edit"]');
await page.fill('#edit-memo', 'draft');
await page.click('.tag-tile[data-tag="t1"]');
check('編集フォームが全幅の 1 枚で出て、入力が残る', (await page.$$('#edit-memo')).length === 1 && (await page.$eval('#edit-memo', (e) => e.value)) === 'draft');

// 詳細パネル: 項目が出て、パスワードは伏せ字(値は出さない)。回数が出る
await open(page, [bm(0, { loginId: 'user01', loginPassword: 'secret-pw', memo: 'M' })]);
await page.click('.card--list', { position: { x: 6, y: 6 } });
const det = await page.$eval('#detail', (e) => e.textContent);
check('詳細にパスワードの値は出ない', !det.includes('secret-pw') && det.includes('●●●●●●●●'), det);
check('詳細に回数と注記が出る', det.includes('直近28日に開いた回数') && det.includes('パスワードは平文で保存されます'), det);

// 空の画面: ブックマーク 0 件のとき、案内が出て、タグ行は隠れる
await open(page, []);
check('0 件のとき案内が出る', (await page.$eval('#bookmark-list', (e) => e.textContent)).includes('ブックマークがありません'));
check('タグが 0 個のとき、タグ行の区画は隠れる', await page.$eval('#tag-section', (e) => e.hidden));

// ===== グループ(データ層) =====
async function importJson(p, obj) {
  await p.evaluate(() => { window.confirm = () => true; });
  await p.setInputFiles('#import-file', { name: 'x.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(obj)) });
  await p.waitForTimeout(200);
}
const storedJson = (p, k) => p.evaluate((key) => JSON.parse(localStorage.getItem(key)), k);

// 旧データ(groups なし)は読み込め、旧キーの値はグループの並びとして読まれず、削除される
await open(page, [bm(0, { tags: ['t'] }), bm(1)]);
await page.evaluate(() => localStorage.setItem('bookmarks_group_order', JSON.stringify(['t'])));
await page.reload();
check('旧キー bookmarks_group_order は削除される', (await page.evaluate(() => localStorage.getItem('bookmarks_group_order'))) === null);
await add(page, 'G0');
check('旧データを保存すると、groups は空の配列になる', JSON.stringify((await storedJson(page, 'bookmarks_data')).map((b) => b.groups)) === JSON.stringify([[], [], []]), (await storedJson(page, 'bookmarks_data')).map((b) => b.groups));

// グループ名は、大文字小文字・前後の空白が違っても 1 つに統合される(インポートの検証を通す)
await open(page, []);
await importJson(page, { version: 3, bookmarks: [bm(0, { groups: ['Work', ' work ', 5, '', 'Home'] }), bm(1, { groups: ['WORK'] })], groupOrder: ['home', 'work'] });
const imp = await storedJson(page, 'bookmarks_data');
check('グループは大文字小文字・空白・非文字列を整え、表記を揃える', JSON.stringify(imp.map((b) => b.groups)) === JSON.stringify([['Work', 'Home'], ['Work']]), imp.map((b) => b.groups));
check('v3 の groupOrder が保存される', JSON.stringify(await storedJson(page, 'bookmarks_groups_order')) === JSON.stringify(['home', 'work']));

// v2 の groupOrder(旧: タグのキー)と、配列だけの旧式は、グループの並びとして読まない
await importJson(page, { version: 2, bookmarks: [bm(0, { groups: ['a'] })], groupOrder: ['a'] });
check('v2 の groupOrder は無視される', JSON.stringify(await storedJson(page, 'bookmarks_groups_order')) === JSON.stringify([]));
await importJson(page, [bm(0)]);
check('配列だけの旧式でも、groupOrder は空', JSON.stringify(await storedJson(page, 'bookmarks_groups_order')) === JSON.stringify([]));

// エクスポートは version 3 で、groups と groupOrder を含む
await open(page, [bm(0, { groups: ['g1'] })]);
const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#export-btn')]);
const exported = JSON.parse(await (await import('node:fs/promises')).readFile(await dl.path(), 'utf8'));
check('エクスポートは version 3 で groups を含む', exported.version === 3 && exported.bookmarks[0].groups[0] === 'g1' && Array.isArray(exported.groupOrder), exported);

// ===== グループ(区画・絞り込み・パネル) =====
const sections = () => page.$$eval('.tag-group', (els) => els.map((e) => e.getAttribute('data-group') + ':' + e.querySelectorAll('.card--list').length));

// 旧データ(groups なし)は、全件が「グループなし」の 1 区画
await open(page, [bm(0, { tags: ['t'] }), bm(1)]);
check('旧データは全件が「グループなし」の区画', JSON.stringify(await sections()) === JSON.stringify([':2']), await sections());

// 区画はグループごと。複数のグループに所属すると、それぞれの区画に出る。グループなしは最後
await open(page, [bm(0, { groups: ['仕事', '資料室'], tags: ['t1'] }), bm(1, { groups: ['仕事'], tags: ['t2'] }), bm(2, { groups: [] })]);
check('区画はグループごと(複数所属は重複して出る。グループなしは最後)', JSON.stringify(await sections()) === JSON.stringify(['仕事:2', '資料室:1', ':1']), await sections());
check('グループなしの区画の見出し', (await page.$$eval('.tag-group-head', (els) => els.map((e) => e.textContent))).pop().startsWith('グループなし'));

// ヘッダーのパネルで、グループを絞り込む。タグの絞り込みとは AND
await page.click('#group-filter-btn');
check('パネルが開く', (await page.$eval('#group-popover', (e) => !e.hidden)) && (await page.$eval('#group-filter-btn', (e) => e.getAttribute('aria-expanded'))) === 'true');
await page.click('[data-group-filter="資料室"]');
check('グループで絞ると、その区画だけ', JSON.stringify(await sections()) === JSON.stringify(['資料室:1']), await sections());
check('パネルは選んだら閉じる', await page.$eval('#group-popover', (e) => e.hidden));
await page.click('.tag-tile[data-tag="t2"]');
check('グループとタグは AND(該当なしなら区画が無い)', (await sections()).length === 0);
await page.click('#filter-clear-btn');
check('解除でグループとタグの両方が外れる', JSON.stringify(await sections()) === JSON.stringify(['仕事:2', '資料室:1', ':1']), await sections());

// 同名のタグとグループは、別の絞り込みとして動く
await open(page, [bm(0, { groups: ['x'], tags: ['y'] }), bm(1, { groups: ['y'], tags: ['x'] })]);
await page.click('#group-filter-btn');
await page.click('[data-group-filter="x"]');
check('グループ x は、タグ x の行を巻き込まない', (await titles(page)).join() === 'T0', await titles(page));

// 絞り込み中のグループが無くなったら、絞り込みが外れる(画面が空にならない)
await open(page, [bm(0, { groups: ['solo'] }), bm(1, { groups: ['other'] })]);
await page.click('#group-filter-btn');
await page.click('[data-group-filter="solo"]');
await page.click('.card--list [data-action="delete"]');
check('絞り込み中のグループが消えたら、残りが出る', (await titles(page)).length === 1, await titles(page));

// 検索の対象にグループ名を含める。0 件の区画は見出しごと隠す
await open(page, [bm(0, { groups: ['営業部'] }), bm(1, { groups: ['開発部'] })]);
await page.fill('#search-input', '営業');
check('グループ名で検索できる', JSON.stringify(await sections()) === JSON.stringify(['営業部:1']), await sections());

// Escape: パネルが開いているとき、Escape はパネルを閉じる
await open(page, [bm(0, { groups: ['g'] })]);
await page.click('#group-filter-btn');
await page.keyboard.press('Escape');
check('Escape でパネルが閉じる', await page.$eval('#group-popover', (e) => e.hidden));

// ===== グループ(追加・編集フォーム、詳細パネル) =====
// 追加フォーム: グループを入れて保存できる(Enter で確定。タグの自動選択はグループには働かない)
await open(page, [bm(0, { groups: ['既存'], tags: ['ai'] })]);
await page.click('#toggle-add-btn');
await page.fill('#new-url', 'https://ai.example.com');
check('追加フォームのグループは自動選択されない', (await page.$eval('#new-group-chips', (e) => e.textContent.trim())) === '');
await page.fill('#new-title', 'G1');
await page.fill('#new-group-text', '新規グループ');
await page.press('#new-group-text', 'Enter');
await page.click('#add-form button[type=submit]');
const savedG = await page.evaluate(() => JSON.parse(localStorage.getItem('bookmarks_data')).find((b) => b.title === 'G1').groups);
check('追加フォームで付けたグループが保存される', JSON.stringify(savedG) === JSON.stringify(['新規グループ']), savedG);

// 既存のグループは、入力すると表記が揃う(大文字小文字違いでも)
await open(page, [bm(0, { groups: ['Work'] })]);
await page.click('#toggle-add-btn');
await page.fill('#new-url', 'https://x.example.com');
await page.fill('#new-title', 'G2');
await page.fill('#new-group-text', 'work');
await page.press('#new-group-text', 'Enter');
check('既存のグループの表記に揃う', (await page.$eval('#new-group-chips', (e) => e.textContent.trim())).startsWith('Work'));

// 編集フォーム: グループの入力中の内容が、再描画(タグの絞り込み)で消えない。保存で反映される
await open(page, [bm(0, { groups: ['g1'], tags: ['t1'] })]);
await page.click('.card--list [data-action="edit"]');
await page.fill('#edit-group-text', 'g2');
await page.press('#edit-group-text', 'Enter');
await page.click('.tag-tile[data-tag="t1"]');
check('編集中のグループが再描画で消えない', (await page.$eval('#edit-group-chips', (e) => e.textContent)).includes('g2'));
await page.click('[data-edit-form] button[type=submit]');
const editedG = await page.evaluate(() => JSON.parse(localStorage.getItem('bookmarks_data'))[0].groups);
check('編集で付けたグループが保存される', JSON.stringify(editedG) === JSON.stringify(['g1', 'g2']), editedG);

// 詳細パネルに「グループ」の項目が出る(グループが無いときは出さない)
await open(page, [bm(0, { groups: ['仕事', '資料室'] }), bm(1)]);
await page.click('.tag-group[data-group="仕事"] .card--list', { position: { x: 6, y: 6 } });
check('詳細にグループが出る', (await page.$eval('#detail', (e) => e.textContent)).includes('仕事 / 資料室'));
await page.click('.tag-group[data-group=""] .card--list', { position: { x: 6, y: 6 } });
check('グループが無いブックマークの詳細には、グループの項目が出ない', !(await page.$eval('#detail', (e) => e.textContent)).includes('グループ'));

// ===== グループ(管理: 改名・統合・削除・並べ替え) =====
const mdata = [bm(0, { groups: ['a'], tags: ['x'] }), bm(1, { groups: ['b'] }), bm(2, { groups: ['a', 'c'] })];
await open(page, mdata);
check('管理ボタンの名前', (await page.$eval('#tag-manage-open-btn', (e) => e.textContent.trim())) === '管理');
await page.click('#tag-manage-open-btn');
await page.click('[data-manage-tab="group"]');
const rowNames = () => page.$$eval('#tag-manage-list .tag-manage-name', (els) => els.map((e) => e.textContent));
check('グループのタブに、グループが並ぶ(名前順)', JSON.stringify(await rowNames()) === JSON.stringify(['a', 'b', 'c']), await rowNames());
await page.click('[data-manage-tab="tag"]');
check('タグのタブには、並べ替えの操作が無い', (await page.$$eval('#tag-manage-list [data-action="move-tag-up"]', (e) => e.length)) === 0);
check('タグのタブには、タグが並ぶ', JSON.stringify(await rowNames()) === JSON.stringify(['x']), await rowNames());
await page.click('[data-manage-tab="group"]');

// 並べ替え(▼)は groupOrder に保存され、別のタブにも届く
const tabM = await ctx.newPage();
await open(tabM, undefined);
await page.click('#tag-manage-list [data-action="move-tag-down"][data-tag="a"]');
check('▼ で並びが変わり、保存される', JSON.stringify(await rowNames()) === JSON.stringify(['b', 'a', 'c']) && JSON.stringify(await storedJson(page, 'bookmarks_groups_order')) === JSON.stringify(['b', 'a', 'c']), await rowNames());
await tabM.waitForTimeout(300);
await tabM.click('#group-filter-btn');
const orderM = await tabM.$$eval('#group-popover .group-row-name', (els) => els.map((e) => e.textContent));
check('並びが別のタブにも届く', JSON.stringify(orderM) === JSON.stringify(['すべて', 'b', 'a', 'c']), orderM);
await tabM.close();

// 改名: 既存の名前にすると統合される(確認を経る)。同名のタグには影響しない
await page.click('#tag-manage-list [data-action="edit-tag"][data-tag="c"]');
await page.fill('.tag-rename-input', 'A');
await page.click('.tag-rename-form button[type=submit]');
await page.click('[data-action="apply-rename"]');
const afterRename = await storedJson(page, 'bookmarks_data');
check('改名で統合され、表記は既存に揃う', JSON.stringify(afterRename[2].groups) === JSON.stringify(['a']), afterRename[2].groups);
check('同名のタグは変わらない', JSON.stringify(afterRename[0].tags) === JSON.stringify(['x']));

// 削除: グループだけ外れ、ブックマークは残る
await page.click('#tag-manage-list [data-action="delete-tag"][data-tag="b"]');
await page.click('[data-action="confirm-delete-tag"]');
const afterDelete = await storedJson(page, 'bookmarks_data');
check('グループの削除はブックマークを残す', afterDelete.length === 3 && afterDelete[1].groups.length === 0);

// 絞り込み中のグループを改名すると、絞り込みが新しい名前へ引き継がれる
await open(page, [bm(0, { groups: ['old'] })]);
await page.click('#group-filter-btn');
await page.click('[data-group-filter="old"]');
await page.click('#tag-manage-open-btn');
await page.click('[data-manage-tab="group"]');
await page.click('#tag-manage-list [data-action="edit-tag"][data-tag="old"]');
await page.fill('.tag-rename-input', 'new');
await page.click('.tag-rename-form button[type=submit]');
await page.click('[data-action="apply-rename"]');
await page.keyboard.press('Escape');
check('絞り込みが新しい名前へ引き継がれる', (await page.$$eval('.tag-group', (e) => e.map((x) => x.getAttribute('data-group')))).join() === 'new');

// 同名のタグとグループ: タグの改名は、グループの絞り込み・並びに影響しない
await open(page, [bm(0, { groups: ['same'], tags: ['same'] })]);
await page.click('#group-filter-btn');
await page.click('[data-group-filter="same"]');
await page.click('#tag-manage-open-btn');
await page.click('#tag-manage-list [data-action="edit-tag"][data-tag="same"]');
await page.fill('.tag-rename-input', 'renamed');
await page.click('.tag-rename-form button[type=submit]');
await page.click('[data-action="apply-rename"]');
await page.keyboard.press('Escape');
const sameState = await page.evaluate(() => ({ data: JSON.parse(localStorage.getItem('bookmarks_data'))[0], sections: Array.prototype.map.call(document.querySelectorAll('.tag-group'), (e) => e.getAttribute('data-group')) }));
check('タグを改名しても、同名のグループと絞り込みは変わらない', sameState.data.groups[0] === 'same' && sameState.data.tags[0] === 'renamed' && sameState.sections.join() === 'same', sameState);

// ===== 最終レビューの指摘 =====
// 2 つのタブ: 片方でインポートした groupOrder が、もう片方の再描画(storage イベント)で消えない
await open(page, [bm(0, { groups: ['c', 'a'] })]);
await page.evaluate(() => localStorage.setItem('bookmarks_groups_order', JSON.stringify(['c', 'a']))); // 別のタブが、古い並びを持っている状態にする
await page.reload();
const tabB = await ctx.newPage();
await open(tabB, undefined);
await importJson(page, { version: 3, bookmarks: [bm(0, { groups: ['z'] }), bm(1, { groups: ['b'] })], groupOrder: ['z', 'b'] });
await tabB.waitForTimeout(500);
check('インポートした groupOrder が、別のタブの再描画で消えない', JSON.stringify(await storedJson(page, 'bookmarks_groups_order')) === JSON.stringify(['z', 'b']), await storedJson(page, 'bookmarks_groups_order'));
await tabB.click('#group-filter-btn');
const orderB = await tabB.$$eval('#group-popover .group-row-name', (els) => els.map((e) => e.textContent));
check('別のタブにも、インポートした並びが出る', JSON.stringify(orderB) === JSON.stringify(['すべて', 'z', 'b']), orderB);
await tabB.close();

// グループのパネルが開いているとき、検索欄の Escape は、検索ではなくパネルを閉じる
await open(page, [bm(0, { groups: ['g'] })]);
await page.fill('#search-input', 'T0');
await page.click('#group-filter-btn');
await page.focus('#search-input');
await page.keyboard.press('Escape');
check('パネルが開いているとき、検索欄の Escape はパネルを閉じ、検索は残る', (await page.$eval('#group-popover', (e) => e.hidden)) && (await page.$eval('#search-input', (e) => e.value)) === 'T0');

await browser.close();
console.log(failed ? failed + ' 件失敗' : 'すべて成功');
process.exit(failed ? 1 : 0);
