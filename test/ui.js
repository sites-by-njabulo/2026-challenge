'use strict';
/* Browser test: drives the real screens in Edge via puppeteer-core, takes screenshots, clicks through the main flows.
   Run: node --no-warnings test/ui.js    (needs puppeteer-core; path below points at an existing install) */
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const puppeteer = require('C:/Users/Admin1/webdesign-landing/My websites/My Projects/Projects/AI Video Editor/tools/node_modules/puppeteer-core');

const ROOT = path.join(__dirname, '..');
const SHOTS = path.join(__dirname, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });
const PORT = 4398, BASE = 'http://127.0.0.1:' + PORT;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-ui-'));
const PW = 'ui-test-' + Math.random().toString(36).slice(2, 10);
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const results = [];
const check = (name, cond, extra) => { results.push({ name, ok: !!cond }); console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  <-- ' + JSON.stringify(extra))); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FIXED_NOW = process.env.FIXED_NOW || '2026-11-25T03:30:00Z'; // 22:30 Eastern, 17:30 Hawaii: some leads open, some closed

(async () => {
  spawnSync(process.execPath, ['--no-warnings', 'seed.js'], { cwd: ROOT, env: { ...process.env, DATA_DIR: DATA } });
  const ZM_KEY = '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed';
  const mock = await require('./zapmail-mock.js').startMock(4396, ZM_KEY);
  const srv = spawn(process.execPath, ['--no-warnings', 'server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: DATA, ZAPMAIL_BASE: 'http://127.0.0.1:4396/api/v3' }, stdio: 'ignore' });
  for (let i = 0; i < 40; i++) { try { if ((await fetch(BASE + '/api/health')).ok) break; } catch (e) { /* wait */ } await sleep(150); }
  const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-sandbox'] });
  const errors = [];
  try {
    const page = await browser.newPage();
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error' && !/fonts\.(googleapis|gstatic)|ERR_(INTERNET|NAME|CONNECTION)|Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
    page.on('response', (r) => { if (r.status() >= 500) errors.push('HTTP ' + r.status() + ' ' + r.url()); });
    await page.evaluateOnNewDocument((target) => {
      const RealDate = Date; const off = new RealDate(target).getTime() - RealDate.now();
      class FakeDate extends RealDate { constructor(...a) { if (a.length === 0) super(RealDate.now() + off); else super(...a); } static now() { return RealDate.now() + off; } }
      window.Date = FakeDate;
    }, FIXED_NOW);
    const shot = async (name) => { await page.screenshot({ path: path.join(SHOTS, name + '.png') }); };
    const clickText = async (text, selector) => {
      const ok = await page.evaluate((t, sel) => {
        const els = [...document.querySelectorAll(sel || 'button, a')].filter((e) => e.textContent.trim().replace(/\s+/g, ' ') === t && e.offsetParent !== null);
        if (!els.length) return false; els[0].click(); return true;
      }, text, selector);
      return ok;
    };
    const wait = (sel, ms) => page.waitForSelector(sel, { timeout: ms || 8000 });

    /* ---------- first run: set password ---------- */
    await page.setViewport({ width: 1366, height: 900 });
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await wait('#pw');
    check('first run shows the set-password screen', (await page.$eval('h1', (h) => h.textContent)).includes('Set a password'), 1);
    await shot('01-setup');
    await page.type('#pw', PW);
    await page.keyboard.press('Enter');
    await wait('#app');
    check('the navigation is Today, Calls, Leads, Pipeline, Email, Stats with Settings at the foot', await page.evaluate(() => [...document.querySelectorAll('.nav a')].map((a) => a.textContent.trim()).join('|') === 'Today|Calls|Leads|Pipeline|Email|Stats' && !!document.querySelector('.rail-foot a[href="#/settings"]')), 1);
    check('after setting a password the app opens on Today', await page.evaluate(() => location.hash === '#/today' && document.title.startsWith('Today')), await page.evaluate(() => location.hash));

    /* ---------- many follow-ups, made through the app itself ---------- */
    await page.evaluate(async () => {
      const j = (m, u, b) => fetch(u, { method: m, headers: { 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }).then((r) => r.json());
      const today = (await j('GET', '/api/today')).progress.today;
      for (let i = 0; i < 12; i++) {
        const c = await j('POST', '/api/leads', { business_name: 'Bulk Follow ' + i, phone: '(555) 87' + String(i).padStart(2, '0') + '-' + String(3000 + i), city: 'Dayton', state: 'OH', source: 'instagram' });
        await j('POST', '/api/leads/' + c.lead.id + '/contacts', { channel: i % 3 === 0 ? 'call' : 'instagram_dm', outcome: i % 3 === 0 ? 'no_answer' : 'sent', followup: today });
      }
    });
    await page.reload({ waitUntil: 'domcontentloaded' });

    /* ---------- Today (desktop): kept simple ---------- */
    await wait('.counter-grid.four');
    await sleep(700);
    await shot('02-today-desktop');
    const todayInfo = await page.evaluate(() => ({
      meters: [...document.querySelectorAll('.meter .label')].map((e) => e.textContent),
      sections: [...document.querySelectorAll('main section .sec-head h2')].map((e) => e.textContent),
      rows: [...document.querySelectorAll('section')].find((x) => /Follow up/.test(x.textContent) && x.querySelector('.ledger') && !/Booked/.test(x.querySelector('h2').textContent)).querySelectorAll('.ledger .row').length,
      count: ([...document.querySelectorAll('.sec-head')].find((x) => /Follow up/.test(x.textContent)) || {}).textContent,
      seeAll: [...document.querySelectorAll('a.btn')].map((x) => x.textContent.trim()).find((t) => /^See all/.test(t)),
      hasQueue: /OK to call now|Call queue/.test(document.querySelector('main').textContent),
    }));
    check('Today starts with how much has been made toward the goal', todayInfo.meters.length >= 1 && /Made so far/.test(todayInfo.meters[0]) && await page.evaluate(() => /^\$[\d,]+/.test(document.querySelector('.meter .big').textContent)), todayInfo.meters);
    check('Today has three sections: Reached out today, Booked calls, Follow up', todayInfo.sections.join('|') === 'Reached out today|Booked calls|Follow up', todayInfo.sections);
    const counters = await page.$$eval('.counter-grid.four .stat-card .stat-head span:last-child', (e) => e.map((x) => x.textContent));
    check('four counters: Calls, Instagram DMs, Facebook DMs, Emails', counters.join('|') === 'Calls|Instagram DMs|Facebook DMs|Emails', counters);
    const outBefore = await page.evaluate(() => ({ total: Number(document.querySelector('.sec-head .big').textContent), ig: Number(document.querySelector('#oc-instagram_dm').value), fb: Number(document.querySelector('#oc-facebook_dm').value) }));
    await page.evaluate(() => { document.querySelector('#oc-instagram_dm').closest('.stat-card').querySelectorAll('.step-btn')[1].click(); });
    await sleep(600);
    await page.evaluate(() => { const c = document.querySelector('#oc-facebook_dm').closest('.stat-card').querySelectorAll('.step-btn')[1]; c.click(); });
    await sleep(600);
    const outAfter = await page.evaluate(() => ({ total: Number(document.querySelector('.sec-head .big').textContent), ig: Number(document.querySelector('#oc-instagram_dm').value), fb: Number(document.querySelector('#oc-facebook_dm').value), targets: document.querySelector('.counter-grid.four + .hint').textContent }));
    check('tapping + on Instagram and Facebook DMs raises each counter and the one total', outAfter.ig === outBefore.ig + 1 && outAfter.fb === outBefore.fb + 1 && outAfter.total === outBefore.total + 2, [outBefore, outAfter]);
    check('the daily targets for calls and DMs are shown under the counters', /Calls \d+ of 50/.test(outAfter.targets) && /DMs \d+ of 30/.test(outAfter.targets), outAfter.targets);
    await shot('02a-today-counters');
    check('the Follow up heading shows the real count, not just the preview', /^Follow up\d+ due/.test(todayInfo.count) && Number(/(\d+) due/.exec(todayInfo.count)[1]) >= 15, todayInfo.count);
    check('only a short preview of follow-ups is listed', todayInfo.rows <= 6 && todayInfo.rows >= 1, todayInfo.rows);
    check('"See all N follow-ups" is offered', /^See all \d+ follow-ups$/.test(todayInfo.seeAll || ''), todayInfo.seeAll);
    check('the call queue is no longer on Today', !todayInfo.hasQueue, 1);
    const sast = await page.evaluate(() => document.querySelector('.page-head .sub').textContent);
    check('my own time (SAST) is shown on Today', /SAST/.test(sast), sast);

    /* ---------- Follow-ups page ---------- */
    await clickText(todayInfo.seeAll, 'a.btn');
    await page.waitForFunction(() => location.hash === '#/followups', { timeout: 5000 });
    await wait('.seg');
    await sleep(500);
    await shot('02b-followups');
    const fuInfo = await page.evaluate(() => ({ rows: document.querySelectorAll('.ledger .row').length, btns: [...document.querySelectorAll('.seg button')].map((b) => b.textContent.replace(/\s+/g, ' ').trim()) }));
    check('Follow-ups page lists everyone due with channel filters', fuInfo.rows >= 15 && fuInfo.btns.some((t) => /^Calls \d+/.test(t)) && fuInfo.btns.some((t) => /^DMs \d+/.test(t)) && fuInfo.btns.some((t) => /Coming up/.test(t)), fuInfo);
    await clickText(fuInfo.btns.find((t) => /^DMs/.test(t)), '.seg button');
    await sleep(500);
    const dmRows = await page.$$eval('.ledger .row', (r) => r.length);
    check('the DMs filter narrows the list', dmRows < fuInfo.rows && dmRows >= 1, [dmRows, fuInfo.rows]);

    /* ---------- Calls page: queue ---------- */
    await page.click('.nav a[data-nav="calls"]');
    await wait('.meter');
    await sleep(700);
    await shot('02c-calls-queue');
    const callsInfo = await page.evaluate(() => {
      const sec = [...document.querySelectorAll('section')].find((x) => /OK to call now/.test(x.textContent));
      return { ready: sec.querySelectorAll('.ledger .row').length, ok: sec.querySelectorAll('.window.ok').length,
        later: !!([...document.querySelectorAll('details.fold summary')].find((x) => /Outside calling hours/.test(x.textContent))),
        tz: !!([...document.querySelectorAll('details.fold summary')].find((x) => /Need a time zone/.test(x.textContent))),
        meter: document.querySelector('.meter .label').textContent };
    });
    check('Calls: the queue lists only leads that are OK to call right now', callsInfo.ready === callsInfo.ok && callsInfo.ready > 0, callsInfo);
    check('Calls: leads outside the window and without a time zone sit in folds', callsInfo.later && callsInfo.tz, callsInfo);
    check('Calls: dials-today meter is at the top', callsInfo.meter === 'Dials today', callsInfo.meter);
    const rowText = await page.evaluate(() => document.querySelector('.ledger .row').textContent);
    check('queue rows show the lead\'s local time next to mine', /you /.test(rowText) && /(AM|PM)/.test(rowText), rowText);

    /* log a call from the queue in two taps */
    const beforeCalls = await page.evaluate(() => document.querySelector('.meter .big').textContent);
    await clickText('Log call');
    await wait('.inline-log .outcomes');
    await shot('03-calls-inline-log');
    await page.evaluate(() => [...document.querySelectorAll('.inline-log .outcomes button')].find((b) => b.textContent === 'Voicemail').click());
    await wait('.toast');
    const toastText = await page.$eval('.toast', (t) => t.textContent);
    check('one outcome tap logs the call and confirms with an Undo', /Logged: Call, Voicemail/.test(toastText) && /Undo/.test(toastText), toastText);
    await sleep(900);
    const afterCalls = await page.evaluate(() => document.querySelector('.meter .big').textContent);
    check('the dials counter went up by one', Number(afterCalls) === Number(beforeCalls) + 1, [beforeCalls, afterCalls]);
    await clickText('Undo', '.toast button');
    await sleep(1000);
    const undone = await page.evaluate(() => document.querySelector('.meter .big').textContent);
    check('Undo removes the entry again', Number(undone) === Number(beforeCalls), [beforeCalls, undone]);

    /* ---------- Calls page: scoreboard (the Cold Call Tracker model) ---------- */
    await clickText('Scoreboard', '.seg button');
    await wait('.counter-grid');
    await sleep(700);
    await shot('03b-calls-scoreboard');
    const sbNames = await page.$$eval('.counter-grid .stat-card .stat-head span:last-child', (e) => e.map((x) => x.textContent));
    check('scoreboard has the four counters from the Cold Call Tracker', sbNames.join('|') === 'Calls made|Contacts reached|Owner conversations|Good conversations', sbNames);
    const sb0 = await page.$$eval('.counter-grid .stat-value', (e) => e.map((x) => Number(x.value)));
    await page.evaluate(() => { const cards = document.querySelectorAll('.counter-grid .stat-card'); cards[0].querySelectorAll('.step-btn')[1].click(); });
    await sleep(600);
    await page.evaluate(() => { const cards = document.querySelectorAll('.counter-grid .stat-card'); cards[3].querySelectorAll('.step-btn')[1].click(); });
    await sleep(600);
    const sb1 = await page.$$eval('.counter-grid .stat-value', (e) => e.map((x) => Number(x.value)));
    check('+ raises Calls made and Good conversations by one each', sb1[0] === sb0[0] + 1 && sb1[3] === sb0[3] + 1 && sb1[1] === sb0[1], [sb0, sb1]);
    await page.evaluate(() => { document.querySelectorAll('.counter-grid .stat-card')[3].querySelectorAll('.step-btn')[0].click(); });
    await sleep(600);
    check('\u2212 lowers a counter again', (await page.$$eval('.counter-grid .stat-value', (e) => Number(e[3].value))) === sb0[3], 1);
    await page.type('#verdict', 'Quiet morning, picked up after 2 PM.');
    await sleep(1400);
    check('the verdict saves by itself', await page.evaluate(() => /Saved/.test(document.body.textContent)), 1);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await wait('.seg');
    await clickText('Scoreboard', '.seg button');
    await wait('#verdict');
    await sleep(500);
    check('the verdict is still there after reloading', (await page.$eval('#verdict', (t) => t.value)).includes('Quiet morning'), 1);
    await page.click('button[aria-label="Previous day"]');
    await sleep(700);
    const prevLabel = await page.$eval('.datebar .date-label span:last-child', (e) => e.textContent);
    check('the day navigator goes back a day and Today is no longer shown', prevLabel !== 'Today' && (await page.$eval('button[aria-label="Next day"]', (b) => !b.disabled)), prevLabel);
    await page.click('button[aria-label="Next day"]');
    await sleep(700);
    check('and forward again, where the next-day button is switched off', (await page.$eval('.datebar .date-label span:last-child', (e) => e.textContent)) === 'Today' && (await page.$eval('button[aria-label="Next day"]', (b) => b.disabled)), 1);
    check('last days with averages are shown', await page.evaluate(() => /avg calls/.test(document.body.textContent) && /Last \d+ days?/.test(document.body.textContent)), 1);
    await shot('03c-calls-scoreboard-history');

    await clickText('Stats', '.seg button');
    await wait('.tiles');
    await sleep(500);
    const st3 = await page.$$eval('.tiles .tile .l', (e) => e.map((x) => x.textContent));
    check('Calls stats: calls made, contacts reached, owner and good conversations, meetings, three rates', ['Calls made', 'Contacts reached', 'Owner conversations', 'Good conversations', 'Meetings booked', 'Pick-up rate', 'Owner rate', 'Booking rate'].every((t) => st3.includes(t)), st3);
    await shot('03d-calls-stats');
    await clickText('This week', '.seg button');
    await sleep(600);
    check('the stats period can be switched to this week', (await page.$$eval('.tiles .tile .n', (n) => Number(n[0].textContent))) >= 1, 1);

    /* ---------- add lead + duplicate warning ---------- */
    await page.goto(BASE + '/#/today');
    await wait('.counter-grid.four');
    await clickText('Add lead', '.rail-foot button');
    await wait('dialog[open] #lf-business_name');
    await page.type('#lf-business_name', 'Ridgeline Roofing Co');
    await page.type('#lf-phone', '615 555 0142');
    await wait('.dupbox', 4000);
    await shot('04-add-lead-duplicate');
    const dupText = await page.$eval('.dupbox', (d) => d.textContent);
    check('typing a known phone shows the duplicate warning before saving', /Ridgeline Roofing/.test(dupText) && /same phone/.test(dupText), dupText);
    await page.select('#lf-source', 'referral');
    await page.evaluate(() => document.querySelector('dialog form').requestSubmit());
    await sleep(700);
    const stillOpen = await page.evaluate(() => !!document.querySelector('dialog[open]') && /duplicate/i.test(document.querySelector('dialog .err').textContent));
    check('saving is held until you choose "Add anyway"', stillOpen, 1);
    await clickText('Add anyway', 'dialog button');
    await page.waitForFunction(() => location.hash.startsWith('#/lead/'), { timeout: 5000 });
    check('Add anyway saves and opens the new lead', true, 1);

    /* ---------- lead page: log on two channels, timeline ---------- */
    await wait('.lead-grid .timeline, .lead-grid .empty');
    await sleep(300);
    await shot('05-lead-new');
    await clickText('Instagram DM', '.seg button');
    await page.evaluate(() => [...document.querySelectorAll('.outcomes button')].find((b) => b.textContent === 'Sent').click());
    await wait('.toast');
    await sleep(700);
    await clickText('Call', '.seg button');
    await page.evaluate(() => [...document.querySelectorAll('.outcomes button')].find((b) => b.textContent === 'Gatekeeper').click());
    await sleep(900);
    const tl = await page.evaluate(() => [...document.querySelectorAll('.timeline .tl')].map((e) => e.querySelector('.head').textContent));
    check('both channels appear on the one lead timeline', tl.length === 2 && tl.some((t) => /Instagram DM/.test(t)) && tl.some((t) => /Call/.test(t)), tl);
    const fu = await page.$eval('input[aria-label="Next follow-up date"]', (i) => i.value);
    check('a follow-up date was set automatically', /^\d{4}-\d{2}-\d{2}$/.test(fu), fu);
    await shot('06-lead-logged');

    /* opt out through the UI */
    await page.evaluate(() => { [...document.querySelectorAll('details.fold summary')].find((s) => s.textContent.trim() === 'Opt-out').click(); });
    await clickText('Mark opted out', '.fold-body button');
    await wait('dialog[open]');
    await clickText('Mark opted out', 'dialog button');
    await wait('.banner.danger');
    await sleep(400);
    const banner = await page.$eval('.banner.danger', (b) => b.textContent);
    check('opt-out shows a red banner with the date', /Opted out/.test(banner), banner);
    const blocked = await page.evaluate(() => !document.querySelector('.outcomes') && /Logging is switched off/.test(document.body.textContent));
    check('the log buttons are gone on every channel after opt-out', blocked, 1);
    await shot('07-lead-opted-out');
    await page.evaluate(() => { [...document.querySelectorAll('details.fold summary')].find((s) => s.textContent.trim() === 'Opt-out').click(); });
    await clickText('Remove opt-out', '.fold-body button');
    await wait('dialog[open] input');
    const disabled = await page.evaluate(() => [...document.querySelectorAll('dialog button')].find((b) => b.textContent === 'Remove opt-out').disabled);
    check('removing an opt-out needs REMOVE typed first', disabled === true, disabled);
    await page.keyboard.press('Escape');
    await sleep(300);

    /* ---------- leads list ---------- */
    await page.goto(BASE + '/#/leads', { waitUntil: 'domcontentloaded' });
    await wait('table.t');
    await sleep(300);
    await shot('08-leads-desktop');
    const rowsN = await page.$$eval('table.t tbody tr', (r) => r.length);
    check('leads list shows every lead', rowsN >= 11, rowsN);
    const heads = await page.$$eval('table.t thead th', (e) => e.map((x) => x.textContent));
    check('leads table is Business, Where, Status, Follow-up, Contacted via (no Last touch or Source columns)', heads.join('|') === 'Business|Where|Status|Follow-up|Contacted via', heads);
    const viaTxt = await page.$$eval('table.t tbody tr', (r) => r.map((x) => x.querySelector('td[data-label="Contacted via"]').textContent));
    check('each lead shows the channels used, "Not yet" when none', viaTxt.some((t) => /Instagram/.test(t)) && viaTxt.some((t) => /Call/.test(t)) && viaTxt.some((t) => /Not yet/.test(t)), viaTxt);
    check('a lead contacted on several channels shows all of them', viaTxt.some((t) => /Instagram/.test(t) && /Call/.test(t)), viaTxt);
    await page.select('select[aria-label="Contacted via: any"]', 'email');
    await sleep(700);
    const emailRows = await page.$$eval('table.t tbody tr td[data-label="Contacted via"]', (r) => r.map((x) => x.textContent));
    check('the Contacted via filter narrows to leads emailed', emailRows.length >= 1 && emailRows.every((t) => /Email/.test(t)), emailRows);
    await page.select('select[aria-label="Contacted via: any"]', '');
    await sleep(500);
    await shot('08b-leads-contacted-via');
    await page.type('input[type=search]', 'harbor');
    await sleep(700);
    check('search narrows the list', (await page.$$eval('table.t tbody tr', (r) => r.length)) === 1, 1);

    /* ---------- CSV import through the UI ---------- */
    await page.goto(BASE + '/#/import', { waitUntil: 'domcontentloaded' });
    await wait('#imp-file');
    const csv = path.join(DATA, 'upload.csv');
    fs.writeFileSync(csv, 'Company,Contact Name,Phone Number,Email Address,Website,City,State,Category\r\nAlpine Gutters,Mia Ross,(970) 555-0111,mia@alpine.example,alpine.example,Aspen,Colorado,Roofer\r\n"Granite Peak HVAC, LLC",Wes,(801) 555-0188,,granitepeakhvac.example,Salt Lake City,UT,HVAC\r\nRiverbend Roofing,Tom,(406) 555-0133,,riverbend.example,Billings,MT,Roofer\r\nRiverbend Roofing,Tom,(406) 555-0133,,riverbend.example,Billings,MT,Roofer\r\n');
    await (await page.$('#imp-file')).uploadFile(csv);
    await wait('#map-business_name');
    const mapped = await page.evaluate(() => ({ biz: document.querySelector('#map-business_name').selectedOptions[0].textContent, phone: document.querySelector('#map-phone').selectedOptions[0].textContent, trade: document.querySelector('#map-trade').selectedOptions[0].textContent, state: document.querySelector('#map-state').selectedOptions[0].textContent }));
    check('column mapping is guessed from the headers', mapped.biz === 'Company' && mapped.phone === 'Phone Number' && mapped.trade === 'Category' && mapped.state === 'State', mapped);
    await shot('09-import-map');
    await page.select('#imp-src', 'google_maps');
    await clickText('Check duplicates');
    await wait('.tiles');
    await sleep(300);
    const tiles = await page.$$eval('.tiles .tile', (t) => t.map((x) => x.textContent));
    check('duplicate preview: 1 new Alpine, a duplicate of Granite Peak, a repeat in the file', /^1New|^2New/.test(tiles[0]) && /1Duplicates/.test(tiles[1]) && /1Repeats in file/.test(tiles[2]), tiles);
    await shot('10-import-preview');
    await clickText('Import 2 leads');
    await wait('h2');
    await page.waitForFunction(() => /Import finished/.test(document.body.textContent), { timeout: 5000 });
    const done = await page.$eval('.kv', (k) => k.textContent);
    check('import result: 2 added, the duplicates skipped', /Added2/.test(done) && /Skipped \(duplicates\)2/.test(done), done);

    /* ---------- pipeline, stats, settings ---------- */
    for (const [hash, sel, nm] of [['#/pipeline', '.board', '11-pipeline'], ['#/stats', '.tiles', '12-stats'], ['#/settings', '#s-script', '13-settings']]) {
      await page.goto(BASE + '/' + hash, { waitUntil: 'domcontentloaded' });
      await wait(sel);
      await sleep(400);
      await shot(nm + '-desktop');
    }
    await page.goto(BASE + '/#/pipeline');
    await wait('.board');
    const cols = await page.$$eval('.board .col h3 span:first-child', (e) => e.map((x) => x.textContent));
    check('pipeline columns are Replied, Call booked, Follow up, Proposal sent, Closed', cols.join('|') === 'Replied|Call booked|Follow up|Proposal sent|Closed', cols);
    check('there is no Contacted column', !cols.includes('Contacted'), cols);
    check('New and Not interested are linked below the board, not columns', await page.evaluate(() => /Not on the board/.test(document.body.textContent)), 1);
    const goalTxt = await (async () => { await page.goto(BASE + '/#/pipeline'); await wait('.goal .amt'); return page.$eval('.goal .amt', (e) => e.textContent); })();
    check('pipeline shows progress toward the $20,000 goal', /\$1,000.*\$20,000/.test(goalTxt), goalTxt);
    await page.goto(BASE + '/#/leads');
    await wait('table.t');
    const leadHref = await page.$eval('table.t tbody a', (a) => a.getAttribute('href'));
    await page.goto(BASE + '/' + leadHref);
    await wait('.lead-grid');
    await sleep(300);
    await shot('14-lead-desktop');

    /* ---------- Email page (Zapmail snapshot) ---------- */
    await page.goto(BASE + '/#/email');
    await wait('.banner.warn');
    check('Email page says Zapmail is not connected before the first snapshot', await page.evaluate(() => /not connected yet/i.test(document.body.textContent)), 1);
    await page.evaluate(async () => {
      const today = new Date().toISOString().slice(0, 10);
      void today;
      await fetch('/api/email/snapshot', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        taken_at: new Date().toISOString(), source: 'ui test', plan: { name: 'Starter', mailboxes_included: 10, monthly_price: '$39', renewal_date: '2026-12-23' },
        zapwarm: { started: '2026-11-23', daily_emails: 5, slow_warmup: true, weekdays_only: true, industry: null, free_trial_ends: '2026-12-23', first_charge_date: '2026-12-23', first_charge_amount: 9, discount: '50% off for 6 months', emails_sent_30d: 8, inbox_rate: 1 },
        domains: [{ name: 'getexample.test', status: 'connected' }, { name: 'tryexample.test', status: 'connected' }],
        mailboxes: [{ email: 'jay@getexample.test', name: 'Jay T', domain: 'getexample.test', status: 'Warming up', score: 1, score_max: 5, sent_30d: 1, inbox_rate: 1, admin: true }, { email: 'hello@getexample.test', name: 'Jay T', domain: 'getexample.test', status: 'Warming up', score: 1, score_max: 5, sent_30d: 1, inbox_rate: 1 }, { email: 'jay@tryexample.test', name: 'Jay T', domain: 'tryexample.test', status: 'Warming up', score: 2, score_max: 5, sent_30d: 2, inbox_rate: 1 }],
      }) });
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await wait('.tiles');
    await sleep(600);
    await shot('15-email-desktop');
    const emailInfo = await page.evaluate(() => ({
      status: document.querySelector('.meter div[style*="font-size:22px"]').textContent,
      rows: document.querySelectorAll('table.t tbody tr').length,
      sections: [...document.querySelectorAll('main section .sec-head h2')].map((e) => e.textContent),
      tiles: [...document.querySelectorAll('.tiles .tile .l')].map((e) => e.textContent),
      fresh: /Up to date/.test(document.body.textContent),
    }));
    check('Email page: warm-up status line with the day counted from the start', /^Warming up\. Day \d+ of 21\.$/.test(emailInfo.status), emailInfo.status);
    check('Email page: mailboxes by domain, sending plan, results, checklist, account', ['Mailboxes', 'How many to send', 'Cold email results', 'Before the first send', 'Zapmail account', 'Connect Zapmail'].every((t) => emailInfo.sections.includes(t)), emailInfo.sections);
    check('Email page: mailbox, warming and score tiles', ['Mailboxes', 'Warming up', 'Average score'].every((t) => emailInfo.tiles.includes(t)) && emailInfo.fresh, emailInfo.tiles);
    /* connect Zapmail from the page */
    check('Email page offers to connect Zapmail with a key box that hides what you type', await page.evaluate(() => { const i = document.querySelector('#zm-key'); return !!i && i.type === 'password' && /Not connected/.test(document.body.textContent) && /Treat the key like a password/.test(document.body.textContent); }), 1);
    await page.type('#zm-key', '00000000-0000-4000-8000-000000000000');
    await clickText('Connect', 'button');
    await page.waitForFunction(() => /rejected the key/.test(document.body.textContent), { timeout: 8000 });
    check('a wrong key shows a plain message right under the box', true, 1);
    await page.evaluate(() => { document.querySelector('#zm-key').value = ''; });
    await page.type('#zm-key', ZM_KEY);
    await shot('15b-email-connect');
    await clickText('Connect', 'button');
    await page.waitForFunction(() => /Connected/.test(document.body.textContent) && /Refresh now/.test(document.body.textContent), { timeout: 10000 });
    await sleep(600);
    await shot('15c-email-connected');
    const live = await page.evaluate(() => ({ text: document.body.textContent, rows: [...document.querySelectorAll('table.t tbody tr')].map((r) => r.textContent) }));
    check('after connecting, the page shows the key ending, not the key', /Connected with the key ending/.test(live.text) && live.text.includes('\u00b7\u00b7\u00b7\u00b7' + ZM_KEY.slice(-4)) && !live.text.includes(ZM_KEY), 1);
    check('the mailboxes now come from Zapmail with scores out of 100', live.rows.some((t) => /jay@mock-one\.test/.test(t) && /60\/100/.test(t)) && live.rows.some((t) => /jay@mock-two\.test/.test(t) && /No score yet/.test(t)), live.rows.slice(0, 4));
    check('it says the numbers are live from the API', /Live from the Zapmail API/.test(live.text) && /refreshes by itself every 3 hours/.test(live.text), 1);
    await clickText('Refresh now', 'button');
    await sleep(1500);
    check('Refresh now pulls fresh numbers and says so', await page.evaluate(() => [...document.querySelectorAll('.toast')].some((t) => /Updated from Zapmail: 3 mailboxes/.test(t.textContent))), 1);
    await sleep(900);
    await page.click('#ck-address');
    await sleep(600);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await wait('.checklist');
    check('a ticked item on the pre-send checklist is remembered', await page.$eval('#ck-address', (c) => c.checked), 1);
    await page.goto(BASE + '/#/leads');
    await wait('table.t');
    await page.evaluate(() => { document.querySelector('table.t tbody tr').click(); });
    await page.waitForFunction(() => location.hash.startsWith('#/lead/'), { timeout: 5000 });
    await wait('.lead-grid');
    await clickText('Email', '.seg button');
    await sleep(500);
    check('logging an email asks which Zapmail mailbox it was sent from', await page.evaluate(() => { const s = document.querySelector('select[aria-label="Sent from mailbox"]'); return !!s && !s.closest('.field').hidden && s.options.length === 4; }), 1);
    await page.select('select[aria-label="Sent from mailbox"]', 'jay@mock-one.test');
    await page.evaluate(() => [...document.querySelectorAll('.outcomes button')].find((b) => b.textContent === 'Sent').click());
    await wait('.toast');
    await sleep(900);
    check('the timeline shows the mailbox the email came from', await page.evaluate(() => /Sent from jay@mock-one\.test/.test(document.querySelector('.timeline').textContent)), 1);
    await shot('16-lead-email-mailbox');

    /* ---------- phone size ---------- */
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    const overflow = {};
    for (const [hash, sel, nm] of [['#/today', '.counter-grid.four', '20-today-phone'], ['#/calls', '.meter', '20b-calls-phone'], ['#/email', '.tiles', '20d-email-phone'], ['#/followups', '.seg', '20c-followups-phone'], ['#/leads', 'table.t', '21-leads-phone'], [leadHref.slice(leadHref.indexOf('#')), '.lead-grid', '22-lead-phone'], ['#/pipeline', '.board', '23-pipeline-phone'], ['#/stats', '.tiles', '24-stats-phone'], ['#/settings', '#s-script', '25-settings-phone'], ['#/import', '#imp-file', '26-import-phone']]) {
      await page.goto(BASE + '/' + hash, { waitUntil: 'domcontentloaded' });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await wait(sel);
      await sleep(500);
      overflow[nm] = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      await shot(nm);
    }
    check('no page scrolls sideways on a phone', Object.values(overflow).every((v) => v <= 1), overflow);
    const tabH = await page.evaluate(() => Math.min(...[...document.querySelectorAll('.nav a')].map((a) => a.getBoundingClientRect().height)));
    check('bottom tab buttons are at least 44px tall', tabH >= 44, tabH);
    const smallTargets = await page.evaluate(() => [...document.querySelectorAll('main button, main a.btn, main select, main input')].filter((e) => e.offsetParent && !e.classList.contains('sm') && e.getBoundingClientRect().height < 36 && e.type !== 'checkbox' && e.type !== 'hidden').map((e) => e.textContent.trim().slice(0, 20) || e.tagName).slice(0, 6));
    check('main controls on a phone are big enough to tap', smallTargets.length === 0, smallTargets);
    await page.goto(BASE + '/#/calls');
    await wait('.meter');
    await clickText('Call queue', '.seg button');
    await sleep(300);
    await clickText('Log call');
    await wait('.inline-log .outcomes');
    await sleep(300);
    await shot('27-calls-phone-log');

    check('no script errors or server errors during the whole run', errors.length === 0, errors);
  } catch (e) {
    check('UI run crashed', false, e.stack);
  } finally {
    await browser.close();
    try { mock.close(); } catch (e) { /* ignore */ }
    srv.kill();
    const bad = results.filter((x) => !x.ok);
    console.log(`\n${results.length - bad.length} passed, ${bad.length} failed. Screenshots in ${SHOTS}`);
    process.exit(bad.length ? 1 : 0);
  }
})();
