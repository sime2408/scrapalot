import { chromium } from '@playwright/test';
const BASE='https://scrapalot.app', USER='admin', PASS='admin123';
const OUT='/opt/scrapalot/scrapalot-mobile/store/screenshots';
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport:{width:412,height:732}, deviceScaleFactor:2.5, isMobile:true, hasTouch:true,
  userAgent:'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36' });
await ctx.route('**/settings/settings_general*', async route=>{ try{const resp=await route.fetch();let json=await resp.json();
  const patch=(o)=>{if(o&&typeof o==='object'){if('language'in o)o.language='en';if(o.setting_value)patch(o.setting_value);}};patch(json);await route.fulfill({response:resp,json});}catch(e){await route.continue();}});
const page = await ctx.newPage();
await page.addInitScript(()=>{try{localStorage.setItem('scrapalot_tour_completed','true');localStorage.setItem('i18nextLng','en');}catch{}});
await page.goto(BASE+'/login',{waitUntil:'domcontentloaded'});
await page.waitForSelector('button[type="submit"]',{state:'visible',timeout:20000});
await page.fill('[name="username"]',USER); await page.fill('[name="password"]',PASS);
await page.waitForTimeout(900); await page.click('button[type="submit"]');
await page.waitForURL(/\/(dashboard|workspaces)/,{timeout:30000,waitUntil:'commit'}).catch(()=>{});
await page.waitForTimeout(8000);
await page.fill('[data-testid="chat-input"]','What are the basics of beekeeping for beginners?').catch(()=>{});
await page.waitForTimeout(400);
await page.click('[data-testid="chat-send-button"]').catch(()=>{});
for(let i=0;i<70;i++){ await page.waitForTimeout(2000);
  const ok=await page.$('[data-testid="message-feedback-up-button"]');
  const calc=await page.evaluate(()=>!!document.body.textContent.match(/Calculating|Analyzing|Razmišljam|Pripremam|Generating/));
  if(ok&&!calc) break; }
await page.waitForTimeout(1500);
// collapse thinking + model insight
for(const tid of ['chat-thinking-toggle','chat-model-insight-toggle']){
  for(const el of await page.$$('[data-testid="'+tid+'"]')){ if(await el.evaluate(n=>n.getAttribute('aria-expanded'))==='true'){await el.click().catch(()=>{});await page.waitForTimeout(250);} } }
await page.evaluate(()=>document.querySelectorAll('[data-testid="search-strategy-panel"] [aria-expanded="true"]').forEach(e=>e.click()));
await page.waitForTimeout(400);
const cit=await page.$('[data-testid="citations-toggle-button"]'); if(cit&&await cit.evaluate(n=>n.getAttribute('aria-expanded'))!=='true'){await cit.click().catch(()=>{});await page.waitForTimeout(1000);}
await page.evaluate(()=>{const s=document.querySelector('[data-testid="chat-messages-scroll"]');if(s)s.scrollTop=s.scrollHeight;});
await page.waitForTimeout(500);
// blur avatars + citation source text (keep structure)
await page.addStyleTag({content:`.sl-blurX{filter:blur(14px)!important}.sl-blurT{filter:blur(5px)!important}`});
await page.evaluate(()=>{
  document.querySelectorAll('[data-testid="chat-message"] img').forEach(i=>i.classList.add('sl-blurX'));
  document.querySelectorAll('img').forEach(im=>{const s=(im.src||'')+(im.className||'');if(/avatar|profile|googleusercontent|gravatar/i.test(s))im.classList.add('sl-blurX');});
  // blur citation source text lines (titles + excerpts), keep numbers/icons/structure
  const cs=document.querySelector('[data-testid="message-citations-section"]');
  if(cs) cs.querySelectorAll('p,span,a,div').forEach(e=>{const t=(e.textContent||'').trim();if(t.length>6 && e.children.length===0)e.classList.add('sl-blurT');});
});
await page.waitForTimeout(300);
await page.screenshot({path:OUT+'/1-cited-answers.png'});
await browser.close(); console.log('S1 DONE');
