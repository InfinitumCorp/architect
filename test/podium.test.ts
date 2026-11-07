import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { chromium, type Browser, type Page } from 'playwright';
import { beforeAll, afterAll, it, expect } from 'vitest';
import { Architect } from '../src/architect.js';
import { createArchitectServer } from '../src/server.js';
import { ScriptedBrain, toolUse } from './helpers.js';

let server: Server, browser: Browser, dir: string, base: string, architect: Architect;
beforeAll(async () => {
 dir = await mkdtemp(path.join(tmpdir(),'conductor-podium-'));
 const brain = new ScriptedBrain({summary:'Prepare a supplier comparison',permissions:[],startUrl:null,steps:[{title:'Compare suppliers',instruction:'Compare {{supplier}} and record the result',instruments:[],checkpoint:true}],successCriteria:['Comparison recorded']},[
  () => [toolUse('record_evidence',{label:'Supplier comparison',content:'Acme costs $100. Example costs $120.'}),toolUse('step_complete',{summary:'Comparison recorded'})],
  () => [toolUse('submit_verdict',{passed:true,summary:'Comparison verified',criteria:[{criterion:'Comparison recorded',met:true,evidence:'Supplier comparison evidence'}]})],
  () => [toolUse('step_complete',{summary:'Rehearsed'})],
 ]);
 architect = new Architect({brain,instruments:[],dataDir:dir,approvalTimeoutMs:30000});
 server = createArchitectServer({architect,token:'podium-test'});
 await new Promise<void>(r => server.listen(0,'127.0.0.1',r));
 base = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
 browser = await chromium.launch({headless:true});
},30000);
afterAll(async () => { await browser?.close(); await architect?.dispose(); server?.close(); await rm(dir,{recursive:true,force:true}); });
async function waitFor(page: Page, text: string) { await page.getByText(text,{exact:false}).first().waitFor({timeout:15000}); }
it('composes, reviews cost, approves, verifies, saves, schedules, exports and encores through the browser', async () => {
 const page = await browser.newPage({viewport:{width:1440,height:1000}}); const errors: string[] = [];
 page.on('pageerror',e => errors.push(e.message));
 await page.goto(base + '/?token=podium-test');
 await waitFor(page,'Server connected');
 expect(page.url()).not.toContain('token=');
 await page.locator('#goal').fill('Compare supplier quotes');
 await page.locator('[name=budgetUsd]').fill('5');
 await page.getByRole('button',{name:'Compose score'}).click();
 await waitFor(page,'Estimated performance cost');
 expect(await page.locator('.status').first().textContent()).toBe('composed');
 await page.getByRole('button',{name:'Start performance'}).click();
 await waitFor(page,'Decision required');
 await page.getByRole('button',{name:'Review decision'}).click();
 await page.locator('[name=approved]').selectOption('true');
 await page.getByRole('button',{name:'Submit decision'}).click();
 await waitFor(page,'Verification · passed');
 await waitFor(page,'Acme costs $100.');
 await page.getByRole('button',{name:'Save score',exact:true}).click();
 await page.locator('#modal [name=name]').fill('supplier-compare');
 await page.locator('#modal button[type=submit]').click();
 await page.getByRole('link',{name:'Score library',exact:true}).click();
 await waitFor(page,'supplier-compare');
 const exportPromise = page.waitForEvent('download');
 await page.getByRole('button',{name:'Export package'}).click();
 const exported = await exportPromise; expect(exported.suggestedFilename()).toBe('supplier-compare.score.json');
 await page.getByRole('link',{name:'Schedules',exact:true}).click();
 await page.getByRole('button',{name:'New schedule'}).click();
 await page.locator('#modal [name=name]').fill('daily-compare');
 await page.getByRole('button',{name:'Save schedule',exact:true}).click();
 await waitFor(page,'daily-compare');
 await page.getByRole('button',{name:'Pause',exact:true}).click();
 await waitFor(page,'paused');
 const schedules = await page.request.get(base + '/v1/schedules',{headers:{authorization:'Bearer podium-test'}});
 expect((await schedules.json())[0].enabled).toBe(false);
 await page.getByRole('link',{name:/Performances/}).click();
 await page.locator('.run').first().click();
 await page.getByRole('button',{name:'Encore',exact:true}).click();
 await page.locator('#modal [name=autonomy]').selectOption('rehearsal');
 await page.locator('#modal button[type=submit]').click();
 await waitFor(page,'rehearsed');
 expect(page.url()).toContain('#run/');
 const shotDir = process.env.CONDUCTOR_SCREENSHOT_DIR;
 if (shotDir) await mkdir(shotDir,{recursive:true});
 if (shotDir) await page.screenshot({path:path.join(shotDir,'conductor-performance.png'),fullPage:true});
 await page.getByRole('button',{name:'All performances'}).click();
 if (shotDir) await page.screenshot({path:path.join(shotDir,'conductor-desktop.png'),fullPage:true});
 await page.setViewportSize({width:390,height:844});
 if (shotDir) await page.screenshot({path:path.join(shotDir,'conductor-mobile.png'),fullPage:true});
 expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
 expect(errors).toEqual([]);
 await page.close();
},60000);
it('recovers from an invalid API token without reloading or leaking it into the URL',async () => {
 const page = await browser.newPage();
 await page.goto(base + '/?token=wrong');
 await waitFor(page,'missing or invalid bearer token');
 await page.locator('#connection').click();
 await page.locator('#modal [name=token]').fill('podium-test');
 await page.getByRole('button',{name:'Connect',exact:true}).click();
 await waitFor(page,'Server connected');
 expect(page.url()).not.toContain('token=');
 await page.close();
});
it('serves app assets and rejects invalid lifecycle operations before accepting background work', async () => {
 for (const asset of ['app.js','app.css','manifest.webmanifest','icon.svg']) expect((await fetch(base + '/podium/' + asset)).status).toBe(200);
 const auth = {authorization:'Bearer podium-test','content-type':'application/json'};
 const runs = await (await fetch(base + '/v1/runs',{headers:auth})).json();
 expect((await fetch(base + '/v1/runs/' + runs[0].id + '/recover',{method:'POST',headers:auth,body:'{}'})).status).toBe(409);
 expect((await fetch(base + '/v1/runs/run_missing/cancel',{method:'POST',headers:auth,body:'{}'})).status).toBe(404);
 expect((await fetch(base + '/v1/approvals/missing',{method:'POST',headers:auth,body:'{"approved":"false"}'})).status).toBe(400);
 expect((await fetch(base + '/v1/runs/invalid')).status).toBe(401);
});
