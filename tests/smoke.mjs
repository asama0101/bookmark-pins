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

await browser.close();
console.log(failed ? failed + ' 件失敗' : 'すべて成功');
process.exit(failed ? 1 : 0);
