import { chromium } from '@playwright/test';
const BASE='https://scrapalot.app', USER='admin', PASS='admin123';
const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport:{width:412,height:732}, deviceScaleFactor:2.5, isMobile:true, hasTouch:true,
  userAgent:'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36',
});
const page = await ctx.newPage();
await page.addInitScript(()=>{ try{localStorage.setItem('scrapalot_tour_completed','true');}catch{} });
await page.goto(BASE+'/login',{waitUntil:'domcontentloaded'});
await page.waitForSelector('button[type="submit"]',{state:'visible',timeout:20000});
await page.fill('[name="username"]',USER); await page.fill('[name="password"]',PASS);
await page.waitForTimeout(1000); await page.click('button[type="submit"]');
await page.waitForURL(/\/(dashboard|workspaces)/,{timeout:30000,waitUntil:'commit'}).catch(()=>{});
await page.waitForTimeout(6000);

// A: empty chat with neutral question typed (not sent)
await page.fill('[data-testid="chat-input"]','What are the key principles of stoic philosophy?').catch(()=>{});
await page.waitForTimeout(800);
await page.screenshot({path:'/tmp/shots/A-empty-typed.png'});

// B: open an existing conversation via sidebar
await page.click('[data-testid="sidebar-toggle-button"]').catch(()=>{});
await page.waitForTimeout(1200);
const firstSession = await page.$('[data-testid^="sidebar-session-item-"]');
if(firstSession){ await firstSession.click().catch(()=>{}); }
await page.waitForTimeout(4000);
// close sidebar if still open
await page.keyboard.press('Escape').catch(()=>{});
await page.waitForTimeout(1500);
await page.screenshot({path:'/tmp/shots/B-conversation.png'});

// dump message DOM structure (classes/testids of content)
const dom = await page.evaluate(()=>{
  const scroll=document.querySelector('[data-testid="chat-messages-scroll"]');
  if(!scroll) return 'no-scroll';
  const sample=[];
  scroll.querySelectorAll('[data-testid]').forEach(n=>{
    const t=(n.textContent||'').trim().slice(0,18);
    sample.push(n.getAttribute('data-testid')+' :: '+t);
  });
  return sample.slice(0,40).join('\n');
});
console.log('=== MESSAGE DOM ==='); console.log(dom);

// C: knowledge stacks
await page.click('[data-testid="chat-header-knowledge-button"]').catch(()=>{});
await page.waitForTimeout(3000);
await page.screenshot({path:'/tmp/shots/C-knowledge.png'});
await page.keyboard.press('Escape').catch(()=>{});
await page.waitForTimeout(1000);

await browser.close();
console.log('DONE');
