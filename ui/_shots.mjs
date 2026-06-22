import { chromium } from '@playwright/test';
const BASE='https://scrapalot.app', USER='admin', PASS='admin123';
const OUT='/opt/scrapalot/scrapalot-mobile/store/screenshots';
const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport:{width:412,height:732}, deviceScaleFactor:2.5, isMobile:true, hasTouch:true,
  userAgent:'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36',
});
await ctx.route('**/settings/settings_general*', async route=>{
  try{ const resp=await route.fetch(); let json=await resp.json();
    const patch=(o)=>{if(o&&typeof o==='object'){if('language'in o)o.language='en';if(o.setting_value)patch(o.setting_value);}};
    patch(json); await route.fulfill({response:resp,json});
  }catch(e){ await route.continue(); }
});
const page = await ctx.newPage();
await page.addInitScript(()=>{try{localStorage.setItem('scrapalot_tour_completed','true');localStorage.setItem('i18nextLng','en');}catch{}});
const blurAvatars=async()=>{ await page.addStyleTag({content:`.sl-blurX{filter:blur(14px)!important}`});
  await page.evaluate(()=>{document.querySelectorAll('[data-testid="chat-message"] img').forEach(i=>i.classList.add('sl-blurX'));
    document.querySelectorAll('img').forEach(im=>{const s=(im.src||'')+(im.className||'');if(/avatar|profile|googleusercontent|gravatar/i.test(s))im.classList.add('sl-blurX');});}); };

await page.goto(BASE+'/login',{waitUntil:'domcontentloaded'});
await page.waitForSelector('button[type="submit"]',{state:'visible',timeout:20000});
await page.fill('[name="username"]',USER); await page.fill('[name="password"]',PASS);
await page.waitForTimeout(900); await page.click('button[type="submit"]');
await page.waitForURL(/\/(dashboard|workspaces)/,{timeout:30000,waitUntil:'commit'}).catch(()=>{});
await page.waitForTimeout(8000);
console.log('lang:', await page.evaluate(()=>localStorage.getItem('i18nextLng')));

// S3 HERO: neutral typed question
await page.fill('[data-testid="chat-input"]','Summarize the core ideas of stoic philosophy').catch(()=>{});
await page.waitForTimeout(600);
await page.screenshot({path:OUT+'/3-ask-anything.png'});
console.log('hero done');

// S1 fresh neutral Q&A
await page.fill('[data-testid="chat-input"]','What are the basics of beekeeping for beginners?').catch(()=>{});
await page.waitForTimeout(500);
await page.click('[data-testid="chat-send-button"]').catch(()=>{});
// wait for answer to finish: poll AI message text length stable
let lastLen=0, stable=0;
for(let i=0;i<60;i++){ // up to ~120s
  await page.waitForTimeout(2000);
  const len = await page.evaluate(()=>{const m=[...document.querySelectorAll('[data-testid="chat-message"]')];const last=m[m.length-1];return last?(last.textContent||'').length:0;});
  if(len>250 && len===lastLen){ stable++; if(stable>=3) break; } else stable=0;
  lastLen=len;
}
console.log('answer len:', lastLen);
await page.waitForTimeout(1500);
// expand citations
const cit=await page.$('[data-testid="citations-toggle-button"]'); if(cit){await cit.click().catch(()=>{});await page.waitForTimeout(1200);}
// scroll up a little so the answer + citations are framed
await page.evaluate(()=>{const s=document.querySelector('[data-testid="chat-messages-scroll"]');if(s)s.scrollTop=Math.max(0,s.scrollHeight-1400);});
await page.waitForTimeout(600);
await blurAvatars();
await page.screenshot({path:OUT+'/1-cited-answers.png'});
console.log('qa done');

// S2 LIBRARY
await page.click('[data-testid="chat-header-knowledge-button"]').catch(()=>{});
await page.waitForTimeout(3500);
await page.evaluate(()=>{document.querySelectorAll('[role="dialog"] *').forEach(e=>{const t=(e.textContent||'').trim();if(t.length>10&&e.children.length===0&&!/drag|drop|support|file|status|sort|search|upload|process|library|connector|browse|ready|failed|all|compose|ocr|memory|time/i.test(t)){e.style.filter='blur(7px)';}});});
await page.waitForTimeout(300);
await page.screenshot({path:OUT+'/2-your-library.png'});
console.log('library done');
await browser.close(); console.log('DONE');
