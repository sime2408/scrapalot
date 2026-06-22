import { chromium } from '@playwright/test';
const BASE='https://scrapalot.app', USER='admin', PASS='admin123';
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport:{width:412,height:732}, deviceScaleFactor:2, isMobile:true, hasTouch:true,
  userAgent:'Mozilla/5.0 (Linux; Android 14; Pixel 7) Mobile' });
const page = await ctx.newPage();
await page.addInitScript(()=>{ try{localStorage.setItem('scrapalot_tour_completed','true');}catch{} });
await page.goto(BASE+'/login',{waitUntil:'domcontentloaded'});
await page.waitForSelector('button[type="submit"]',{state:'visible',timeout:20000});
await page.fill('[name="username"]',USER); await page.fill('[name="password"]',PASS);
await page.waitForTimeout(800); await page.click('button[type="submit"]');
await page.waitForURL(/\/(dashboard|workspaces)/,{timeout:30000,waitUntil:'commit'}).catch(()=>{});
await page.waitForTimeout(7000);
const probe = await page.evaluate(()=>{
  const r={};
  r.htmlLang = document.documentElement.lang;
  r.i18nextLng_ls = localStorage.getItem('i18nextLng');
  r.windowKeys = Object.keys(window).filter(k=>/i18n|trans|lang/i.test(k));
  // try common globals
  r.has_i18next = !!(window.i18next||window.i18n);
  return r;
});
console.log(JSON.stringify(probe,null,1));
// try forcing via window.i18next if present
const forced = await page.evaluate(async ()=>{
  const inst = window.i18next || window.i18n;
  if(inst && inst.changeLanguage){ await inst.changeLanguage('en'); return 'forced-via-window'; }
  return 'no-window-instance';
});
console.log('FORCE:', forced);
await browser.close();
