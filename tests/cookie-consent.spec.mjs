import {test,expect} from '@playwright/test';
import {CONSENT_DEFAULTS} from '../shared/cookieConsent.js';
async function fixture(page,{active=true,revision='r1'}={}){
  const records=[],tracking=[];
  await page.route('**/api/**',async route=>{
    const request=route.request(),url=new URL(request.url());
    if(!url.pathname.startsWith('/api/'))return route.continue();
    if(url.pathname!=='/api/public/cookie-consent') return route.fulfill({status:503,json:{error:'Fixture blocks unrelated API'}});
    if(request.method()==='POST'){records.push(request.postDataJSON());return route.fulfill({status:204});}
    return route.fulfill({json:{host:url.hostname,tenantId:'00000000-0000-4000-8000-000000000001',revision,active,
      config:{...CONSENT_DEFAULTS,analyticsEnabled:true,privacyUrl:'/privacy'},ga4MeasurementId:'G-TEST12345'}});
  });
  await page.route(/https:\/\/(?:www\.googletagmanager\.com|.*google-analytics\.com|www\.youtube\.com)\/.*/,route=>{
    tracking.push(route.request().url());
    return route.fulfill({contentType:'application/javascript',body:'/* simulated Google script: no real measurements */'});
  });
  await page.goto('/__fixtures/cookie-consent');
  await expect(page.getByRole('button',{name:'Reject All',exact:true})).toBeVisible();
  return {records,tracking};
}
test('functional and marketing permissions do not grant analytics',async({page})=>{
  const {records,tracking}=await fixture(page);
  await page.getByRole('button',{name:'Customise',exact:true}).click();
  await page.getByRole('switch',{name:/Functional/i}).check();
  await page.getByRole('switch',{name:/Marketing/i}).check();
  await page.getByRole('button',{name:'Save My Preferences',exact:true}).click();
  await expect.poll(()=>records.length).toBe(1);
  expect(records[0].categories).toEqual({necessary:true,functional:true,analytics:false,marketing:true});
  await expect.poll(()=>tracking.some(x=>x.includes('youtube'))).toBe(true);
  expect(tracking.some(x=>x.includes('googletagmanager'))).toBe(false);
});
test('policy revision requires fresh consent and disabled rollout never loads GA',async({page})=>{
  const {tracking}=await fixture(page,{active:false});
  await page.getByRole('button',{name:'Accept All',exact:true}).click();
  await expect(page.getByRole('button',{name:'Consent Preferences'})).toBeVisible();
  expect(tracking.some(x=>x.includes('googletagmanager'))).toBe(false);
  await page.unroute('**/api/**');
  await fixture(page,{revision:'new-policy'});
  expect(tracking.some(x=>x.includes('googletagmanager'))).toBe(false);
});
test('reject persists with zero optional requests and essential form remains usable',async({page})=>{
  const {records,tracking}=await fixture(page);
  expect(tracking).toHaveLength(0);
  await page.getByRole('button',{name:'Reject All',exact:true}).click();
  await expect.poll(()=>records.length).toBe(1);
  await page.getByRole('button',{name:'Submit',exact:true}).click();
  await expect(page.locator('#result')).toHaveText('Submitted');
  await page.reload();
  await expect(page.getByRole('button',{name:'Consent Preferences'})).toBeVisible();
  await expect(page.getByRole('button',{name:'Accept All',exact:true})).toHaveCount(0);
  expect(tracking).toHaveLength(0);
});
test('accept loads GA once, explicit SPA pageviews are nonduplicated and withdrawal reloads denied',async({page})=>{
  const {records,tracking}=await fixture(page);
  await page.getByRole('button',{name:'Accept All',exact:true}).click();
  await expect.poll(()=>tracking.filter(x=>x.includes('googletagmanager')).length).toBe(1);
  await page.getByRole('button',{name:'Navigate',exact:true}).click();
  const views=await page.evaluate(()=>window.dataLayer.map(x=>Array.from(x)).filter(x=>x[0]==='event'&&x[1]==='page_view'));
  expect(views.length).toBe(2);
  await page.getByRole('button',{name:'Consent Preferences'}).click();
  await page.getByRole('button',{name:'Reject All',exact:true}).click();
  await expect.poll(()=>records.some(r=>r.action==='reject_all')).toBe(true);
  await expect(page.getByRole('button',{name:'Consent Preferences'})).toBeVisible();
  expect(tracking.filter(x=>x.includes('googletagmanager'))).toHaveLength(1);
});
test('isolated opaque-origin preview does not send audit or analytics',async({page})=>{
  const calls=[];
  page.on('request',req=>{if(/google|\/api\//.test(req.url()))calls.push(req.url());});
  await page.goto('/cookie-consent-preview.html');
  await page.evaluate(()=>{document.body.innerHTML='<iframe title="Preview" sandbox="allow-scripts" src="/cookie-consent-preview.html"></iframe>';});
  const frame=page.frameLocator('iframe');
  await expect(frame.getByRole('button',{name:'Accept All',exact:true})).toBeVisible();
  await frame.getByRole('button',{name:'Accept All',exact:true}).click();
  await expect(frame.getByRole('button',{name:'Consent Preferences'})).toBeVisible();
  expect(calls).toEqual([]);
});
