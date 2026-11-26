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
// タグのパネルを開いて、key のタグを選ぶ
async function pickTag(p, key) {
  await p.click('#tag-filter-btn');
  await p.click('#tag-popover [data-filter-key="' + key + '"]');
}
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
await pickTag(page, 't1');
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
const rowInfo = await page.$$eval('#tag-popover .filter-row-name', (els, name) => els.filter((e) => e.textContent === name).map((e) => getComputedStyle(e).textOverflow), longTag);
check('タグのパネルの行は名前を省略しない', rowInfo.length === 1 && rowInfo[0] !== 'ellipsis', rowInfo);

// 編集フォームが区画の中で出て、入力中の内容が、グリッドの再描画で消えない
await open(page, [bm(0, { tags: ['t1'] }), bm(1, { tags: ['t1'] })]);
await page.click('.card--list [data-action="edit"]');
await page.fill('#edit-memo', 'draft');
await pickTag(page, 't1');
check('編集フォームが全幅の 1 枚で出て、入力が残る', (await page.$$('#edit-memo')).length === 1 && (await page.$eval('#edit-memo', (e) => e.value)) === 'draft');

// 詳細パネル: 項目が出て、パスワードは伏せ字(値は出さない)。回数が出る
await open(page, [bm(0, { loginId: 'user01', loginPassword: 'secret-pw', memo: 'M' })]);
await page.click('.card--list', { position: { x: 6, y: 6 } });
const det = await page.$eval('#detail', (e) => e.textContent);
check('詳細にパスワードの値は出ない', !det.includes('secret-pw') && det.includes('●●●●●●●●'), det);
check('詳細に回数と注記が出る', det.includes('直近28日に開いた回数') && det.includes('パスワードは平文で保存されます'), det);

// 空の画面: ブックマーク 0 件のとき、案内が出て、タグ行(#tag-section・#tag-bar)は無い
await open(page, []);
check('0 件のとき案内が出る', (await page.$eval('#bookmark-list', (e) => e.textContent)).includes('ブックマークがありません'));
check('タグ行(#tag-section・#tag-bar)は無い', (await page.$('#tag-section')) === null && (await page.$('#tag-bar')) === null);

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
const savedOld = await storedJson(page, 'bookmarks_data');
check('旧データを保存すると、groupName は空で、groups のキーは無い', JSON.stringify(savedOld.map((b) => b.groupName)) === JSON.stringify(['', '', '']) && savedOld.every((b) => !('groups' in b)), savedOld);

// v3 の複数グループは、先頭の空でないものだけが groupName になる。表記は揃う(インポートの検証を通す)
await open(page, []);
await importJson(page, { version: 3, bookmarks: [bm(0, { groups: ['Work', ' work ', 5, '', 'Home'] }), bm(1, { groups: ['WORK'] })], groupOrder: ['home', 'work'] });
const imp = await storedJson(page, 'bookmarks_data');
check('v3 の groups は先頭だけが groupName になり、表記が揃う', JSON.stringify(imp.map((b) => b.groupName)) === JSON.stringify(['Work', 'Work']) && imp.every((b) => !('groups' in b)), imp);
check('v3 の groupOrder が保存される(使われなくなった home は外れる)', JSON.stringify(await storedJson(page, 'bookmarks_groups_order')) === JSON.stringify(['work']), await storedJson(page, 'bookmarks_groups_order'));
await importJson(page, { version: 3, bookmarks: [bm(0, { groups: ['', ' ', 'B', 'C'] })] });
check('v3 の groups の先頭の空は飛ばす', (await storedJson(page, 'bookmarks_data'))[0].groupName === 'B', await storedJson(page, 'bookmarks_data'));
await importJson(page, { version: 4, bookmarks: [bm(0, { groupName: 7 }), bm(1, { groupName: null }), bm(2, { groupName: ['x'] }), bm(3, { groupName: '  ' })] });
const badG = await storedJson(page, 'bookmarks_data');
check('v4 の不正な groupName は空になり、ブックマークは残る', badG.length === 4 && badG.every((b) => b.groupName === ''), badG);

// v2 の groupOrder(旧: タグのキー)と、配列だけの旧式は、グループの並びとして読まない
await importJson(page, { version: 2, bookmarks: [bm(0, { groups: ['a'] })], groupOrder: ['a'] });
check('v2 の groupOrder は無視される', JSON.stringify(await storedJson(page, 'bookmarks_groups_order')) === JSON.stringify([]));
await importJson(page, [bm(0)]);
check('配列だけの旧式でも、groupOrder は空', JSON.stringify(await storedJson(page, 'bookmarks_groups_order')) === JSON.stringify([]));

// エクスポートは version 4 で、groupName と groupOrder を含む(groups は無い)
await open(page, [bm(0, { groupName: 'g1' })]);
const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#export-btn')]);
const exported = JSON.parse(await (await import('node:fs/promises')).readFile(await dl.path(), 'utf8'));
check('エクスポートは version 4 で groupName を含む', exported.version === 4 && exported.bookmarks[0].groupName === 'g1' && !('groups' in exported.bookmarks[0]) && Array.isArray(exported.groupOrder), exported);

// ===== グループ(区画・絞り込み・パネル) =====
const sections = () => page.$$eval('.tag-group', (els) => els.map((e) => e.getAttribute('data-group') + ':' + e.querySelectorAll('.card--list').length));

// 旧データ(groups なし)は、全件が「グループなし」の 1 区画
await open(page, [bm(0, { tags: ['t'] }), bm(1)]);
check('旧データは全件が「グループなし」の区画', JSON.stringify(await sections()) === JSON.stringify([':2']), await sections());

// 区画はグループごと。旧データの複数所属は、先頭のグループの区画だけに出る(重複しない)。グループなしは最後
await open(page, [bm(0, { groups: ['仕事', '資料室'], tags: ['t1'] }), bm(1, { groupName: '仕事', tags: ['t2'] }), bm(2, { groupName: '' }), bm(3, { groupName: '資料室' })]);
check('区画はグループごと(先頭のグループだけ。グループなしは最後)', JSON.stringify(await sections()) === JSON.stringify(['仕事:2', '資料室:1', ':1']), await sections());
const heads = await page.$$eval('.tag-group-head', (els) => els.map((e) => e.textContent));
check('区画の見出しに名前と件数', heads[0].indexOf('仕事') !== -1 && heads[0].indexOf('2') !== -1, heads);
check('グループなしの区画の見出し', heads[heads.length - 1].startsWith('グループなし'), heads);
check('行は 1 回だけ出る', (await page.$$('.card--list[data-card-id="i0"]')).length === 1);

// HTML の特殊文字を含むグループ名でも、見出しにそのまま出る
await open(page, [bm(0, { groupName: '<b>&"' })]);
const specialHead = await page.$eval('.tag-group-head', (e) => e.textContent);
check('特殊文字のグループ名が見出しにそのまま出る', specialHead.startsWith('<b>&"'), specialHead);

// ヘッダーのパネルで、グループを絞り込む。タグの絞り込みとは AND
await open(page, [bm(0, { groupName: '仕事', tags: ['t1'] }), bm(1, { groupName: '仕事', tags: ['t2'] }), bm(2, { groupName: '資料室' }), bm(3)]);
await page.click('#group-filter-btn');
check('パネルが開く', (await page.$eval('#group-popover', (e) => !e.hidden)) && (await page.$eval('#group-filter-btn', (e) => e.getAttribute('aria-expanded'))) === 'true');
await page.click('#group-popover [data-filter-key="資料室"]');
check('グループで絞ると、その区画だけ', JSON.stringify(await sections()) === JSON.stringify(['資料室:1']), await sections());
check('パネルは選んだら閉じる', await page.$eval('#group-popover', (e) => e.hidden));
await pickTag(page, 't2');
check('グループとタグは AND(該当なしなら区画が無い)', (await sections()).length === 0);
await page.click('#filter-clear-btn');
check('解除でグループとタグの両方が外れる', JSON.stringify(await sections()) === JSON.stringify(['仕事:2', '資料室:1', ':1']), await sections());

// 同名のタグとグループは、別の絞り込みとして動く
await open(page, [bm(0, { groupName: 'x', tags: ['y'] }), bm(1, { groupName: 'y', tags: ['x'] })]);
await page.click('#group-filter-btn');
await page.click('#group-popover [data-filter-key="x"]');
check('グループ x は、タグ x の行を巻き込まない', (await titles(page)).join() === 'T0', await titles(page));

// 絞り込み中のグループが無くなったら、絞り込みが外れる(画面が空にならない)
await open(page, [bm(0, { groupName: 'solo' }), bm(1, { groupName: 'other' })]);
await page.click('#group-filter-btn');
await page.click('#group-popover [data-filter-key="solo"]');
await page.click('.card--list [data-action="delete"]');
check('絞り込み中のグループが消えたら、残りが出る', (await titles(page)).length === 1, await titles(page));

// 最後の 1 件が別のグループへ移ると、並びから外れ、絞り込みも外れる
await open(page, [bm(0, { groupName: 'solo' }), bm(1, { groupName: 'other' })]);
await page.evaluate(() => localStorage.setItem('bookmarks_groups_order', JSON.stringify(['solo', 'other'])));
await page.reload();
await page.click('#group-filter-btn');
await page.click('#group-popover [data-filter-key="solo"]');
await page.click('.card--list [data-action="edit"]');
await page.fill('#edit-group-text', 'other');
await page.click('[data-edit-form] button[type=submit]');
check('移ったグループは並びから外れる', JSON.stringify(await storedJson(page, 'bookmarks_groups_order')) === JSON.stringify(['other']), await storedJson(page, 'bookmarks_groups_order'));
check('移ったあと、絞り込みが外れる', JSON.stringify(await sections()) === JSON.stringify(['other:2']), await sections());

// 検索の対象にグループ名を含める。0 件の区画は見出しごと隠す
await open(page, [bm(0, { groupName: '営業部' }), bm(1, { groupName: '開発部' })]);
await page.fill('#search-input', '営業');
check('グループ名で検索できる', JSON.stringify(await sections()) === JSON.stringify(['営業部:1']), await sections());

// Escape: パネルが開いているとき、Escape はパネルを閉じる
await open(page, [bm(0, { groupName: 'g' })]);
await page.click('#group-filter-btn');
await page.keyboard.press('Escape');
check('Escape でパネルが閉じる', await page.$eval('#group-popover', (e) => e.hidden));

// storage イベント: 別のタブが書いた旧形式(groups)も、移行を通して取り込む
await open(page, []);
await page.evaluate(() => {
  localStorage.setItem('bookmarks_data', JSON.stringify([{ id: 's0', url: 'https://s.example.com', title: 'S', tags: [], groups: ['a', 'b'], order: 0 }]));
  window.dispatchEvent(new StorageEvent('storage', { key: 'bookmarks_data' }));
});
check('storage イベントの取り込みでも、区画は先頭のグループだけ', JSON.stringify(await sections()) === JSON.stringify(['a:1']), await sections());
await add(page, 'S2');
const afterStorage = await storedJson(page, 'bookmarks_data');
check('storage イベントの取り込み後の保存に groups は無い', afterStorage.every((b) => !('groups' in b)) && afterStorage[0].groupName === 'a', afterStorage);

// ===== グループ(追加・編集フォーム、詳細パネル) =====
// 追加フォーム: グループは 1 行の入力。自動では入らない
await open(page, [bm(0, { groupName: '既存', tags: ['ai'] })]);
await page.click('#toggle-add-btn');
await page.fill('#new-url', 'https://ai.example.com');
check('追加フォームのグループは自動で入らない', (await page.$eval('#new-group-text', (e) => e.value)) === '');
check('グループのチップ・候補の欄は無い', (await page.$('#new-group-chips')) === null && (await page.$('#new-group-suggest')) === null);
const groupOptions = await page.$$eval('#group-options option', (els) => els.map((e) => e.value));
check('グループの候補(datalist)に既存のグループが出る', JSON.stringify(groupOptions) === JSON.stringify(['既存']), groupOptions);
await page.fill('#new-title', 'G1');
await page.fill('#new-group-text', '新規グループ');
await page.click('#add-form button[type=submit]');
const savedG = await page.evaluate(() => JSON.parse(localStorage.getItem('bookmarks_data')).find((b) => b.title === 'G1').groupName);
check('追加フォームで入れたグループが保存される', savedG === '新規グループ', savedG);
check('保存後、グループの入力欄は空に戻る', (await page.$eval('#new-group-text', (e) => e.value)) === '');

// 既存のグループは、入力すると表記が揃う(大文字小文字違いでも)
await open(page, [bm(0, { groupName: 'Work' })]);
await page.click('#toggle-add-btn');
await page.fill('#new-url', 'https://x.example.com');
await page.fill('#new-title', 'G2');
await page.fill('#new-group-text', 'work');
await page.click('#add-form button[type=submit]');
const savedG2 = await page.evaluate(() => JSON.parse(localStorage.getItem('bookmarks_data')).find((b) => b.title === 'G2').groupName);
check('既存のグループの表記に揃う', savedG2 === 'Work', savedG2);

// 編集フォーム: グループの入力中の内容が、再描画(検索)で消えない。保存で反映される。空にもできる
await open(page, [bm(0, { groupName: 'g1', tags: ['t1'] })]);
await page.click('.card--list [data-action="edit"]');
check('編集フォームに今のグループが入る', (await page.$eval('#edit-group-text', (e) => e.value)) === 'g1');
await page.fill('#edit-group-text', 'g2');
await page.fill('#search-input', 'T');
check('編集中のグループが再描画で消えない', (await page.$eval('#edit-group-text', (e) => e.value)) === 'g2');
await page.click('[data-edit-form] button[type=submit]');
check('編集で変えたグループが保存される', (await storedJson(page, 'bookmarks_data'))[0].groupName === 'g2');
await page.click('.card--list [data-action="edit"]');
await page.fill('#edit-group-text', '');
await page.click('[data-edit-form] button[type=submit]');
check('編集でグループを空にできる', (await storedJson(page, 'bookmarks_data'))[0].groupName === '');

// 詳細パネルに「グループ」の項目が出る(グループが無いときは出さない)
await open(page, [bm(0, { groupName: '仕事' }), bm(1)]);
await page.click('.tag-group[data-group="仕事"] .card--list', { position: { x: 6, y: 6 } });
const detG = await page.$eval('#detail', (e) => e.textContent);
check('詳細にグループが出る', detG.includes('グループ仕事'), detG);
await page.click('.tag-group[data-group=""] .card--list', { position: { x: 6, y: 6 } });
check('グループが無いブックマークの詳細には、グループの項目が出ない', !(await page.$eval('#detail', (e) => e.textContent)).includes('グループ'));

// ===== 管理モーダルのタブ順(グループ → タグ) =====
await open(page, [bm(0, { groupName: 'a', tags: ['x'] })]);
await page.click('#tag-manage-open-btn');
const tabOrder = await page.$$eval('.manage-tabs [data-manage-tab]', (els) => els.map((e) => e.dataset.manageTab));
const tabSel = await page.$$eval('.manage-tabs [data-manage-tab]', (els) => els.map((e) => e.getAttribute('aria-selected')));
check('管理モーダルは「グループ」のタブが先頭で、開くと選ばれている', JSON.stringify(tabOrder) === JSON.stringify(['group', 'tag']) && JSON.stringify(tabSel) === JSON.stringify(['true', 'false']), { tabOrder, tabSel });
check('管理モーダルのタイトルは「グループ・タグの管理」', (await page.$eval('#tag-manage-title', (e) => e.textContent.trim())) === 'グループ・タグの管理');
check('開いた直後の一覧はグループ', JSON.stringify(await page.$$eval('#tag-manage-list .tag-manage-name', (els) => els.map((e) => e.textContent))) === JSON.stringify(['a']));
await page.click('[data-manage-tab="tag"]');
await page.click('#tag-manage-close-btn');
await page.click('#tag-manage-open-btn');
check('開き直すと、また「グループ」が選ばれている', (await page.$eval('[data-manage-tab="group"]', (e) => e.getAttribute('aria-selected'))) === 'true');
await page.click('#tag-manage-close-btn');

// ===== グループ(管理: 改名・統合・削除・並べ替え) =====
const mdata = [bm(0, { groupName: 'a', tags: ['x'] }), bm(1, { groupName: 'b' }), bm(2, { groupName: 'c' })];
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
const orderM = await tabM.$$eval('#group-popover .filter-row-name', (els) => els.map((e) => e.textContent));
check('並びが別のタブにも届く', JSON.stringify(orderM) === JSON.stringify(['すべて', 'b', 'a', 'c']), orderM);
await tabM.close();

// 改名: 既存の名前にすると統合される(確認を経る)。同名のタグには影響しない
await page.click('#tag-manage-list [data-action="edit-tag"][data-tag="c"]');
await page.fill('.tag-rename-input', 'A');
await page.click('.tag-rename-form button[type=submit]');
const confirmText = await page.$eval('#tag-manage-list', (e) => e.textContent);
check('改名の確認に、影響するブックマークが出る', confirmText.includes('T2'), confirmText);
await page.click('[data-action="apply-rename"]');
const afterRename = await storedJson(page, 'bookmarks_data');
check('改名で統合され、表記は既存に揃う', afterRename[2].groupName === 'a', afterRename[2]);
check('同名のタグは変わらない', JSON.stringify(afterRename[0].tags) === JSON.stringify(['x']));

// 改名(統合でない): 新しい名前になる
await page.click('#tag-manage-list [data-action="edit-tag"][data-tag="b"]');
await page.fill('.tag-rename-input', 'B2');
await page.click('.tag-rename-form button[type=submit]');
await page.click('[data-action="apply-rename"]');
check('改名で新しい名前になる', (await storedJson(page, 'bookmarks_data'))[1].groupName === 'B2');

// 削除: グループだけ外れ、ブックマークは残る
await page.click('#tag-manage-list [data-action="delete-tag"][data-tag="b2"]');
await page.click('[data-action="confirm-delete-tag"]');
const afterDelete = await storedJson(page, 'bookmarks_data');
check('グループの削除はブックマークを残す', afterDelete.length === 3 && afterDelete[1].groupName === '', afterDelete);

// 絞り込み中のグループを改名すると、絞り込みが新しい名前へ引き継がれる
await open(page, [bm(0, { groupName: 'old' })]);
await page.click('#group-filter-btn');
await page.click('#group-popover [data-filter-key="old"]');
await page.click('#tag-manage-open-btn');
await page.click('[data-manage-tab="group"]');
await page.click('#tag-manage-list [data-action="edit-tag"][data-tag="old"]');
await page.fill('.tag-rename-input', 'new');
await page.click('.tag-rename-form button[type=submit]');
await page.click('[data-action="apply-rename"]');
await page.keyboard.press('Escape');
check('絞り込みが新しい名前へ引き継がれる', (await page.$$eval('.tag-group', (e) => e.map((x) => x.getAttribute('data-group')))).join() === 'new');

// 同名のタグとグループ: タグの改名は、グループの絞り込み・並びに影響しない
await open(page, [bm(0, { groupName: 'same', tags: ['same'] })]);
await page.click('#group-filter-btn');
await page.click('#group-popover [data-filter-key="same"]');
await page.click('#tag-manage-open-btn');
await page.click('[data-manage-tab="tag"]');
await page.click('#tag-manage-list [data-action="edit-tag"][data-tag="same"]');
await page.fill('.tag-rename-input', 'renamed');
await page.click('.tag-rename-form button[type=submit]');
await page.click('[data-action="apply-rename"]');
await page.keyboard.press('Escape');
const sameState = await page.evaluate(() => ({ data: JSON.parse(localStorage.getItem('bookmarks_data'))[0], sections: Array.prototype.map.call(document.querySelectorAll('.tag-group'), (e) => e.getAttribute('data-group')) }));
check('タグを改名しても、同名のグループと絞り込みは変わらない', sameState.data.groupName === 'same' && sameState.data.tags[0] === 'renamed' && sameState.sections.join() === 'same', sameState);

// ===== 最終レビューの指摘 =====
// 2 つのタブ: 片方でインポートした groupOrder が、もう片方の再描画(storage イベント)で消えない
await open(page, [bm(0, { groupName: 'c' }), bm(1, { groupName: 'a' })]);
await page.evaluate(() => localStorage.setItem('bookmarks_groups_order', JSON.stringify(['c', 'a']))); // 別のタブが、古い並びを持っている状態にする
await page.reload();
const tabB = await ctx.newPage();
await open(tabB, undefined);
await importJson(page, { version: 4, bookmarks: [bm(0, { groupName: 'z' }), bm(1, { groupName: 'b' })], groupOrder: ['z', 'b'] });
await tabB.waitForTimeout(500);
check('インポートした groupOrder が、別のタブの再描画で消えない', JSON.stringify(await storedJson(page, 'bookmarks_groups_order')) === JSON.stringify(['z', 'b']), await storedJson(page, 'bookmarks_groups_order'));
await tabB.click('#group-filter-btn');
const orderB = await tabB.$$eval('#group-popover .filter-row-name', (els) => els.map((e) => e.textContent));
check('別のタブにも、インポートした並びが出る', JSON.stringify(orderB) === JSON.stringify(['すべて', 'z', 'b']), orderB);
await tabB.close();

// グループのパネルが開いているとき、検索欄の Escape は、検索ではなくパネルを閉じる
await open(page, [bm(0, { groupName: 'g' })]);
await page.fill('#search-input', 'T0');
await page.click('#group-filter-btn');
await page.focus('#search-input');
await page.keyboard.press('Escape');
check('パネルが開いているとき、検索欄の Escape はパネルを閉じ、検索は残る', (await page.$eval('#group-popover', (e) => e.hidden)) && (await page.$eval('#search-input', (e) => e.value)) === 'T0');

// ===== タグの手動の並びは持たない(名前順) =====
const tagTiles = (p) => p.$$eval('#tag-popover [data-filter-key]', (els) => els.map((e) => e.getAttribute('data-filter-key')));
await open(page, [bm(0, { tags: ['a', 'b'] })]);
await page.evaluate(() => localStorage.setItem('bookmarks_tag_order', JSON.stringify(['b', 'a'])));
await page.reload();
check('旧キー bookmarks_tag_order は起動時に消え、タグは名前順', (await page.evaluate(() => localStorage.getItem('bookmarks_tag_order'))) === null && JSON.stringify(await tagTiles(page)) === JSON.stringify(['a', 'b']), await tagTiles(page));
await importJson(page, { version: 4, bookmarks: [bm(0, { tags: ['a', 'b'] })], tagOrder: ['b', 'a'] });
check('tagOrder 入りのファイルをインポートしても、保存されず名前順', (await page.evaluate(() => localStorage.getItem('bookmarks_tag_order'))) === null && JSON.stringify(await tagTiles(page)) === JSON.stringify(['a', 'b']), await tagTiles(page));
const [dlTag] = await Promise.all([page.waitForEvent('download'), page.click('#export-btn')]);
const exportedTag = JSON.parse(await (await import('node:fs/promises')).readFile(await dlTag.path(), 'utf8'));
check('エクスポートに tagOrder が無い', !('tagOrder' in exportedTag), Object.keys(exportedTag));

// ===== タグの絞り込みのパネル =====
const panelRows = (p, id) => p.$$eval('#' + id + ' .filter-row', (els) => els.map((e) => e.querySelector('.filter-row-name').textContent + ':' + e.querySelector('.filter-row-count').textContent));
const tagBtn = (p) => p.$eval('#tag-filter-btn', (e) => ({ text: e.textContent, title: e.title, active: e.classList.contains('active'), expanded: e.getAttribute('aria-expanded') }));
const hiddenOf = (p, sel) => p.$eval(sel, (e) => e.hidden);
await open(page, [bm(0, { tags: ['b'], groupName: 'g1' }), bm(1, { tags: ['a', 'b'] }), bm(2, { groupName: 'g1' })]);
await page.click('#tag-filter-btn');
check('タグのボタンでパネルが開く', !(await hiddenOf(page, '#tag-popover')) && (await tagBtn(page)).expanded === 'true');
check('タグのパネルの行は「すべて」+名前順+「タグなし」で件数付き', JSON.stringify(await panelRows(page, 'tag-popover')) === JSON.stringify(['すべて:3', 'a:1', 'b:2', 'タグなし:1']), await panelRows(page, 'tag-popover'));
await page.click('#tag-popover [data-filter-key="b"]');
let tb = await tagBtn(page);
check('タグを選ぶと絞り込まれ、パネルが閉じ、ボタンが「タグ: b」', JSON.stringify(await titles(page)) === JSON.stringify(['T0', 'T1']) && (await hiddenOf(page, '#tag-popover')) && tb.text === 'タグ: b' && tb.title === 'タグ: b' && tb.active && tb.expanded === 'false', { t: await titles(page), tb });
await pickTag(page, 'b');
tb = await tagBtn(page);
check('同じタグをもう一度選ぶと外れる', (await titles(page)).length === 3 && tb.text === 'タグ' && !tb.active, tb);
await page.click('#tag-filter-btn');
await page.click('#tag-popover [data-filter-none]');
check('「タグなし」を選ぶと、タグが 0 個の行だけ', JSON.stringify(await titles(page)) === JSON.stringify(['T2']) && (await tagBtn(page)).text === 'タグ: タグなし', await titles(page));
await page.click('#tag-filter-btn');
await page.click('#tag-popover [data-filter-all]');
check('「すべて」でタグの絞り込みが外れる', (await titles(page)).length === 3 && !(await tagBtn(page)).active);
await page.click('#group-filter-btn');
await page.click('#group-popover [data-filter-key="g1"]');
await pickTag(page, 'b');
check('タグとグループの絞り込みは AND', JSON.stringify(await titles(page)) === JSON.stringify(['T0']), await titles(page));
await page.click('#tag-filter-btn');
await page.click('#group-filter-btn');
check('グループのパネルを開くと、タグのパネルは閉じる', (await hiddenOf(page, '#tag-popover')) && !(await hiddenOf(page, '#group-popover')) && (await tagBtn(page)).expanded === 'false');
await page.click('#tag-filter-btn');
check('タグのパネルを開くと、グループのパネルは閉じる', !(await hiddenOf(page, '#tag-popover')) && (await hiddenOf(page, '#group-popover')) && (await page.$eval('#group-filter-btn', (e) => e.getAttribute('aria-expanded'))) === 'false');
await page.keyboard.press('Escape');
check('Escape でタグのパネルが閉じ、ボタンにフォーカスが戻る', (await hiddenOf(page, '#tag-popover')) && (await page.evaluate(() => document.activeElement.id)) === 'tag-filter-btn');
await page.click('#tag-filter-btn');
await page.click('#result-count');
check('外のクリックでタグのパネルが閉じる', await hiddenOf(page, '#tag-popover'));
await page.click('#tag-filter-btn');
await page.focus('#search-input');
await page.keyboard.press('Escape');
check('パネルが開いているとき、空の検索欄の Escape は絞り込みを外さず、パネルだけ閉じる', (await hiddenOf(page, '#tag-popover')) && (await tagBtn(page)).text === 'タグ: b' && JSON.stringify(await titles(page)) === JSON.stringify(['T0']), await tagBtn(page));
check('ヘルプの Esc の説明が「グループ・タグのパネル」', (await page.$eval('#help-panel', (e) => e.textContent)).includes('グループ・タグのパネル'));

// パネルを開くと、フォーカスがパネルの中へ入る(選択中の行、無ければ「すべて」)
const activeRow = (p) => p.evaluate(() => { var a = document.activeElement; return a ? (a.hasAttribute('data-filter-all') ? 'all' : a.getAttribute('data-filter-key')) : null; });
await page.click('#filter-clear-btn');
for (const [kind, btn, pop, key] of [['タグ', '#tag-filter-btn', '#tag-popover', 'b'], ['グループ', '#group-filter-btn', '#group-popover', 'g1']]) {
  await page.click(btn);
  check(kind + 'のパネル(絞り込みなし): フォーカスは「すべて」の行', (await activeRow(page)) === 'all', await activeRow(page));
  await page.click(pop + ' [data-filter-key="' + key + '"]');
  await page.click(btn);
  check(kind + 'のパネル(絞り込み中): フォーカスは選択中の行', (await activeRow(page)) === key, await activeRow(page));
  await page.keyboard.press('Escape');
  check(kind + 'のパネル: フォーカス中の行から Escape で閉じ、ボタンへ戻る', (await hiddenOf(page, pop)) && (await page.evaluate(() => document.activeElement.id)) === btn.slice(1), await page.evaluate(() => document.activeElement.id));
  await page.click('#filter-clear-btn');
}

// 狭い幅(400x740)でも、パネルは画面からはみ出さない
const vpPrev = page.viewportSize();
await page.setViewportSize({ width: 400, height: 740 });
for (const [btn, pop] of [['#tag-filter-btn', '#tag-popover'], ['#group-filter-btn', '#group-popover']]) {
  await page.click(btn);
  const r = await page.$eval(pop, (e) => { var b = e.getBoundingClientRect(); return { left: b.left, right: b.right, bottom: b.bottom, vw: window.innerWidth, vh: window.innerHeight }; });
  check('400px 幅で ' + pop + ' が画面内に収まる', r.left >= 0 && r.right <= r.vw && r.bottom <= r.vh, r);
  await page.keyboard.press('Escape');
}
await page.setViewportSize(vpPrev || { width: 1280, height: 720 });

// 検索ボックスの # 候補で選んでも、ボタンの文字が替わる
await open(page, [bm(0, { tags: ['alpha'] }), bm(1)]);
await page.fill('#search-input', '#al');
await page.click('#tag-search-suggest li[data-tag="alpha"]');
check('# 候補で選ぶと、ボタンが「タグ: alpha」', (await tagBtn(page)).text === 'タグ: alpha' && JSON.stringify(await titles(page)) === JSON.stringify(['T0']), await tagBtn(page));

// 特殊文字のタグ名でも、行とボタンの title が壊れない
await open(page, [bm(0, { tags: ['<b>&"'] })]);
const specialRows = await panelRows(page, 'tag-popover');
await page.click('#tag-filter-btn');
await page.locator('#tag-popover .filter-row').nth(1).click();
tb = await tagBtn(page);
check('特殊文字のタグ名がパネルの行とボタンにそのまま出る', specialRows[1] === '<b>&":1' && tb.title === 'タグ: <b>&"' && tb.text === 'タグ: <b>&"', { specialRows, tb });

// タグが多いときは、パネルの中でスクロールする
await open(page, [bm(0, { tags: Array.from({ length: 60 }, (_, i) => 'tag' + i) })]);
await page.click('#tag-filter-btn');
const pop = await page.$eval('#tag-popover', (e) => ({ h: e.getBoundingClientRect().height, vh: window.innerHeight, sh: e.scrollHeight, ch: e.clientHeight }));
check('タグが 60 個でも、パネルは画面に収まりスクロールできる', pop.h <= pop.vh && pop.sh > pop.ch, pop);

// 「グループなし」を選ぶと、グループの無い行だけになり、ボタンが「グループ: グループなし」
await open(page, [bm(0, { groupName: 'g' }), bm(1)]);
await page.click('#group-filter-btn');
await page.click('#group-popover [data-filter-none]');
check('「グループなし」を選ぶと、グループの無い行だけ', JSON.stringify(await titles(page)) === JSON.stringify(['T1']) && (await page.$eval('#group-filter-btn', (e) => e.textContent)) === 'グループ: グループなし', await titles(page));

// ===== グループの色(タグの色とは別に持つ) =====
const styleH = (p, sel) => p.$eval(sel, (e) => e.style.getPropertyValue('--h').trim());
// colors はグループの色の保存値(省略時は消す)。タグの色は消す
async function openColors(p, data, colors) {
  await open(p, data);
  await p.evaluate((c) => {
    localStorage.removeItem('bookmarks_tag_colors');
    if (c) localStorage.setItem('bookmarks_group_colors', JSON.stringify(c)); else localStorage.removeItem('bookmarks_group_colors');
  }, colors);
  await p.reload();
}
async function openGroupManage(p) {
  await p.click('#tag-manage-open-btn');
  await p.click('[data-manage-tab="group"]');
}
const colorBtn = (key) => '#tag-manage-list .tag-manage-row[data-tag="' + key + '"] .tag-color-btn';
async function slide(p, hue) {
  await p.$eval('#tag-manage-list .tag-color-range', (e, h) => {
    e.value = String(h);
    e.dispatchEvent(new Event('input', { bubbles: true }));
    e.dispatchEvent(new Event('change', { bubbles: true }));
  }, hue);
}

// (a) グループのタブの色の丸・基本の色・「自動」・スライダー
await openColors(page, [bm(0, { groupName: 'g' }), bm(1, { groupName: 'h' })]);
await openGroupManage(page);
check('グループの行に色の丸がある', (await page.$(colorBtn('g'))) !== null);
await page.click(colorBtn('g'));
check('グループの色の丸を押すと、色の選択が開く', (await page.$$('#tag-manage-list .tag-color-swatch')).length === 12);
await page.click('#tag-manage-list .tag-color-swatch[data-hue="140"]');
const gc1 = await storedJson(page, 'bookmarks_group_colors');
check('基本の色を選ぶと、丸の色が変わり、bookmarks_group_colors に保存され、区画も同じ色', (await styleH(page, colorBtn('g'))) === '140' && JSON.stringify(gc1) === JSON.stringify({ g: 140 }) && (await styleH(page, '.tag-group[data-group="g"]')) === '140', gc1);
await page.click('#tag-manage-list [data-action="auto-tag-color"]');
check('「自動」で、キーが bookmarks_group_colors から消える', JSON.stringify(await storedJson(page, 'bookmarks_group_colors')) === JSON.stringify({}), await storedJson(page, 'bookmarks_group_colors'));
await slide(page, 77);
check('スライダーを離すと、グループの色が保存される', JSON.stringify(await storedJson(page, 'bookmarks_group_colors')) === JSON.stringify({ g: 77 }) && (await styleH(page, '.tag-group[data-group="g"]')) === '77', await storedJson(page, 'bookmarks_group_colors'));

// (g) 色の選択を開いている間は、その行の draggable が外れる。Escape は色の選択だけを閉じる
const dragOf = (key) => page.$eval('#tag-manage-list .tag-manage-row[data-tag="' + key + '"]', (e) => e.getAttribute('draggable'));
check('色の選択を開いている行は draggable が外れる(ほかの行はそのまま)', (await dragOf('g')) === null && (await dragOf('h')) === 'true');
await page.click(colorBtn('g'));
check('色の選択を閉じると draggable が戻る', (await dragOf('g')) === 'true' && (await page.$$('#tag-manage-list .tag-color-picker')).length === 0);
await page.click(colorBtn('g'));
await page.keyboard.press('Escape');
check('Escape で色の選択だけが閉じる(モーダルは開いたまま)', (await page.$$('#tag-manage-list .tag-color-picker')).length === 0 && !(await page.$eval('#tag-manage-overlay', (e) => e.hidden)) && (await dragOf('g')) === 'true');

// 管理モーダルのタブを替えると、開いていた色の選択は閉じる(タグとグループのキーが同じでも、選択の状態が混ざらない)
await openColors(page, [bm(0, { groupName: 'same', tags: ['same'] })]);
await openGroupManage(page);
await page.click(colorBtn('same'));
await page.click('[data-manage-tab="tag"]');
check('グループの色の選択を開いたままタグのタブへ替えると、色の選択は閉じている', (await page.$$('#tag-manage-list .tag-color-picker')).length === 0);
await page.click(colorBtn('same'));
await page.click('[data-manage-tab="group"]');
check('タグの色の選択を開いたままグループのタブへ替えると、色の選択は閉じている', (await page.$$('#tag-manage-list .tag-color-picker')).length === 0);

// (b) 同名のタグとグループの色は、互いに影響しない
await openColors(page, [bm(0, { groupName: 'same', tags: ['same'] })]);
await page.click('#tag-filter-btn');
const sameTagHue = await styleH(page, '#tag-popover [data-filter-key="same"]');
await page.keyboard.press('Escape');
await openGroupManage(page);
await page.click(colorBtn('same'));
await slide(page, 100);
await page.keyboard.press('Escape');
await page.keyboard.press('Escape');
await page.click('#tag-filter-btn');
check('グループの色を変えても、同名のタグの色は変わらない', (await page.evaluate(() => localStorage.getItem('bookmarks_tag_colors'))) === null && (await styleH(page, '#tag-popover [data-filter-key="same"]')) === sameTagHue, sameTagHue);
await page.keyboard.press('Escape');
await page.click('#group-filter-btn');
check('グループのパネルの色の点は、グループの色', (await styleH(page, '#group-popover [data-filter-key="same"]')) === '100');
await page.keyboard.press('Escape');
await page.click('#tag-manage-open-btn');
await page.click('[data-manage-tab="tag"]');
await page.click(colorBtn('same'));
await slide(page, 200);
check('タグの色を変えても、同名のグループの区画の色は変わらない', (await styleH(page, '.tag-group[data-group="same"]')) === '100' && JSON.stringify(await storedJson(page, 'bookmarks_tag_colors')) === JSON.stringify({ same: 200 }) && JSON.stringify(await storedJson(page, 'bookmarks_group_colors')) === JSON.stringify({ same: 100 }));

// (c) 改名で色が新しいキーへ移る。統合では既存の色が残る。削除・最後の 1 件の移動で消える
async function renameGroupTo(p, key, name) {
  await p.click('#tag-manage-list [data-action="edit-tag"][data-tag="' + key + '"]');
  await p.fill('.tag-rename-input', name);
  await p.click('.tag-rename-form button[type=submit]');
  await p.click('[data-action="apply-rename"]');
}
await openColors(page, [bm(0, { groupName: 'a' }), bm(1, { groupName: 'b' }), bm(2, { groupName: 'c' })], { a: 10, b: 20, c: 30 });
await openGroupManage(page);
await renameGroupTo(page, 'c', 'd');
check('グループの改名で、色が新しいキーへ移る', JSON.stringify(await storedJson(page, 'bookmarks_group_colors')) === JSON.stringify({ a: 10, b: 20, d: 30 }), await storedJson(page, 'bookmarks_group_colors'));
await renameGroupTo(page, 'd', 'A');
check('統合では、既存のグループの色が残る', JSON.stringify(await storedJson(page, 'bookmarks_group_colors')) === JSON.stringify({ a: 10, b: 20 }), await storedJson(page, 'bookmarks_group_colors'));
await page.click('#tag-manage-list [data-action="delete-tag"][data-tag="b"]');
await page.click('[data-action="confirm-delete-tag"]');
check('グループの削除で、色が消える', JSON.stringify(await storedJson(page, 'bookmarks_group_colors')) === JSON.stringify({ a: 10 }), await storedJson(page, 'bookmarks_group_colors'));
await openColors(page, [bm(0, { groupName: 'a' }), bm(1, { groupName: 'x' })], { a: 10, x: 5 });
await page.click('.tag-group[data-group="x"] .card--list [data-action="edit"]');
await page.fill('#edit-group-text', 'a');
await page.click('[data-edit-form] button[type=submit]');
check('最後の 1 件が別のグループへ移ると、色が消える', JSON.stringify(await storedJson(page, 'bookmarks_group_colors')) === JSON.stringify({ a: 10 }), await storedJson(page, 'bookmarks_group_colors'));

// (d) エクスポート・インポート
await openColors(page, [bm(0, { groupName: 'g' })], { g: 42 });
const [dlC] = await Promise.all([page.waitForEvent('download'), page.click('#export-btn')]);
const exportedC = JSON.parse(await (await import('node:fs/promises')).readFile(await dlC.path(), 'utf8'));
check('エクスポートに groupColors が入る', JSON.stringify(exportedC.groupColors) === JSON.stringify({ g: 42 }), exportedC.groupColors);
await importJson(page, { version: 4, bookmarks: ['a', 'b', 'c', 'd', 'e'].map((g, i) => bm(i, { groupName: g })), groupColors: { a: 400, b: -10, c: 'x', d: null, e: 120 } });
check('インポートした groupColors は整えて保存される', JSON.stringify(await storedJson(page, 'bookmarks_group_colors')) === JSON.stringify({ a: 40, b: 350, e: 120 }), await storedJson(page, 'bookmarks_group_colors'));
await importJson(page, { version: 4, bookmarks: [bm(0, { groupName: 'a' })] });
check('groupColors の無いファイルをインポートすると、グループの色は空', JSON.stringify(await storedJson(page, 'bookmarks_group_colors')) === JSON.stringify({}), await storedJson(page, 'bookmarks_group_colors'));

// (e) storage イベントで、別のタブのグループの色を取り込む
await openColors(page, [bm(0, { groupName: 'g' })]);
await page.evaluate(() => {
  localStorage.setItem('bookmarks_group_colors', JSON.stringify({ g: 50 }));
  window.dispatchEvent(new StorageEvent('storage', { key: 'bookmarks_group_colors' }));
});
check('storage イベントで、グループの色を取り込む', (await styleH(page, '.tag-group[data-group="g"]')) === '50');

// (f) 特殊文字のグループ名でも、色の丸とパネルの行が壊れない
await openColors(page, [bm(0, { groupName: '<b>&"' })]);
await page.click('#group-filter-btn');
const specialG = await page.$eval('#group-popover [data-filter-key] .filter-row-name', (e) => e.textContent);
await page.keyboard.press('Escape');
await openGroupManage(page);
const specialLabel = await page.$eval('#tag-manage-list .tag-color-btn', (e) => e.getAttribute('aria-label'));
await page.click('#tag-manage-list .tag-color-btn');
const specialRange = await page.$eval('#tag-manage-list .tag-color-range', (e) => e.getAttribute('aria-label'));
check('特殊文字のグループ名で、色の丸・スライダー・パネルの行が壊れない', specialG === '<b>&"' && specialLabel === '<b>&"の色を選ぶ' && specialRange === '<b>&"の色相', { specialG, specialLabel, specialRange });

// ===== タイル/リストの切り替え =====
const modeOf = (p) => p.$eval('#bookmark-list', (e) => (e.classList.contains('list-mode') ? 'list' : '') + (e.classList.contains('tile-mode') ? 'tile' : ''));
const pressed = (p, id) => p.$eval(id, (e) => e.getAttribute('aria-pressed'));
await open(page, [bm(0), bm(1), bm(2)]);
check('表示は既定でタイル', (await modeOf(page)) === 'tile' && (await pressed(page, '#layout-tile-btn')) === 'true' && (await pressed(page, '#layout-list-btn')) === 'false', await modeOf(page));
const dataBefore = await page.evaluate(() => localStorage.getItem('bookmarks_data'));
await page.click('#layout-list-btn');
check('リストに切り替えると保存される', (await modeOf(page)) === 'list' && (await page.evaluate(() => localStorage.getItem('bookmarks_layout'))) === 'list');
check('切り替えでデータは変わらない', (await page.evaluate(() => localStorage.getItem('bookmarks_data'))) === dataBefore);
await page.reload();
check('再読み込みしてもリスト', (await modeOf(page)) === 'list' && (await pressed(page, '#layout-list-btn')) === 'true');
await page.click('#layout-tile-btn');
check('タイルへ戻すと保存される', (await modeOf(page)) === 'tile' && (await page.evaluate(() => localStorage.getItem('bookmarks_layout'))) === 'tile');
await page.evaluate(() => localStorage.setItem('bookmarks_layout', 'zzz'));
await page.reload();
check('保存された値が不正ならタイル', (await modeOf(page)) === 'tile');
{
  const p2 = await ctx.newPage();
  await p2.addInitScript(() => {
    const orig = Storage.prototype.getItem;
    Storage.prototype.getItem = function (k) { if (k === 'bookmarks_layout') throw new Error('blocked'); return orig.call(this, k); };
  });
  await p2.goto(URL_);
  check('localStorage が読めなくてもタイルで動く', (await modeOf(p2)) === 'tile' && (await titles(p2)).length === 3, await titles(p2));
  await p2.close();
}
await page.click('#layout-list-btn');
await page.locator('.card--list [data-action="edit"]').first().click();
await page.fill('#edit-memo', 'draft');
await page.click('#layout-tile-btn');
await page.click('#layout-list-btn');
const editW = await page.evaluate(() => { const f = document.querySelector('#edit-memo').closest('.card'); return [Math.round(f.getBoundingClientRect().width), Math.round(f.parentElement.getBoundingClientRect().width)]; });
check('編集フォームを開いたまま切り替えても入力が残り、全幅のまま', (await page.$eval('#edit-memo', (e) => e.value)) === 'draft' && Math.abs(editW[0] - editW[1]) <= 2, editW);
{
  const errs = [];
  const p3 = await ctx.newPage();
  p3.on('pageerror', (e) => errs.push(String(e)));
  await open(p3, []);
  await p3.click('#layout-list-btn');
  await p3.click('#layout-tile-btn');
  check('0 件でも切り替えられる', errs.length === 0 && (await p3.$eval('#bookmark-list', (e) => e.textContent)).includes('ブックマークがありません'), errs);
  await p3.close();
}

// ===== リスト表示の見た目・タグの「+N」・ドラッグ =====
const manyTags = Array.from({ length: 12 }, (_, i) => 'タグ名その' + i);
const listData = [
  bm(0, { groupName: 'g1', title: 'L'.repeat(80), memo: 'M'.repeat(200), tags: manyTags }),
  bm(1, { groupName: 'g1', title: 'T1' }),
  bm(2, { groupName: 'g1', title: 'T2' }),
  bm(3, { groupName: 'g2', title: 'T3' })
];
await open(page, listData);
const colCount = () => page.$eval('.tag-group', (e) => getComputedStyle(e).gridTemplateColumns.split(' ').length);
check('タイルは、区画が複数列', (await colCount()) >= 2, await colCount());
await page.click('#layout-list-btn');
check('リストは、区画が1列', (await colCount()) === 1, await colCount());
const longH = await page.$eval('.card--list', (e) => Math.round(e.getBoundingClientRect().height));
check('リストは、長いタイトル・メモ・多数のタグの行も 80px 以下', longH <= 80, longH);
const tagRows = await page.$eval('.card--list .row-tags', (box) => {
  const vis = [...box.querySelectorAll('.row-tag')].filter((t) => !t.hidden);
  const more = box.querySelector('.row-tag-more');
  const hiddenN = box.querySelectorAll('.row-tag[hidden]').length;
  return { tops: [...new Set(vis.concat(more ? [more] : []).map((e) => e.offsetTop))].length, more: more ? more.textContent : null, hiddenN };
});
check('リストのタグは1行で、溢れは +N', tagRows.tops === 1 && tagRows.hiddenN > 0 && tagRows.more === '+' + tagRows.hiddenN, tagRows);
const noOverflow = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
check('リストでもページが横にはみ出さない(1280px)', await noOverflow());
const rowH = (i) => page.$$eval('.card--list', (els, k) => Math.round(els[k].getBoundingClientRect().height), i);
const h1280 = await rowH(1);
check('リスト(幅 1280px。区画の幅 780px 以下)は、メモがタイトルの下の2段で、80px 以下', h1280 > 48 && h1280 <= 80, h1280);
check('リスト(幅 1280px)でも、メモが見える(幅がある)', await page.$eval('.card--list .row-memo-preview', (e) => e.getBoundingClientRect().width > 100));
await page.setViewportSize({ width: 600, height: 800 });
check('リストは幅 600px でも横にはみ出さない', await noOverflow());
await page.setViewportSize({ width: 400, height: 800 });
check('リストは幅 400px でも横にはみ出さず、行がさらに高くなる(3段)', (await noOverflow()) && (await rowH(1)) > h1280, { h1280, h400: await rowH(1) });
await page.setViewportSize({ width: 1900, height: 900 });
const wide = await page.$eval('.card--list', (c) => {
  const r = (sel) => c.querySelector(sel).getBoundingClientRect();
  return { h: Math.round(c.getBoundingClientRect().height), sameLine: Math.abs(r('.card-title').top - r('.row-memo-preview').top) < 8 };
});
check('リストは、広いと1行(タイトルとメモが同じ行で、48px 以下)', wide.h <= 56 && wide.sameLine, wide);
await page.setViewportSize({ width: 1280, height: 720 });
await page.click('#layout-tile-btn');
const tileTagInfo = await page.$eval('.card--list .row-tags', (box) => ({ hidden: box.querySelectorAll('.row-tag[hidden]').length }));
check('タイルに戻すと、タグは3行基準に戻る', tileTagInfo.hidden < tagRows.hiddenN, { tileTagInfo, tagRows });
await page.click('#layout-list-btn');
await page.fill('#search-input', 'T');
check('検索中のリストは、グリップが出ず、横にはみ出さない', (await page.$$('.row-grip')).length === 0 && (await noOverflow()));
await page.fill('#search-input', '');
await page.press('#search-input', 'Escape');
// ドラッグ(同じ区画 g1 の中): T1 を T2 の下半分へ → L..., T2, T1
// locator.dragTo は、同じページで続けて使うと、2回目以降に別の行を掴むことがある。マウスを直接動かす
const dragCard = async (srcTitle, dstTitle, yRatio, xRatio) => {
  const sb = await page.locator('.card--list', { hasText: srcTitle }).first().boundingBox();
  const db = await page.locator('.card--list', { hasText: dstTitle }).first().boundingBox();
  await page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2);
  await page.mouse.down();
  await page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2 + 5, { steps: 3 });
  await page.mouse.move(db.x + db.width * xRatio, db.y + db.height * yRatio, { steps: 10 });
  await page.mouse.up();
};
await dragCard('T1', 'T2', 0.75, 0.5);
const orderAfter = async () => (await titles(page)).map((t) => (t.length > 10 ? 'L' : t));
check('リストで、下半分に落とすと直後に入り、順が保存される', JSON.stringify(await orderAfter()) === JSON.stringify(['L', 'T2', 'T1', 'T3']) && JSON.stringify((await storedJson(page, 'bookmarks_data')).map((b) => b.title.length > 10 ? 'L' : b.title)) === JSON.stringify(['L', 'T2', 'T1', 'T3']), { ui: await orderAfter() });
await dragCard('T1', 'T2', 0.25, 0.5);
check('リストで、上半分に落とすと直前に入る', JSON.stringify(await orderAfter()) === JSON.stringify(['L', 'T1', 'T2', 'T3']), await orderAfter());
await page.click('#layout-tile-btn');
// タイルは幅 1280px で 2 列(L と T1 が 1 行目)。画面内の L と T1 で、左右の判定を確かめる
await dragCard('T1', 'LLLLL', 0.5, 0.2);
check('タイルは、左半分に落とすと直前に入る(左右で判定)', JSON.stringify(await orderAfter()) === JSON.stringify(['T1', 'L', 'T2', 'T3']), await orderAfter());
await dragCard('T1', 'LLLLL', 0.5, 0.8);
check('タイルは、右半分に落とすと直後に入る(左右で判定)', JSON.stringify(await orderAfter()) === JSON.stringify(['L', 'T1', 'T2', 'T3']), await orderAfter());

// ===== 最終レビューの指摘 =====
// (1) タイルのままでも、幅 1280px でヘッダーが1行のまま(切り替えボタンで2行に折り返さない)
await open(page, [bm(0), bm(1)]);
await page.setViewportSize({ width: 1280, height: 720 });
check('幅 1280px で、ヘッダーは1行(切り替えボタンを足しても折り返さない)', (await page.$eval('.app-header', (e) => Math.round(e.getBoundingClientRect().height))) < 100, await page.$eval('.app-header', (e) => e.getBoundingClientRect().height));
check('切り替えボタンは、件数表示の行にある', (await page.$('.list-toolbar #layout-tile-btn')) !== null && (await page.$('.list-toolbar #layout-list-btn')) !== null);
// (2) リストのドラッグ中の位置表示は、上下の線(上半分で上、下半分で下)
await page.click('#layout-list-btn');
{
  const sb = await page.locator('.card--list', { hasText: 'T1' }).first().boundingBox();
  const db = await page.locator('.card--list', { hasText: 'T0' }).first().boundingBox();
  await page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2);
  await page.mouse.down();
  await page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2 - 5, { steps: 3 });
  await page.mouse.move(db.x + db.width / 2, db.y + db.height * 0.2, { steps: 10 });
  await page.waitForTimeout(300); // box-shadow のトランジション(0.15s)が終わるのを待つ
  const shadowTop = await page.$eval('.card--list.drop-before', (e) => getComputedStyle(e).boxShadow).catch(() => null);
  await page.mouse.move(db.x + db.width / 2, db.y + db.height * 0.8, { steps: 4 });
  await page.waitForTimeout(300);
  const shadowBottom = await page.$eval('.card--list.drop-after', (e) => getComputedStyle(e).boxShadow).catch(() => null);
  await page.mouse.up();
  check('リストのドラッグ中の線は、上半分で上、下半分で下', !!shadowTop && !!shadowBottom && /0px 3px 0px 0px inset/.test(shadowTop) && /0px -3px 0px 0px inset/.test(shadowBottom), { shadowTop, shadowBottom });
}
// (3) 先頭のタグが長くても、リストの行は他の行と同じ高さ
await open(page, [bm(0, { tags: ['とてもとても長いタグの名前がここに入ります。四十文字を超える長さです。四十文字を超える長さです', 'b', 'c'] }), bm(1, { tags: ['b'] })]);
await page.click('#layout-list-btn');
const hs = await page.$$eval('.card--list', (els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
check('リストは、先頭のタグが長くても、行の高さが揃う', hs[0] === hs[1] && (await noOverflow()), hs);
// (4) 操作アイコンが5個の行でも、タイトルが 120px 以上
await open(page, [bm(0, { title: 'ログインのある行', loginId: 'u', loginPassword: 'p', scheme: 'file', url: 'file:///C:/a.txt', domain: null, tags: ['タグ'] })]);
await page.click('#layout-list-btn');
check('リストは、操作アイコンが5個でも、タイトルが 120px 以上', (await page.$eval('.card--list .card-title', (e) => Math.round(e.getBoundingClientRect().width))) >= 120, await page.$eval('.card--list .card-title', (e) => Math.round(e.getBoundingClientRect().width)));

// ===== まとめて付け外し(B: 管理モーダルのチェックリスト) =====
await page.setViewportSize({ width: 1280, height: 720 });
const openManage = async (p, tab) => { await p.click('#tag-manage-open-btn'); await p.click('[data-manage-tab="' + tab + '"]'); };
const bulkStored = (p) => p.evaluate(() => JSON.parse(localStorage.getItem('bookmarks_data')));
const checkedIds = (p) => p.$$eval('#bulk-list input[type=checkbox]:checked', (els) => els.map((e) => e.dataset.id));
const bulkData = () => [bm(0, { tags: ['仕事'] }), bm(1, { tags: ['仕事'] }), bm(2), bm(3)];
const bulkOpen = (p, key) => p.click('[data-action="bulk-open"][data-tag="' + key + '"]');
const toggleId = (p, id) => p.click('#bulk-list input[data-id="' + id + '"]');
await open(page, bulkData());
await openManage(page, 'tag');
await bulkOpen(page, '仕事');
check('タグの行に「付け外し」があり、開くと付いている件だけがオン', JSON.stringify(await checkedIds(page)) === JSON.stringify(['i0', 'i1']) && (await page.$$('#bulk-list input[type=checkbox]')).length === 4 && !(await page.$eval('#bulk-picker', (e) => e.hidden)) && (await page.$eval('#tag-manage-list', (e) => e.hidden || getComputedStyle(e).display === 'none')), await checkedIds(page));
const dataOpened = JSON.stringify(await bulkStored(page));
check('チェックを変えるまで、要約は 0 で適用できない', (await page.$eval('#bulk-apply', (e) => e.disabled)) && JSON.stringify(await bulkStored(page)) === dataOpened);
await toggleId(page, 'i2'); await toggleId(page, 'i3'); await toggleId(page, 'i0');
check('要約は、実際に変わる件だけを数える', (await page.$eval('#bulk-summary', (e) => e.textContent)).includes('「仕事」を 2 件に付け、1 件から外します'), await page.$eval('#bulk-summary', (e) => e.textContent));
check('適用するまで、データは変わらない', JSON.stringify(await bulkStored(page)) === dataOpened);
await page.click('#bulk-apply');
const afterApply = await bulkStored(page);
const tagsOf = (d, id) => JSON.stringify(d.find((b) => b.id === id).tags);
check('適用すると、チェックしたとおりになり、ほかは変わらない', tagsOf(afterApply, 'i0') === '[]' && tagsOf(afterApply, 'i1') === '["仕事"]' && tagsOf(afterApply, 'i2') === '["仕事"]' && tagsOf(afterApply, 'i3') === '["仕事"]' && afterApply.every((b, i) => b.title === 'T' + i && b.order === i), afterApply);
check('適用後は一覧の画面に戻り、結果が出る', (await page.$eval('#bulk-picker', (e) => e.hidden)) && (await page.$eval('#bulk-result', (e) => e.textContent)).includes('「仕事」を 2 件に付け、1 件から外しました'));
{
  const before = JSON.parse(dataOpened), changed = afterApply.filter((b, i) => JSON.stringify(b.tags) !== JSON.stringify(before[i].tags)).length;
  check('要約の件数と、実際に変わった件数が一致する', changed === 3, changed);
}
await bulkOpen(page, '仕事');
await toggleId(page, 'i1');
await page.click('#bulk-cancel');
check('キャンセルで何も変わらない', JSON.stringify(await bulkStored(page)) === JSON.stringify(afterApply) && (await page.$eval('#bulk-picker', (e) => e.hidden)));
await bulkOpen(page, '仕事');
await page.keyboard.press('Escape');
check('Escape で、チェックリストだけが閉じる(モーダルは開いたまま)', (await page.$eval('#bulk-picker', (e) => e.hidden)) && !(await page.$eval('#tag-manage-overlay', (e) => e.hidden)));
await bulkOpen(page, '仕事');
await page.click('[data-manage-tab="group"]');
check('タブを替えると、チェックリストは閉じる', await page.$eval('#bulk-picker', (e) => e.hidden));
await page.click('[data-manage-tab="tag"]');
await bulkOpen(page, '仕事');
await page.type('#bulk-search', 'T1', { delay: 20 });
check('検索の入力中に、再描画されても、入力とフォーカスが残る', (await page.$eval('#bulk-search', (e) => e.value)) === 'T1' && (await page.evaluate(() => document.activeElement && document.activeElement.id)) === 'bulk-search');
await page.click('#bulk-none');
await page.fill('#bulk-search', '');
await page.click('#bulk-all');
check('「表示中を全選択」は、表示中だけをオンにする(検索で絞った分)', (await checkedIds(page)).length === 4);
await page.fill('#bulk-search', 'T1');
await page.click('#bulk-none');
await page.fill('#bulk-search', '');
check('「表示中を全解除」は、表示中だけをオフにする', JSON.stringify(await checkedIds(page)) === JSON.stringify(['i0', 'i2', 'i3']), await checkedIds(page));
await page.click('#bulk-cancel');
await open(page, bulkData());
await openManage(page, 'tag');
await bulkOpen(page, '仕事');
await toggleId(page, 'i0'); await toggleId(page, 'i1');
await page.click('#bulk-apply');
check('全件から外すと、タグの行が消えて一覧の画面に戻る', (await page.$$('#tag-manage-list [data-tag="仕事"]')).length === 0 && (await page.$eval('#bulk-result', (e) => e.textContent)).includes('2 件から外しました'));
await open(page, Array.from({ length: 500 }, (_, i) => bm(i, i === 0 ? { tags: ['x'] } : {})));
await openManage(page, 'tag');
await bulkOpen(page, 'x');
const t500 = Date.now();
await page.click('#bulk-all');
await page.click('#bulk-apply');
await page.waitForSelector('#bulk-picker', { state: 'hidden' });
check('500 件でも、全選択と適用が 2 秒以内', Date.now() - t500 <= 2000 && (await bulkStored(page)).every((b) => b.tags.includes('x')), Date.now() - t500);

// ----- グループ(B) -----
const groupData = () => [bm(0, { groupName: '社内' }), bm(1, { groupName: '社内' }), bm(2, { groupName: '個人' }), bm(3)];
const groupOf = (d, id) => d.find((b) => b.id === id).groupName;
await open(page, groupData());
await openManage(page, 'group');
await bulkOpen(page, '社内');
check('グループの行の「付け外し」で、そのグループの件だけがオン', JSON.stringify(await checkedIds(page)) === JSON.stringify(['i0', 'i1']), await checkedIds(page));
await toggleId(page, 'i2');
const moveNote = await page.$eval('#bulk-list .bulk-row[data-id="i2"]', (e) => e.textContent);
const sumMove = await page.$eval('#bulk-summary', (e) => e.textContent);
await toggleId(page, 'i3');
const sumMove2 = await page.$eval('#bulk-summary', (e) => e.textContent);
check('別のグループの件をオンにすると、注記と「移る」の件数が出る(グループなしは移るに数えない)', moveNote.includes('「個人」から移る') && sumMove.includes('うち 1 件は、別のグループから移ります') && sumMove2.includes('「社内」を 2 件に付けます') && sumMove2.includes('うち 1 件は、別のグループから移ります'), { moveNote, sumMove, sumMove2 });
await toggleId(page, 'i0');
const gBefore = JSON.stringify(await bulkStored(page));
await page.click('#bulk-apply');
const gAfter = await bulkStored(page);
check('適用すると、groupName が置き換わり、ほかのフィールドは変わらない', groupOf(gAfter, 'i0') === '' && groupOf(gAfter, 'i1') === '社内' && groupOf(gAfter, 'i2') === '社内' && groupOf(gAfter, 'i3') === '社内' && gAfter.every((b, i) => b.order === i && JSON.stringify(b.tags) === '[]' && b.title === 'T' + i), gAfter);
check('適用後、移った件の区画が替わる', (await page.$$('.tag-group[data-group="個人"]')).length === 0 && (await page.$$('.tag-group[data-group="社内"] .card--list')).length === 3);
await open(page, groupData());
await openManage(page, 'group');
await bulkOpen(page, '社内');
await toggleId(page, 'i0'); await toggleId(page, 'i1');
await page.click('#bulk-apply');
const gOff = await bulkStored(page);
check('オフにしても、別のグループの件には影響せず、外した件はグループなしになる', groupOf(gOff, 'i0') === '' && groupOf(gOff, 'i1') === '' && groupOf(gOff, 'i2') === '個人' && groupOf(gOff, 'i3') === '', gOff.map((b) => b.groupName));
check('グループを全件から外すと、区画が消え、管理の行も消える', (await page.$$('.tag-group[data-group="社内"]')).length === 0 && (await page.$$('#tag-manage-list [data-tag="社内"]')).length === 0);
await open(page, [bm(0, { groupName: 'Work' }), bm(1), bm(2, { groupName: 'work' })]);
await openManage(page, 'group');
await bulkOpen(page, 'work');
await toggleId(page, 'i1');
await page.click('#bulk-apply');
check('グループ名の表記は、既存に合わせる', JSON.stringify((await bulkStored(page)).map((b) => b.groupName)) === JSON.stringify(['Work', 'Work', 'Work']), (await bulkStored(page)).map((b) => b.groupName));

await browser.close();
console.log(failed ? failed + ' 件失敗' : 'すべて成功');
process.exit(failed ? 1 : 0);
