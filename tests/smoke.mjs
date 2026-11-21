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

// 8: 短い英字のタグは、単語として含まれるときだけ付く
await open(page, [bm(0, { tags: ['ai'] })]);
await page.click('#toggle-add-btn');
await page.fill('#new-url', 'https://mail.google.com');
check('"ai" は mail に付かない', (await page.$eval('#new-tag-chips', (e) => e.textContent.trim())) === '');
await page.fill('#new-url', 'https://ai.example.com');
check('"ai" は ai.example.com に付く', (await page.$eval('#new-tag-chips', (e) => e.textContent.trim())).startsWith('ai'));

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
check('貼り付けでタグの事前選択が更新される', (await page.$eval('#new-tag-chips', (e) => e.textContent.trim())).startsWith('ai'));

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
check('表示用コードがリンクと同じ', shownCode !== null && href === 'javascript:' + shownCode, { shownCode });

// 実際のページでコードを動かし、クリップボードの内容をアプリへ貼る(外部通信なし。ページは route で返す)
await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
await ctx.route('https://page.test/**', (r) => r.fulfill({ contentType: 'text/html', body: '<title>  Foo \n Bar </title><p>x</p>' }));
const src = await ctx.newPage();
await src.goto('https://page.test/');
await src.bringToFront();
await src.evaluate(shownCode || '');
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

// アプリのタブに戻ったとき、クリップボードの「タイトル+改行+URL」を追加フォームへ入れる
const setClip = (p, text) => p.evaluate((t) => navigator.clipboard.writeText(t), text);
const refocus = async (p) => { await p.evaluate(() => window.dispatchEvent(new Event('focus'))); await p.waitForTimeout(250); };
const addPanelOpen = (p) => p.$eval('#add-panel', (e) => !e.hidden);
const VALID = 'Example Domain\r\nhttps://example.com/';

await open(page, []);
await setClip(page, VALID);
await refocus(page);
f = await fields(page);
check('戻ったとき、2行のクリップボードが追加フォームに入る', (await addPanelOpen(page)) && f.url === 'https://example.com/' && f.title === 'Example Domain', f);

await page.evaluate(() => { document.getElementById('new-url').value = ''; document.getElementById('new-title').value = ''; });
await refocus(page);
f = await fields(page);
check('同じ内容は2回入れない', f.url === '' && f.title === '', f);

await open(page, [bm(0, { tags: ['ai'] })]);
await setClip(page, 'ai の記事\nhttps://x.example.com/');
await refocus(page);
check('戻ったとき、タグの事前選択も更新される', (await page.$eval('#new-tag-chips', (e) => e.textContent.trim())).startsWith('ai'));

await open(page, []);
await setClip(page, 'hello');
await refocus(page);
f = await fields(page);
check('形に合わない内容は何もしない', !(await addPanelOpen(page)) && f.url === '' && f.title === '', f);
await setClip(page, '');
await refocus(page);
check('空のクリップボードは何もしない', !(await addPanelOpen(page)));

await freshAddForm(page);
await page.fill('#new-url', 'https://typed.example/');
await setClip(page, 'Late Title\nhttps://other.example/');
await refocus(page);
f = await fields(page);
check('URL 欄に入力中なら何もしない', f.url === 'https://typed.example/' && f.title !== 'Late Title', f);

await freshAddForm(page);
await page.fill('#new-title', 'mine');
await setClip(page, 'Late Title 2\nhttps://other2.example/');
await refocus(page);
f = await fields(page);
check('タイトル欄に入力中なら何もしない', f.url === '' && f.title === 'mine', f);

await open(page, []);
await setClip(page, 'Twice\nhttps://twice.example/');
await page.evaluate(() => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); });
await page.waitForTimeout(300);
f = await fields(page);
check('focus と visibilitychange が続けて発火しても1回分', (await addPanelOpen(page)) && f.url === 'https://twice.example/' && f.title === 'Twice', f);

await freshAddForm(page);
await page.evaluate(() => { navigator.clipboard.readText = () => new Promise((r) => setTimeout(() => r('Slow\nhttps://slow.example/'), 300)); });
await page.evaluate(() => window.dispatchEvent(new Event('focus')));
await page.waitForTimeout(100);
await page.fill('#new-url', 'typed');
await page.waitForTimeout(500);
f = await fields(page);
check('読み取り中に入力を始めたら、何もしない', f.url === 'typed' && f.title === '', f);

await open(page, []);
await setClip(page, 'Help Open\nhttps://help.example/');
await page.click('#help-btn');
await refocus(page);
check('ヘルプが開いているときは何もしない', !(await addPanelOpen(page)));

await open(page, [bm(0)]);
await page.click('[data-action="edit"]');
await setClip(page, 'Editing\nhttps://editing.example/');
await refocus(page);
check('編集中は何もしない', !(await addPanelOpen(page)));

// レビューの指摘: 保存せずに閉じても新しい内容が入る/手で直したら置き換えない/貼り付けて保存した直後は入れ直さない
await open(page, []);
await setClip(page, 'B\nhttps://b.example/');
await refocus(page);
await page.click('#toggle-add-btn'); // 保存せずに閉じる(欄の値は残る)
await setClip(page, 'C\nhttps://c.example/');
await refocus(page);
f = await fields(page);
check('保存せずに閉じても、新しい内容が入る', (await addPanelOpen(page)) && f.url === 'https://c.example/' && f.title === 'C', f);

await page.evaluate(() => { document.getElementById('new-title').value = 'edited'; });
await setClip(page, 'D\nhttps://d.example/');
await refocus(page);
f = await fields(page);
check('自動で入れた値を手で直したら、置き換えない', f.url === 'https://c.example/' && f.title === 'edited', f);

await open(page, []);
await page.click('#toggle-add-btn');
await paste(page, 'P\nhttps://p.example/');
await page.click('#add-form button[type=submit]');
await setClip(page, 'P\nhttps://p.example/');
await refocus(page);
f = await fields(page);
check('貼り付けて保存した直後は、同じ内容を入れ直さない', !(await addPanelOpen(page)) && f.url === '' && f.title === '', f);

const ctx2 = await browser.newContext(); // クリップボードの許可なし
const denied = await ctx2.newPage();
const deniedErrors = [];
denied.on('pageerror', (e) => deniedErrors.push(String(e)));
await open(denied, []);
await refocus(denied);
check('読み取りが拒否されても例外を出さない', deniedErrors.length === 0 && !(await addPanelOpen(denied)), deniedErrors);
await ctx2.close();

await browser.close();
console.log(failed ? failed + ' 件失敗' : 'すべて成功');
process.exit(failed ? 1 : 0);
